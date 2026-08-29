#!/usr/bin/env bash
set -euo pipefail

# This script is intentionally run by an administrator. It never logs in to
# ChatGPT and never reads or copies the worker authentication state.
# Deployment target: Oracle Always Free VM.Standard.E2.1.Micro (AMD x86_64,
# 1 GB RAM). Ampere A1 is Arm and cannot run the reviewed x86_64 Codex artifact.

readonly service_user="bellumetrics-worker"
readonly service_group="bellumetrics-worker"
readonly app_root="/opt/bellumetrics/app"
readonly state_root="/var/lib/bellumetrics"
readonly codex_home="${state_root}/codex"
readonly config_root="/etc/bellumetrics"
readonly environment_file="${config_root}/worker.env"
readonly unit_destination="/etc/systemd/system/bellumetrics-worker.service"
readonly expected_codex_version="0.149.1"
readonly oracle_shape="VM.Standard.E2.1.Micro"
readonly minimum_swap_kib=1048576

if [[ ${EUID} -ne 0 ]]; then
  echo "install.sh must run as root." >&2
  exit 77
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $1" >&2
    exit 69
  }
}

validate_release_inputs() {
  if [[ ! ${BELLUMETRICS_REPOSITORY} =~ ^https://github\.com/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*\.git$ ]]; then
    echo "BELLUMETRICS_REPOSITORY must be a canonical HTTPS github.com OWNER/REPOSITORY.git URL." >&2
    exit 64
  fi
  if [[ ! ${BELLUMETRICS_REF} =~ ^[0-9a-f]{40}$ ]]; then
    echo "BELLUMETRICS_REF must be an exact lowercase 40-hex commit SHA." >&2
    exit 64
  fi
}

install_platform_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install --yes --no-install-recommends bubblewrap ca-certificates git
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    dnf install --assumeyes bubblewrap ca-certificates git
    return
  fi
  echo "Install bubblewrap, ca-certificates, and git using the host package manager." >&2
  exit 69
}

require_node_22() {
  if [[ ! -x /usr/bin/node ]]; then
    echo "The systemd unit requires Node at /usr/bin/node." >&2
    exit 78
  fi
  local node_major
  node_major="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ ! ${node_major} =~ ^[0-9]+$ || ${node_major} -lt 22 ]]; then
    echo "Bellumetrics worker requires Node.js 22 or newer." >&2
    exit 78
  fi
}

verify_platform() {
  if [[ $(uname -s) != "Linux" || $(uname -m) != "x86_64" ]]; then
    echo "This release requires x86_64 Linux." >&2
    exit 78
  fi
  if ! /usr/bin/bwrap --help 2>&1 | grep -Fq -- "--bind-fd"; then
    echo "bubblewrap with --bind-fd support is required at /usr/bin/bwrap." >&2
    exit 78
  fi
}

require_safe_swap() {
  local swap_total_kib
  swap_total_kib="$(awk '/^SwapTotal:/ { print $2; exit }' /proc/meminfo)"
  if [[ ! ${swap_total_kib} =~ ^[0-9]+$ || ${swap_total_kib} -lt ${minimum_swap_kib} ]]; then
    echo "${oracle_shape} has 1 GB RAM; configure at least 1 GiB of active swap before installing." >&2
    exit 78
  fi
}

validate_config_root() {
  local directory="$1"
  local directory_owner directory_mode
  if [[ -L ${directory} || ! -d ${directory} ]]; then
    echo "worker_environment_parent is not a safe directory." >&2
    exit 73
  fi
  directory_owner="$(stat -c '%u' "${directory}")"
  directory_mode="$(stat -c '%a' "${directory}")"
  if [[ ${directory_owner} != 0 || ${directory_mode} != 755 ]]; then
    echo "worker_environment_parent must be a root-owned 0755 directory." >&2
    exit 73
  fi
}

validate_worker_environment_file() {
  local environment_owner environment_mode environment_links
  validate_config_root "${config_root}"
  if [[ -L ${environment_file} ]]; then
    echo "worker_environment_symlink is refused." >&2
    exit 73
  fi
  if [[ ! -f ${environment_file} ]]; then
    echo "worker_environment_not_regular is refused." >&2
    exit 73
  fi
  environment_owner="$(stat -c '%u' "${environment_file}")"
  environment_mode="$(stat -c '%a' "${environment_file}")"
  environment_links="$(stat -c '%h' "${environment_file}")"
  if [[ ${environment_owner} != 0 ]]; then
    echo "worker_environment_owner must be root." >&2
    exit 73
  fi
  if [[ ${environment_mode} != 600 ]]; then
    echo "worker_environment_mode must be 0600." >&2
    exit 73
  fi
  if [[ ${environment_links} != 1 ]]; then
    echo "worker_environment_links must be one." >&2
    exit 73
  fi
}

ensure_service_account() {
  if ! getent group "${service_group}" >/dev/null; then
    groupadd --system "${service_group}"
  fi
  if ! id -u "${service_user}" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "${service_group}" \
      --home-dir "${state_root}" \
      --shell /usr/sbin/nologin \
      --no-create-home \
      "${service_user}"
  fi
  install -d -o "${service_user}" -g "${service_group}" -m 0750 "${state_root}"
  install -d -o "${service_user}" -g "${service_group}" -m 0700 "${codex_home}"
}

checkout_release() {
  install -d -o root -g root -m 0755 /opt/bellumetrics
  if [[ -e ${app_root} && ! -d ${app_root}/.git ]]; then
    echo "${app_root} exists but is not a release checkout; refusing to replace it." >&2
    exit 73
  fi
  if [[ ! -d ${app_root}/.git ]]; then
    git clone --no-checkout -- "${BELLUMETRICS_REPOSITORY}" "${app_root}"
  fi
  if [[ $(git -C "${app_root}" remote get-url origin) != "${BELLUMETRICS_REPOSITORY}" ]]; then
    echo "Existing checkout origin does not match BELLUMETRICS_REPOSITORY." >&2
    exit 73
  fi
  git -C "${app_root}" fetch --depth 1 origin "${BELLUMETRICS_REF}"
  git -C "${app_root}" checkout --detach --force "${BELLUMETRICS_REF}"
  local checked_out_ref
  checked_out_ref="$(git -C "${app_root}" rev-parse --verify HEAD)"
  if [[ ${checked_out_ref} != "${BELLUMETRICS_REF}" ]]; then
    echo "checked-out release does not match BELLUMETRICS_REF." >&2
    exit 73
  fi
  chown -R root:root "${app_root}"
  chmod -R go-w "${app_root}"
}

verify_pinned_codex() {
  node --input-type=module - "${app_root}/package-lock.json" "${expected_codex_version}" <<'NODE'
import { readFile } from "node:fs/promises";

const [lockfilePath, expectedVersion] = process.argv.slice(2);
const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
const rootDependency = lockfile.packages?.[""]?.dependencies?.["@openai/codex-sdk"];
const sdk = lockfile.packages?.["node_modules/@openai/codex-sdk"];
const native = lockfile.packages?.["node_modules/@openai/codex-linux-x64"];
if (
  rootDependency !== expectedVersion
  || sdk?.version !== expectedVersion
  || native?.version !== `${expectedVersion}-linux-x64`
  || !native.os?.includes("linux")
  || !native.cpu?.includes("x64")
) {
  throw new Error(`package-lock.json must pin @openai/codex-sdk and Linux x64 Codex ${expectedVersion}`);
}
NODE
}

write_environment_file() {
  if [[ -e ${config_root} || -L ${config_root} ]]; then
    validate_config_root "${config_root}"
  else
    install -d -o root -g root -m 0755 "${config_root}"
    validate_config_root "${config_root}"
  fi
  if [[ ! -e ${environment_file} && ! -L ${environment_file} ]]; then
    install -o root -g root -m 0600 "${app_root}/deploy/oracle/env.example" "${environment_file}"
  fi
  validate_worker_environment_file
}

if [[ ${1:-} == "--validate-config-root" ]]; then
  if [[ $# -ne 2 ]]; then
    echo "usage: install.sh --validate-config-root DIRECTORY" >&2
    exit 64
  fi
  validate_config_root "$2"
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "usage: install.sh" >&2
  exit 64
fi

: "${BELLUMETRICS_REPOSITORY:?Set BELLUMETRICS_REPOSITORY to the HTTPS Git repository URL.}"
: "${BELLUMETRICS_REF:?Set BELLUMETRICS_REF to an exact 40-hex commit SHA.}"

validate_release_inputs
install_platform_packages
require_command git
require_command getent
require_command stat
require_command awk
require_node_22
verify_platform
require_safe_swap
ensure_service_account
checkout_release
verify_pinned_codex
(cd "${app_root}" && npm ci --omit=dev --ignore-scripts)

native_codex="${app_root}/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
if [[ ! -x ${native_codex} ]]; then
  echo "The exact Linux x64 Codex 0.149.1 package was not installed." >&2
  exit 78
fi

write_environment_file
install -o root -g root -m 0644 "${app_root}/deploy/oracle/bellumetrics-worker.service" "${unit_destination}"
systemctl daemon-reload
systemctl enable bellumetrics-worker.service
echo "Bellumetrics worker installed. Fill ${environment_file}, authenticate separately as ${service_user}, then start the service."
