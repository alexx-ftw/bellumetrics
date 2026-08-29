# Task 10 report: Oracle worker packaging

## Fix R1

- The deployment target is Oracle Always Free `VM.Standard.E2.1.Micro` (AMD
  x86_64, 1 GB RAM), not Ampere A1/Arm. This matches the reviewed pinned
  x86_64 Codex 0.149.1 artifact.
- The installer now requires at least 1 GiB of active swap. The runbook gives
  a guarded 2 GiB swap-file procedure for the 1 GB instance.
- `BELLUMETRICS_REPOSITORY` accepts only a canonical HTTPS GitHub repository
  URL and `BELLUMETRICS_REF` only a lowercase 40-hex commit SHA. It fetches,
  checks out detached, and verifies `HEAD` before dependencies are installed.
- Existing `/etc/bellumetrics/worker.env` files are never repaired in place:
  installer and health check reject symlinks, non-regular files, unsafe parent
  directories, non-root ownership, non-0600 modes, and hard links before use.
- The health check supplies Supabase headers through `curl --config -`; the
  service key is not present in a curl argument vector and no secret temp file
  is created.

Oracle documents the E2.1.Micro Always Free shape as AMD with 1 GB RAM, while
Ampere A1 is Arm: [Always Free compute resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Verification

- `node --test tests/oracle-deploy.test.mjs` — 7 passing.
- `bash -n deploy/oracle/install.sh deploy/oracle/healthcheck.sh` — passing.
- `npm run test:curation` — 119 passing.
- `npm run lint` — 0 errors; one pre-existing unused-variable warning in
`tests/war-atlas-import.test.mjs`.
- `npm test` — build and 6 rendered-page tests passing.
- `git diff --check` — clean.

No Oracle, sudo, cloud, or ChatGPT login operation was executed.

## Fix R2

- `install.sh` now validates an existing `/etc/bellumetrics` before calling
  `install -d`. A symlink, non-directory, non-root owner, or any mode other
  than `0755` is rejected without a corrective `chmod` or `chown`.
- Only an absent configuration directory is created as `root:root` mode `0755`,
  and that newly created directory is validated before `worker.env` is created.
- The deployment contract executes the installer validation against an existing
  `0777` directory and verifies both rejection and mode preservation.
