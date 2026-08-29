#!/bin/bash
set -euo pipefail

bwrap_executable=${CODEX_BWRAP_EXECUTABLE:-/usr/bin/bwrap}
: "${CODEX_REAL_EXECUTABLE:?CODEX_REAL_EXECUTABLE is required}"
: "${CODEX_RESEARCH_DIRECTORY:?CODEX_RESEARCH_DIRECTORY is required}"
: "${CODEX_CREDENTIAL_DIRECTORY:?CODEX_CREDENTIAL_DIRECTORY is required}"

if [[ $(uname -s) != Linux ]]; then
  echo "Codex curation isolation requires Linux" >&2
  exit 78
fi
if [[ ! -x $bwrap_executable ]]; then
  echo "bubblewrap isolation unavailable: $bwrap_executable" >&2
  exit 78
fi
if [[ ! -x $CODEX_REAL_EXECUTABLE ]]; then
  echo "Codex executable unavailable: $CODEX_REAL_EXECUTABLE" >&2
  exit 78
fi
if [[ ! -d $CODEX_RESEARCH_DIRECTORY ]]; then
  echo "Codex research directory unavailable: $CODEX_RESEARCH_DIRECTORY" >&2
  exit 78
fi
reject_credential_state() {
  echo "credential auth-state allowlist rejected CODEX_CREDENTIAL_DIRECTORY" >&2
  exit 78
}
if [[ -L $CODEX_CREDENTIAL_DIRECTORY ]]; then
  reject_credential_state
fi
if [[ ! -d $CODEX_CREDENTIAL_DIRECTORY ]]; then
  echo "Codex credential directory unavailable: $CODEX_CREDENTIAL_DIRECTORY" >&2
  exit 78
fi

if ! exec {credential_directory_fd}< "$CODEX_CREDENTIAL_DIRECTORY"; then
  reject_credential_state
fi
credential_directory_fd_path=/proc/self/fd/$credential_directory_fd
if [[ ! -d $credential_directory_fd_path || -L $CODEX_CREDENTIAL_DIRECTORY ]]; then
  reject_credential_state
fi
credential_path_identity=$(
  stat -Lc '%d:%i' -- "$CODEX_CREDENTIAL_DIRECTORY"
) || reject_credential_state
credential_fd_identity=$(
  stat -Lc '%d:%i' -- "$credential_directory_fd_path"
) || reject_credential_state
if [[ $credential_path_identity != "$credential_fd_identity" ]]; then
  reject_credential_state
fi
credential_directory_uid=$(stat -Lc '%u' -- "$credential_directory_fd_path") \
  || reject_credential_state
credential_directory_mode=$(stat -Lc '%a' -- "$credential_directory_fd_path") \
  || reject_credential_state
if [[ $credential_directory_uid != "$EUID" \
  || ! $credential_directory_mode =~ ^[0-7]{3,4}$ \
  || $((8#$credential_directory_mode & 022)) -ne 0 ]]; then
  reject_credential_state
fi

shopt -s dotglob nullglob
credential_entries=("$credential_directory_fd_path"/*)
shopt -u dotglob nullglob
if (( ${#credential_entries[@]} != 1 )); then
  reject_credential_state
fi
auth_file=$credential_directory_fd_path/auth.json
if [[ ${credential_entries[0]} != "$auth_file" \
  || ! -f $auth_file \
  || -L $auth_file \
  || ! -O $auth_file \
  || ! -r $auth_file \
  || ! -w $auth_file ]]; then
  reject_credential_state
fi
auth_mode=$(stat -c '%a' -- "$auth_file")
auth_links=$(stat -c '%h' -- "$auth_file")
if [[ ! $auth_mode =~ ^[0-7]{3,4}$ \
  || $((8#$auth_mode & 077)) -ne 0 \
  || $auth_links -ne 1 ]]; then
  reject_credential_state
fi

codex_arguments=("$@")
schema_mounts=()
for ((index = 0; index < ${#codex_arguments[@]}; index += 1)); do
  if [[ ${codex_arguments[$index]} == --output-schema ]]; then
    index=$((index + 1))
    schema_path=${codex_arguments[$index]:-}
    if [[ ! -f $schema_path || $schema_path != /tmp/codex-output-schema-*/schema.json ]]; then
      echo "refusing unexpected Codex output schema path: $schema_path" >&2
      exit 78
    fi
    schema_mounts+=(--dir "$(dirname "$schema_path")")
    schema_mounts+=(--ro-bind "$schema_path" "$schema_path")
  fi
done

public_runtime_mounts=()
for certificate_path in \
  /etc/ssl/certs/ca-certificates.crt \
  /etc/resolv.conf \
  /etc/hosts \
  /etc/nsswitch.conf; do
  if [[ -e $certificate_path ]]; then
    public_runtime_mounts+=(--ro-bind "$certificate_path" "$certificate_path")
  fi
done
if [[ ! -f /etc/ssl/certs/ca-certificates.crt ]]; then
  echo "public CA bundle unavailable" >&2
  exit 78
fi

environment_arguments=(
  --setenv PATH /nonexistent
  --setenv HOME /home/codex
  --setenv USER codex
  --setenv LOGNAME codex
  --setenv SHELL /nonexistent
  --setenv LANG C.UTF-8
  --setenv LC_ALL C.UTF-8
  --setenv TZ UTC
  --setenv SSL_CERT_FILE /etc/ssl/certs/ca-certificates.crt
  --setenv CODEX_HOME /codex-home
)
for proxy_name in \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY \
  http_proxy https_proxy all_proxy no_proxy; do
  if [[ -n ${!proxy_name:-} ]]; then
    environment_arguments+=(--setenv "$proxy_name" "${!proxy_name}")
  fi
done

exec "$bwrap_executable" \
  --die-with-parent \
  --new-session \
  --unshare-all \
  --share-net \
  --clearenv \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs /home \
  --dir /home/codex \
  --dir /etc \
  --dir /etc/ssl \
  --dir /etc/ssl/certs \
  --dir /opt \
  --dir /opt/codex \
  "${public_runtime_mounts[@]}" \
  --ro-bind "$CODEX_REAL_EXECUTABLE" /opt/codex/codex \
  --ro-bind "$CODEX_RESEARCH_DIRECTORY" "$CODEX_RESEARCH_DIRECTORY" \
  "${schema_mounts[@]}" \
  --bind-fd "$credential_directory_fd" /codex-home \
  "${environment_arguments[@]}" \
  --chdir "$CODEX_RESEARCH_DIRECTORY" \
  /opt/codex/codex \
  "${codex_arguments[@]}"
