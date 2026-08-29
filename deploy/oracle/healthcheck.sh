#!/usr/bin/env bash
set -euo pipefail

readonly service_name="bellumetrics-worker.service"
readonly environment_file="${BELLUMETRICS_WORKER_ENV_FILE:-/etc/bellumetrics/worker.env}"

fail() {
  echo "health=fail reason=$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_$1"
}

if [[ ${EUID} -ne 0 ]]; then
  fail "run_as_root_to_read_worker_environment"
fi
for command_name in systemctl curl node date stat dirname; do
  require_command "${command_name}"
done

environment_parent="$(dirname "${environment_file}")"
if [[ -L ${environment_parent} || ! -d ${environment_parent} ]]; then
  fail "worker_environment_parent"
fi
if [[ $(stat -c '%u' "${environment_parent}") != 0 ]]; then
  fail "worker_environment_parent"
fi
environment_parent_mode="$(stat -c '%a' "${environment_parent}")"
if [[ ! ${environment_parent_mode} =~ ^[0-7]{3,4}$ || $((8#${environment_parent_mode} & 022)) -ne 0 ]]; then
  fail "worker_environment_parent"
fi
if [[ -L ${environment_file} ]]; then
  fail "worker_environment_symlink"
fi
if [[ ! -f ${environment_file} ]]; then
  fail "worker_environment_not_regular"
fi
if [[ $(stat -c '%u' "${environment_file}") != 0 ]]; then
  fail "worker_environment_owner"
fi
if [[ $(stat -c '%a' "${environment_file}") != "600" ]]; then
  fail "worker_environment_mode"
fi
if [[ $(stat -c '%h' "${environment_file}") != "1" ]]; then
  fail "worker_environment_links"
fi

set -a
# shellcheck disable=SC1090
. "${environment_file}"
set +a

: "${SUPABASE_URL:?SUPABASE_URL is required in worker.env}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required in worker.env}"
if [[ ! ${SUPABASE_URL} =~ ^https://[A-Za-z0-9.-]+$ ]]; then
  fail "supabase_url_must_be_a_plain_https_origin"
fi
if [[ ! ${SUPABASE_SERVICE_ROLE_KEY} =~ ^[A-Za-z0-9._~-]+$ ]]; then
  fail "service_role_key_has_unsafe_characters"
fi

if systemctl is-active --quiet bellumetrics-worker; then
  echo "process=active"
else
  echo "process=inactive"
  exit 1
fi

curl_json() {
  {
    printf '%s\n' \
      "fail" \
      "silent" \
      "show-error" \
      "max-time = 20" \
      "header = \"apikey: ${SUPABASE_SERVICE_ROLE_KEY}\"" \
      "header = \"Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}\"" \
      "header = \"Accept: application/json\"" \
      "url = \"$1\""
  } | curl --config -
}

count_json() {
  node --input-type=module -e '
    let value;
    try { value = JSON.parse(await new Response(process.stdin).text()); } catch { process.exit(65); }
    if (!Array.isArray(value)) process.exit(65);
    process.stdout.write(String(value.length));
  '
}

latest_json() {
  local label="$1"
  node --input-type=module -e '
    const [label, ...fields] = process.argv.slice(1);
    let value;
    try { value = JSON.parse(await new Response(process.stdin).text()); } catch { process.exit(65); }
    if (!Array.isArray(value) || value.length === 0) { console.log(`${label}=none`); process.exit(0); }
    const row = value[0];
    const output = fields.map((field) => `${field}:${String(row[field] ?? "")}`).join(" ");
    console.log(`${label}=${output}`);
  ' "${label}" "${@:2}"
}

last_success="$(curl_json "${SUPABASE_URL}/rest/v1/curation_cases?status=eq.published&select=id,updated_at&order=updated_at.desc&limit=1")"
printf '%s' "${last_success}" | latest_json "last_successful_case" id updated_at

exceptions="$(curl_json "${SUPABASE_URL}/rest/v1/curation_cases?status=in.(awaiting_human,failed)&select=id&limit=10000")"
printf 'pending_exceptions=%s\n' "$(printf '%s' "${exceptions}" | count_json)"

last_snapshot="$(curl_json "${SUPABASE_URL}/rest/v1/ranking_snapshots?select=id,data_revision,algorithm_version,created_at&order=created_at.desc&limit=1")"
printf '%s' "${last_snapshot}" | latest_json "last_ranking_snapshot" id data_revision algorithm_version created_at

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stale_curation="$(curl_json "${SUPABASE_URL}/rest/v1/curation_cases?status=eq.leased&lease_expires_at=lt.${now}&select=id&limit=10000")"
stale_ranking="$(curl_json "${SUPABASE_URL}/rest/v1/ranking_jobs?status=eq.leased&lease_expires_at=lt.${now}&select=id&limit=10000")"
stale_curation_count="$(printf '%s' "${stale_curation}" | count_json)"
stale_ranking_count="$(printf '%s' "${stale_ranking}" | count_json)"
printf 'stale_curation_leases=%s\n' "${stale_curation_count}"
printf 'stale_ranking_leases=%s\n' "${stale_ranking_count}"
printf 'health=ok\n'
