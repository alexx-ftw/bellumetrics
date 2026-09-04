# Autonomous AI curation acceptance

Execution date: 2026-08-29 UTC

Implementation commit: `9bd7762f241b5a80effeaa1e1b48acf52ec56187`

Branch: `agent/ai-curation-implementation`

Base: `origin/main` at `f15d4b54b295dea135ee45113557ffa77c19b7ad`

Status refreshed: 2026-09-04 UTC

Overall result: **BLOCKED — database and web deployment are available, but the one-case scheduled-task acceptance is incomplete**

This record deliberately contains no credentials, session values, magic-link
codes, user UUIDs, environment-file contents, or worker payloads.

## Environment preflight

| Check | Result | Evidence |
| --- | --- | --- |
| Canonical GitHub repository | PASS | The authenticated GitHub API resolves the pre-rename remote to `alexx-ftw/bellumetrics`; repository id `1333728543`. |
| GitHub Pages kept active | PASS | `https://alexx-ftw.github.io/bellumetrics/` returned HTTP 200 and title `Bellumetrics` on 2026-08-29 UTC. No workflow or Pages configuration was removed. |
| Supabase project | PASS | Project `dggbwsgoddbrxvojjojy` progressed from `RESTORING` to `ACTIVE_HEALTHY` in `eu-west-2`. |
| Supabase CLI | BLOCKED | Pinned CLI `supabase@2.101.0` still reports that no access token is provided. Migration application and listing therefore used the authenticated Supabase connector. |
| Vercel | PASS | The preview is deployed at `https://bellumetrics-curation-preview.vercel.app`; deployment was performed through the authorized GitHub/Vercel path rather than the logged-out local CLI. |
| Native Codex scheduled task | PENDING | The checked manifest and durable prompt replace Oracle. Official operating policy requires one reliable manual run before the hourly schedule is created. |
| Oracle worker host | NOT USED | Oracle/systemd remains a checked legacy fallback only and is no longer an acceptance dependency. |

## Migration evidence

Local and remote migration versions now match exactly:

1. `202608150001_wiki_data_foundation.sql`
2. `20260829182707_ai_curation.sql`
3. `20260829182958_publication_and_ranking.sql`
4. `20260829183014_owner_curation_actions.sql`
5. `20260829183033_owner_canonical_publication.sql`
6. `20260829183417_restrict_worker_rpc_execution.sql`

The connector generated deployment-time versions for migrations 2–6. Before
renaming any local file, the corresponding remote row was mapped by migration
name and verified to have exactly one stored statement with the same byte count
and MD5 as the complete local SQL file. No remote migration row was deleted or
rewritten. A subsequent connector listing returned the same six versions as the
local directory, preventing a future `db push` from reapplying deployed SQL.

The security advisor initially exposed a verified defect: permissive Supabase
function defaults left five worker RPCs and `public.rls_auto_enable()` callable
by `anon` and/or `authenticated`. A regression test failed against that state.
Migration `20260829183417` now revokes direct privileges from `public`, `anon`,
`authenticated`, and `service_role`, then grants the six worker RPCs only to
`service_role`. Production ACL queries confirm the intended effective grants,
and the regression test passes.

Post-migration advisor results:

- Security: 0 errors, 2 warnings, 2 informational notices. The two warnings are
  the intentional authenticated owner RPCs (`owner_curation_action` and
  `revert_editorial_event`), which enforce owner membership inside the function.
  The informational notices are the intentionally non-public staging tables
  with RLS enabled and no client policies.
- Performance: 0 errors, 6 warnings, 27 informational notices. The warnings are
  `auth_rls_initplan` recommendations for the six owner-read policies; they are
  not acceptance failures and were not changed without a measured production
  performance defect. Unused-index notices are expected on the newly restored,
  lightly queried database.

Read-only production verification also observed:

- all 22 public tables have RLS enabled;
- a public `commanders` Data API request returned HTTP 200;
- anonymous requests to `curation_cases` and `curator_memberships` returned
  HTTP 401 / Postgres `42501` permission denied;
- `auth.users` count is 1 and `curator_memberships` count is 1 in the 2026-09-04 production refresh;
- one import run and 10,656 import records exist, while curation case count is 0.

The local PGlite schema suite passes 10/10, including explicit GRANTs, RLS,
sequence privileges, owner-only reads, public isolation, staging isolation, and
the new service-role-only RPC regression. `supabase test db` remains unavailable
because the CLI lacks a linked authenticated session and no local Supabase
database/Docker socket is available.

## Acceptance scenario

| Criterion | Result | Production evidence |
| --- | --- | --- |
| Import a staged battle twice and retain one pending case | BLOCKED | Existing import data is present, but there are 0 curation cases. Re-enqueueing requires the service-role importer or authenticated workflow on code containing the curation migrations. |
| Store two independent fresh Codex reviews | BLOCKED | Requires the first manual `scheduled-task-v1` run. Local worker tests verify two fresh isolated threads and persistence-before-consensus. |
| Compatible agreement publishes canonical rows once | BLOCKED | Requires a live worker and staged curation case. Local transactional publication/idempotency tests pass. |
| One ranking job creates one `elo-v1` snapshot | BLOCKED | Requires live worker execution. Local atomic completion and unique-snapshot tests pass. |
| Disagreement appears as `awaiting_human` in the panel | BLOCKED | Owner Auth, membership, and Vercel are present; a manual scheduled-task disagreement fixture still needs to be executed. |
| Interrupted run during a lease recovers without duplication | BLOCKED | Requires interrupting the manual acceptance run and reclaiming it with the next run. Local expired-lease reclaim and stored-review resume tests pass. |
| Publish a merge, revert it, and restore all relationships and sources | BLOCKED | Requires owner authentication and production scenario data. Local transactional merge/reversal tests pass. |
| Credential search across repository, logs, browser bundle, and artifacts | PARTIAL | Local boundary-aware scans and the GitHub Actions account-auth prohibition pass. The first Scheduled run report remains to be inspected. |

## Authentication and deployment checks

| Check | Result | Notes |
| --- | --- | --- |
| Owner signs in and is added to `curator_memberships` | PASS | Production refresh reports one Auth user and one owner membership. No UUID or session value is recorded here. |
| A second authenticated account cannot read curation data | BLOCKED | Only the owner account exists. Anonymous denial is verified; the local second-user RLS test passes. |
| Public Vercel routes | PASS | Preview deployment URL is available; final route capture remains part of the end-to-end evidence. |
| Login and callback | PASS | The owner completed the deployed magic-link callback before the 2026-09-04 refresh. No link token or session is retained. |
| Owner-only `/curation` and server rendering | PARTIAL | Owner login is available and local build/tests cover dynamic auth routes; a second live account denial still needs verification. |
| Mobile layout | BLOCKED | Local UI tests cover mobile-safe markup; no live Vercel viewport is available. |
| Native task uses only connected tools and versioned RPCs | BLOCKED | Manifest and prompt are checked locally; the required manual run has not yet been recorded. |

## Verification commands

| Command or check | Result |
| --- | --- |
| `npm run test:db` after ACL fix and migration reconciliation | PASS — 10 passed, 0 failed. |
| Supabase migration listing | PASS — local and remote version sets are identical. |
| Production ACL query | PASS — six worker RPCs deny `anon`/`authenticated` and allow `service_role`; `rls_auto_enable()` denies all three. |
| Production Data API public/private checks | PASS — public table 200; curation tables 401/42501 for anonymous access. |
| Supabase security advisor after fix | PASS with intentional notices — 0 errors, 2 intentional owner-RPC warnings. |
| Supabase performance advisor | PASS with recommendations — 0 errors, 6 RLS init-plan warnings. |
| `npx --yes supabase@2.101.0 test db` | BLOCKED — no authenticated CLI and no local database/Docker socket. |
| `npm run lint` | PASS (exit 0); one preexisting unused-variable warning in `tests/war-atlas-import.test.mjs:270`. |
| `npm run test:db` | PASS — 10 passed, 0 failed. |
| `npm run test:curation` | PASS — 119 passed, 0 failed. |
| `node --test tests/curation-scheduled-task.test.mjs` | PASS: 3 passed, 0 failed; hourly manifest, fail-closed prompt, and GitHub account-auth boundary verified. |
| `npm test` | PASS — server-capable build completed and 6 rendered HTML tests passed. |
| `git diff --check` | PASS — no whitespace errors. |
| Boundary-aware tracked/artifact credential scan | PASS — no GitHub, OpenAI, Supabase secret-key, or JWT token patterns found. |

## Required continuation

1. Use a distinct authenticated test account for the production RLS denial
   check; do not alter the existing owner membership.
2. Capture final Vercel route, server-rendering, authorization, and mobile
   checks while keeping GitHub Pages healthy.
3. Run `scheduled-task-v1` manually with the connected GitHub and Supabase
   tools. After that run is reliable, create the hourly task from
   `deploy/codex/scheduled-task.json` and inspect its first runs.
4. Use the authenticated importer/connector path to enqueue
   one staged battle after the curation schema deployment, then execute the full
   production scenario.
5. Provide either an authenticated linked Supabase CLI or a running local stack
   to run the required pgTAP command.

No Oracle host is required or planned. As of this refresh, no native scheduled
task, production curation mutation, commit, push, or pull request was performed.
Opening a PR with the production scenario unexecuted would misrepresent
acceptance.
