# Autonomous AI Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an auditable Bellumetrics pipeline where two independent Codex agents curate staged historical records, compatible decisions publish automatically, disagreements reach the owner, and every accepted battle produces a reproducible Elo snapshot.

**Architecture:** Supabase is the source of truth for staging, canonical data, leases, reviews, audit events, and ranking snapshots. A Node.js worker on Oracle Cloud leases one case at a time and invokes local Codex SDK sessions authenticated through ChatGPT Pro. Next.js on Vercel provides public pages and a private Supabase magic-link curation panel. Database RPCs enforce atomic state transitions so restarts cannot duplicate publication.

**Tech Stack:** Node.js 22 ESM, Next.js 16, React 19, Supabase Postgres/Auth/PostgREST, pgTAP, PGlite, OpenAI Codex SDK, systemd, Vercel, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-16-ai-curation-design.md`

## Global Constraints

- Keep GitHub Pages live until the Vercel deployment passes the acceptance checks.
- Never place `~/.codex/auth.json`, ChatGPT tokens, Supabase service credentials, or magic-link sessions in Git, logs, browser bundles, GitHub Actions artifacts, or database rows.
- Use two fresh Codex threads. The reviewer receives the case evidence but not the proposer's conclusion or reasoning.
- Do not encode editorial confidence thresholds. Only schema validation, authorization, idempotency, lease timing, retry limits, and ranking algorithm constants are deterministic.
- Agents return proposed canonical mutations, never Elo values.
- Every automatic mutation must be transactional, audited, versioned, and reversible.
- Worker tests use fakes or checked-in recordings and consume no Codex quota.
- Run each focused test before its implementation, then run `npm test` before each task commit.

---

## File and Responsibility Map

- `supabase/migrations/202608240001_ai_curation.sql`: editorial tables, RLS, grants, queue RPCs.
- `supabase/migrations/202608240002_publication_and_ranking.sql`: atomic publication, reversal, ranking job/snapshot RPCs.
- `supabase/tests/ai_curation_test.sql`: live database contract for RLS, leases, publication, reversal.
- `lib/curation/contracts.mjs`: strict parsing of agent decisions and canonical mutations.
- `lib/curation/consensus.mjs`: compatibility comparison without editorial scoring.
- `lib/curation/queue-repository.mjs`: PostgREST/RPC adapter used by importer and worker.
- `worker/curation/codex-runner.mjs`: Codex SDK adapter.
- `worker/curation/orchestrator.mjs`: proposer, reviewer, consensus, execution, retry lifecycle.
- `worker/curation/prompts/*.md`: versioned proposer and reviewer instructions.
- `lib/ranking/elo.mjs`: pure deterministic Elo calculation.
- `worker/ranking/orchestrator.mjs`: ranking job lease, calculation, snapshot publication.
- `lib/supabase/{browser,server}.ts`: scoped Supabase clients for Next.js.
- `app/auth/*`, `middleware.ts`: magic-link login and owner authorization.
- `app/curation/*`: private exception queue, review detail, history, and actions.
- `deploy/oracle/*`: repeatable worker installation and systemd units.
- `docs/operations/ai-curation.md`: setup, login, rotation, recovery, and rollback runbook.

### Task 1: Add the curation schema and authorization boundary

**Files:**
- Create: `supabase/migrations/202608240001_ai_curation.sql`
- Create: `supabase/tests/ai_curation_test.sql`
- Modify: `tests/supabase-schema.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing PGlite schema tests**

Assert these tables and required columns:

```text
curator_memberships(user_id uuid PK, role text, created_at timestamptz)
curation_cases(id bigint PK, case_key text UNIQUE, entity_type text, source_revision text,
  payload jsonb, status text, priority integer, lease_owner text, lease_expires_at timestamptz,
  attempt_count integer, last_error text, created_at timestamptz, updated_at timestamptz)
ai_reviews(id bigint PK, case_id bigint FK, review_role text, model text,
  prompt_version text, evidence jsonb, decision jsonb, created_at timestamptz)
editorial_events(id bigint PK, case_id bigint FK, actor_type text, actor_id text,
  action text, before_state jsonb, after_state jsonb, reason text, created_at timestamptz)
ranking_jobs(id bigint PK, data_revision text, algorithm_version text, status text,
  lease_owner text, lease_expires_at timestamptz, attempt_count integer, last_error text,
  created_at timestamptz, completed_at timestamptz)
ranking_snapshots(id bigint PK, data_revision text, algorithm_version text,
  results jsonb, created_at timestamptz, UNIQUE(data_revision, algorithm_version))
```

Also assert RLS on every new table, no `anon` access, curator-only reads through membership, and no direct browser writes.

Run: `node --test tests/supabase-schema.test.mjs`

Expected: FAIL because the tables do not exist.

- [ ] **Step 2: Create the migration**

Use check constraints for finite states:

```sql
status in ('pending','leased','awaiting_human','approved','rejected','published','failed')
review_role in ('proposer','reviewer')
ranking job status in ('pending','leased','completed','failed')
```

Enable RLS, revoke default privileges from `anon` and `authenticated`, grant the worker role access only through security-definer RPCs, and add the curator read policy:

```sql
using (exists (
  select 1 from public.curator_memberships m
  where m.user_id = auth.uid() and m.role = 'owner'
))
```

- [ ] **Step 3: Add pgTAP coverage**

Test owner visibility, non-owner isolation, unique `case_key`, valid states, and immutable `ai_reviews`/`editorial_events` for browser roles.

Run: `supabase test db supabase/tests/ai_curation_test.sql`

Expected: all assertions pass against the linked local stack.

- [ ] **Step 4: Add focused database test scripts**

Add:

```json
"test:db": "node --test tests/supabase-schema.test.mjs",
"test:curation": "node --test tests/curation-*.test.mjs tests/worker-*.test.mjs"
```

Run: `npm run test:db`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202608240001_ai_curation.sql supabase/tests/ai_curation_test.sql tests/supabase-schema.test.mjs package.json
git commit -m "feat: add autonomous curation schema"
```

### Task 2: Make imports create idempotent curation cases

**Files:**
- Modify: `scripts/import-war-atlas.mjs`
- Modify: `lib/import/war-atlas.mjs`
- Modify: `tests/war-atlas-import.test.mjs`
- Modify: `supabase/migrations/202608240001_ai_curation.sql`

- [ ] **Step 1: Write failing import tests**

For each staged battle, require one case key:

```js
const caseKey = `the-war-atlas:battle:${sourceId}:${sourceRevision}`;
```

Test that importing the same revision twice creates no duplicate and importing a changed revision creates exactly one new case.

Run: `node --test tests/war-atlas-import.test.mjs`

Expected: FAIL because the importer does not enqueue cases.

- [ ] **Step 2: Add an idempotent enqueue RPC**

Create `enqueue_curation_case(p_case_key, p_entity_type, p_source_revision, p_payload)` with `insert ... on conflict (case_key) do update`. Preserve terminal cases and only refresh payload for non-terminal cases.

- [ ] **Step 3: Call the RPC after staging each battle batch**

Expose a repository method:

```js
enqueueCase({ caseKey, entityType, sourceRevision, payload })
```

The importer must mark its run failed if staging succeeds but enqueueing fails, so a retry is safe and visible.

- [ ] **Step 4: Verify**

Run:
```bash
node --test tests/war-atlas-import.test.mjs
npm run test:db
```

- [ ] **Step 5: Commit**

```bash
git add scripts/import-war-atlas.mjs lib/import/war-atlas.mjs tests/war-atlas-import.test.mjs supabase/migrations/202608240001_ai_curation.sql
git commit -m "feat: enqueue imported battles for curation"
```

### Task 3: Implement leases and durable case transitions

**Files:**
- Modify: `supabase/migrations/202608240001_ai_curation.sql`
- Modify: `supabase/tests/ai_curation_test.sql`
- Create: `lib/curation/queue-repository.mjs`
- Create: `tests/curation-queue.test.mjs`

- [ ] **Step 1: Write failing lease tests**

Cover: oldest high-priority pending case is leased atomically, a second worker cannot lease it, heartbeat extends only its own lease, expired lease is reclaimable, and repeated completion is idempotent.

- [ ] **Step 2: Add queue RPCs**

Implement:

```text
lease_curation_case(worker_id text, lease_seconds integer) returns curation_cases
heartbeat_curation_case(case_id bigint, worker_id text, lease_seconds integer) returns boolean
release_curation_case(case_id bigint, worker_id text, outcome text, error_text text) returns boolean
record_ai_review(case_id bigint, worker_id text, review_role text, model text,
  prompt_version text, evidence jsonb, decision jsonb) returns bigint
```

Use `for update skip locked`, server timestamps, ownership checks, and an attempt limit of 3. The third technical failure changes the case to `awaiting_human`.

- [ ] **Step 3: Implement the PostgREST adapter**

`createQueueRepository({ supabaseUrl, serviceRoleKey, fetchImpl })` must return `lease`, `heartbeat`, `recordReview`, and `release`. Redact authorization headers from thrown errors.

- [ ] **Step 4: Verify**

Run:
```bash
node --test tests/curation-queue.test.mjs
supabase test db supabase/tests/ai_curation_test.sql
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202608240001_ai_curation.sql supabase/tests/ai_curation_test.sql lib/curation/queue-repository.mjs tests/curation-queue.test.mjs
git commit -m "feat: add durable curation leases"
```

### Task 4: Define structured agent decisions and consensus

**Files:**
- Create: `lib/curation/contracts.mjs`
- Create: `lib/curation/contracts.d.mts`
- Create: `lib/curation/consensus.mjs`
- Create: `tests/curation-contracts.test.mjs`
- Create: `tests/curation-consensus.test.mjs`
- Create: `tests/fixtures/curation/*.json`

- [ ] **Step 1: Write failing contract tests**

The parser must reject unknown actions, missing citations, malformed entity references, agent-supplied Elo values, and free-form mutations outside:

```text
approve_battle, reject_battle, escalate, merge_commanders, separate_commanders
```

Every approve or merge action must include `evidence[]`, `reason`, `canonicalMutation`, `dataRevision`, and `promptVersion`.

- [ ] **Step 2: Implement strict parsing without coercion**

Export:

```js
parseAgentDecision(value)
assertCanonicalMutation(value)
```

Return new immutable objects. Never retain unknown keys.

- [ ] **Step 3: Write failing consensus tests**

Export `resolveConsensus(proposal, review)` with results:

```js
{ kind: "execute", decision }
{ kind: "escalate", reason, proposal, review }
```

Compatible means the same action and structurally identical canonical mutation after stable key ordering. Any disagreement, explicit escalation, missing evidence, or identity split/merge ambiguity escalates. Do not compare numeric confidence.

- [ ] **Step 4: Implement consensus and recordings**

Add fixtures for agreement, disagreement, insufficient evidence, malformed output, merge, and separation.

Run: `node --test tests/curation-contracts.test.mjs tests/curation-consensus.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add lib/curation tests/curation-contracts.test.mjs tests/curation-consensus.test.mjs tests/fixtures/curation
git commit -m "feat: define auditable AI decisions"
```

### Task 5: Build the two-agent Codex worker

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `worker/curation/codex-runner.mjs`
- Create: `worker/curation/orchestrator.mjs`
- Create: `worker/curation/index.mjs`
- Create: `worker/curation/prompts/proposer-v1.md`
- Create: `worker/curation/prompts/reviewer-v1.md`
- Create: `tests/worker-curation.test.mjs`

- [ ] **Step 1: Install the SDK with an exact lockfile version**

Run: `npm install --save-exact @openai/codex-sdk`

Add scripts:

```json
"worker:curation": "node worker/curation/index.mjs",
"worker:curation:once": "node worker/curation/index.mjs --once"
```

- [ ] **Step 2: Write failing orchestration tests with a fake runner**

Assert this order:

```text
lease -> proposer fresh thread -> persist proposer review ->
reviewer fresh thread without proposer output -> persist reviewer review ->
consensus -> execute or escalate -> release
```

Also test heartbeat, malformed response retry, process restart after proposer persistence, and secret redaction. The normal test suite must not instantiate the real SDK client.

- [ ] **Step 3: Write versioned prompts**

The proposer receives the staged record, relevant canonical candidates, and source-search instructions. The reviewer receives the same raw evidence and rubric, but no proposer decision. Both must emit only the contract JSON.

- [ ] **Step 4: Implement the Codex adapter**

Export:

```js
createCodexRunner({ cwd, model, reasoningEffort })
runProposer(caseContext)
runReviewer(caseContext)
```

Create a new SDK thread for each call. Set the worker repository checkout read-only for research except for a dedicated temporary directory. Do not read or print `auth.json`.

- [ ] **Step 5: Implement the orchestrator loop**

Handle one case per iteration, heartbeat every 60 seconds, graceful `SIGTERM`, exponential retry capped at 15 minutes, and a 5 second idle poll. Persist each review before the next transition.

Run: `node --test tests/worker-curation.test.mjs`

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json worker/curation tests/worker-curation.test.mjs
git commit -m "feat: add two-agent Codex curation worker"
```

### Task 6: Publish canonical changes transactionally and reversibly

**Files:**
- Create: `supabase/migrations/202608240002_publication_and_ranking.sql`
- Modify: `supabase/tests/ai_curation_test.sql`
- Create: `lib/curation/publication-repository.mjs`
- Create: `tests/curation-publication.test.mjs`
- Modify: `worker/curation/orchestrator.mjs`

- [ ] **Step 1: Write failing publication tests**

Test approval creates/updates canonical engagement, sides, participations, claims, and sources in one transaction. Test merge preserves aliases, claims, participations, and source links. Test a forced error rolls back every canonical mutation and audit event.

- [ ] **Step 2: Implement `publish_curation_decision`**

The security-definer RPC must:

1. Lock the case and require two stored compatible reviews.
2. Capture affected canonical rows into `before_state`.
3. Apply only the validated mutation types.
4. Append one `editorial_events` row with actor/model/prompt/data versions.
5. Mark the case `published`.
6. Insert one idempotent pending `ranking_jobs` row.
7. Return event and ranking job IDs.

- [ ] **Step 3: Implement reversal**

Add `revert_editorial_event(event_id, curator_user_id, reason)`. Require owner membership, lock affected rows, restore `before_state`, append a compensating event, and enqueue a new ranking job. Never delete the original event.

- [ ] **Step 4: Connect consensus execution**

`execute` calls publication. `escalate` stores both reviews and changes the case to `awaiting_human`.

Run:
```bash
node --test tests/curation-publication.test.mjs tests/worker-curation.test.mjs
supabase test db supabase/tests/ai_curation_test.sql
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202608240002_publication_and_ranking.sql supabase/tests/ai_curation_test.sql lib/curation/publication-repository.mjs tests/curation-publication.test.mjs worker/curation/orchestrator.mjs
git commit -m "feat: publish and reverse curated history"
```

### Task 7: Create reproducible Elo snapshots

**Files:**
- Create: `lib/ranking/config.mjs`
- Create: `lib/ranking/elo.mjs`
- Create: `worker/ranking/orchestrator.mjs`
- Create: `worker/ranking/index.mjs`
- Create: `tests/ranking-elo.test.mjs`
- Create: `tests/worker-ranking.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write deterministic fixture tests**

Version `elo-v1` uses initial rating 1500, K-factor 32, scores 1/0.5/0, and stable ordering by engagement date, engagement ID, then participation ID. Test repeatability, draws, disconnected components, and that rejected/pending engagements are excluded.

- [ ] **Step 2: Implement a pure engine**

Export:

```js
calculateSnapshot({ commanders, engagements, participations, algorithm })
```

Return commander ratings, ranks, battle deltas, connected-component IDs, and input digest. Never query the database from this module.

- [ ] **Step 3: Implement ranking job leases**

Add RPCs equivalent to the curation lease lifecycle. `complete_ranking_job` inserts `ranking_snapshots` idempotently and marks the job completed in one transaction. Failure leaves the previous snapshot untouched.

- [ ] **Step 4: Add the ranking worker**

Run ranking immediately after each curation loop iteration, then poll pending jobs. Add:

```json
"worker:ranking": "node worker/ranking/index.mjs",
"worker:all": "node worker/index.mjs"
```

Run: `node --test tests/ranking-elo.test.mjs tests/worker-ranking.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add lib/ranking worker/ranking tests/ranking-elo.test.mjs tests/worker-ranking.test.mjs package.json
git commit -m "feat: publish reproducible Elo snapshots"
```

### Task 8: Add owner-only magic-link authentication

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/supabase/browser.ts`
- Create: `lib/supabase/server.ts`
- Create: `middleware.ts`
- Create: `app/login/page.tsx`
- Create: `app/auth/callback/route.ts`
- Create: `tests/auth-boundary.test.mjs`

- [ ] **Step 1: Install scoped Supabase clients**

Run: `npm install --save-exact @supabase/ssr @supabase/supabase-js`

Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` may enter the browser bundle.

- [ ] **Step 2: Write failing boundary tests**

Test unauthenticated `/curation` redirects to `/login`, authenticated non-members receive 403, owner membership succeeds, callback rejects invalid origins, and no service-role key is referenced under `app/` or `components/`.

- [ ] **Step 3: Implement login and callback**

Send magic links through Supabase Auth. Exchange the callback code server-side, store the session in secure HTTP-only cookies, and redirect only to same-origin paths.

- [ ] **Step 4: Protect `/curation`**

Middleware refreshes the session. The page performs the definitive membership check using the authenticated user and RLS.

Run: `node --test tests/auth-boundary.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/supabase middleware.ts app/login app/auth tests/auth-boundary.test.mjs
git commit -m "feat: protect curation with magic links"
```

### Task 9: Build the exception-focused curation panel

**Files:**
- Create: `app/curation/page.tsx`
- Create: `app/curation/[caseId]/page.tsx`
- Create: `app/curation/actions.ts`
- Create: `components/curation/queue-summary.tsx`
- Create: `components/curation/case-review.tsx`
- Create: `components/curation/event-history.tsx`
- Modify: `app/globals.css`
- Create: `tests/curation-ui.test.mjs`

- [ ] **Step 1: Write failing rendered UI tests**

Fixtures must cover empty automation, disagreement, failed case, proposed merge, completed publication, ranking failure, and mobile-width markup.

- [ ] **Step 2: Implement the dashboard**

Show counts for automatic work, exceptions, failures, active worker leases, current Codex plan/rate-limit metadata, and latest ranking snapshot. Default the queue to `awaiting_human` and `failed`.

- [ ] **Step 3: Implement case detail**

Render source links, normalized evidence, both independent reviews, a structural diff, publication history, and actions: approve corrected mutation, reject, merge, separate, retry, revert.

- [ ] **Step 4: Implement server actions through RPCs**

Every action rechecks owner membership, validates input, records an editorial event, and returns the updated case. No client code receives elevated credentials.

Run:
```bash
node --test tests/curation-ui.test.mjs tests/auth-boundary.test.mjs
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add app/curation components/curation app/globals.css tests/curation-ui.test.mjs
git commit -m "feat: add exception-first curation panel"
```

### Task 10: Package the Oracle Always Free worker

**Files:**
- Create: `worker/index.mjs`
- Create: `deploy/oracle/bellumetrics-worker.service`
- Create: `deploy/oracle/install.sh`
- Create: `deploy/oracle/healthcheck.sh`
- Create: `deploy/oracle/env.example`
- Create: `docs/operations/ai-curation.md`
- Create: `tests/oracle-deploy.test.mjs`

- [ ] **Step 1: Write failing deployment contract tests**

Assert the unit runs as a dedicated unprivileged user, has restart policy, restrictive filesystem settings, no inbound listener, an explicit working directory, and references an environment file outside the repository.

- [ ] **Step 2: Add the service and installer**

The installer creates `bellumetrics-worker`, checks out the release, installs production dependencies, creates `/etc/bellumetrics/worker.env` mode 600, and installs the systemd unit. It must not automate ChatGPT credential extraction.

- [ ] **Step 3: Document one-time Codex login**

The runbook uses `codex login --device-auth` as the worker user, verifies `codex login status`, ensures the Codex home is mode 700, and starts the service. Include logout, token rotation, database credential rotation, backup restoration, and lease recovery.

- [ ] **Step 4: Add health checks**

Report worker process state, last successful case, pending exceptions, last ranking snapshot, and stale leases without printing payloads or headers.

Run: `node --test tests/oracle-deploy.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add worker/index.mjs deploy/oracle docs/operations/ai-curation.md tests/oracle-deploy.test.mjs
git commit -m "ops: package Oracle curation worker"
```

### Task 11: Deploy to Vercel without breaking GitHub Pages

**Files:**
- Modify: `next.config.ts`
- Create: `vercel.json`
- Modify: `.github/workflows/pages.yml`
- Create: `tests/deployment-config.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Write failing deployment tests**

Assert `GITHUB_PAGES=1` still produces the static `/bellumetrics` export, normal builds remain server-capable for auth, and Vercel never runs the Oracle worker.

- [ ] **Step 2: Configure Vercel**

Set the framework build to `npm run build`. Configure Supabase public variables and the site URL in Vercel. Configure Supabase Auth redirect allow-list with the production Vercel callback and local callback.

- [ ] **Step 3: Preserve Pages during verification**

Keep the Pages workflow enabled. Add the Vercel URL to README as preview until all acceptance checks pass. Do not delete or redirect the Pages site in this task.

- [ ] **Step 4: Run the full local suite**

Run:
```bash
npm run lint
npm run test:db
npm run test:curation
npm test
npm run build:pages
```

Expected: all commands pass, and no test invokes live Codex.

- [ ] **Step 5: Commit**

```bash
git add next.config.ts vercel.json .github/workflows/pages.yml tests/deployment-config.test.mjs README.md
git commit -m "ops: prepare Vercel curation deployment"
```

### Task 12: Run end-to-end acceptance and open the implementation PR

**Files:**
- Create: `docs/operations/acceptance-2026-08-24.md`
- Modify only files required by verified defects.

- [ ] **Step 1: Apply migrations to the linked Supabase project**

Run: `supabase db push --linked`

Then run: `supabase test db`

Record migration versions and test output, never secrets.

- [ ] **Step 2: Create the owner membership**

After the owner signs in once, insert their Auth user UUID into `curator_memberships` using the Supabase dashboard or a one-time SQL statement. Verify another authenticated account cannot read curation data.

- [ ] **Step 3: Deploy and verify Vercel**

Verify public routes, login, callback, owner-only `/curation`, server rendering, mobile layout, and that the GitHub Pages URL remains healthy.

- [ ] **Step 4: Start the Oracle worker**

Perform device login interactively on Oracle, start `bellumetrics-worker.service`, and verify no inbound port is opened by the service.

- [ ] **Step 5: Execute the acceptance scenario**

Use one staged battle fixture:

1. Import twice and observe one pending case.
2. Observe two independent stored reviews.
3. Verify compatible agreement publishes canonical rows once.
4. Verify one ranking job produces one `elo-v1` snapshot.
5. Force disagreement and verify `awaiting_human` appears in the panel.
6. Restart the worker during a lease and verify recovery without duplication.
7. Publish a merge, revert it, and verify all relationships and sources return.
8. Search repository, logs, browser bundle, and artifacts for credential patterns.

- [ ] **Step 6: Record evidence**

In `docs/operations/acceptance-2026-08-24.md`, record commit SHA, migration versions, deployment URLs, test commands, non-secret screenshots or logs, and pass/fail for each spec criterion.

- [ ] **Step 7: Final verification**

Run:
```bash
npm run lint
npm run test:db
npm run test:curation
npm test
git status --short
```

Expected: all tests pass and only the acceptance evidence file is uncommitted.

- [ ] **Step 8: Commit and open a pull request**

```bash
git add docs/operations/acceptance-2026-08-24.md
git commit -m "test: record autonomous curation acceptance"
git push -u origin agent/ai-curation-implementation
gh pr create --base main --head agent/ai-curation-implementation --title "Build autonomous AI curation" --body-file docs/operations/acceptance-2026-08-24.md
```
