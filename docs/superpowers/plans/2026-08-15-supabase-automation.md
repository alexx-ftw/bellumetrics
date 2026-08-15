# Supabase Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Bellumetrics migrations and synchronize The War Atlas staging data automatically, verify the live database, and maintain one failure Issue.

**Architecture:** A GitHub Actions workflow uses the pinned Supabase CLI for migration history and live pgTAP checks, then invokes the existing REST importer for bounded idempotent staging. A final GitHub Script step creates, updates, or closes one stable failure Issue.

**Tech Stack:** GitHub Actions, Node.js 22, Supabase CLI 2.101.0, Postgres/pgTAP, Supabase REST API, Node test runner

## Global Constraints

- Supabase project reference is `dggbwsgoddbrxvojjojy`.
- Run after changes reach `main`, every Monday at 04:00 UTC, and on manual dispatch.
- Migrations must succeed before import starts.
- Canonical historical records are never created or published by automation.
- Never print credentials, authorization headers, or complete request payloads.
- Use repository secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, and `SUPABASE_SERVICE_ROLE_KEY`.
- Give GitHub `contents: read` and `issues: write` only.

---

### Task 1: Live database contract

**Files:**
- Create: `supabase/tests/wiki_data_foundation_test.sql`
- Create: `tests/supabase-live-contract.test.mjs`

**Interfaces:**
- Consumes: the tables, policies, and grants created by `supabase/migrations/202608150001_wiki_data_foundation.sql`
- Produces: a pgTAP contract runnable with `supabase test db supabase/tests/wiki_data_foundation_test.sql --linked`

- [ ] **Step 1: Write the failing structural test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("live contract checks schema, RLS, grants, and staging isolation", async () => {
  const sql = await readFile("supabase/tests/wiki_data_foundation_test.sql", "utf8");
  assert.match(sql, /plan\(15\)/);
  assert.match(sql, /has_table\('public', 'commanders'/);
  assert.match(sql, /relrowsecurity/);
  assert.match(sql, /has_table_privilege\('anon', 'public\.commanders', 'SELECT'\)/);
  assert.match(sql, /hasnt_table_privilege\('anon', 'public\.import_runs', 'SELECT'\)/);
  assert.match(sql, /status = 'staged'/);
}
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/supabase-live-contract.test.mjs`

Expected: FAIL with `ENOENT` for `supabase/tests/wiki_data_foundation_test.sql`.

- [ ] **Step 3: Add the pgTAP contract**

Create a transaction-scoped test with these exact assertions:

```sql
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(15);
select has_table('public', 'commanders', 'commanders exists');
select has_table('public', 'engagements', 'engagements exists');
select has_table('public', 'participations', 'participations exists');
select has_table('public', 'sources', 'sources exists');
select has_table('public', 'claims', 'claims exists');
select has_table('public', 'import_runs', 'import_runs exists');
select has_table('public', 'import_records', 'import_records exists');
select ok((select relrowsecurity from pg_class where oid = 'public.commanders'::regclass), 'commanders RLS is active');
select ok((select relrowsecurity from pg_class where oid = 'public.import_runs'::regclass), 'import_runs RLS is active');
select ok(has_table_privilege('anon', 'public.commanders', 'SELECT'), 'anon reads commanders');
select ok(has_table_privilege('authenticated', 'public.commanders', 'SELECT'), 'authenticated reads commanders');
select ok(not has_table_privilege('anon', 'public.import_runs', 'SELECT'), 'anon cannot read import runs');
select ok(not has_table_privilege('authenticated', 'public.import_records', 'SELECT'), 'authenticated cannot read import records');
select ok(exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'commanders' and policyname = 'commanders_public_read'), 'commander read policy exists');
select ok(exists(select 1 from public.import_runs where status = 'staged'), 'a staged import exists');
select * from finish();
rollback;
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node --test tests/supabase-live-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/wiki_data_foundation_test.sql tests/supabase-live-contract.test.mjs
git commit -m "Add live Supabase contract"
```

### Task 2: Workflow contract and automation

**Files:**
- Create: `.github/workflows/supabase-sync.yml`
- Create: `tests/supabase-automation.test.mjs`

**Interfaces:**
- Consumes: `npm run import:war-atlas`, the three repository secrets, and the pgTAP contract from Task 1
- Produces: the `Supabase schema and staging sync` GitHub Actions workflow

- [ ] **Step 1: Write the failing workflow test**

The test reads `.github/workflows/supabase-sync.yml` and asserts:

```js
assert.match(workflow, /branches:\s*\[main\]/);
assert.match(workflow, /cron:\s*["']0 4 \* \* 1["']/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /contents:\s*read/);
assert.match(workflow, /issues:\s*write/);
assert.match(workflow, /supabase@2\.101\.0 link --project-ref dggbwsgoddbrxvojjojy/);
assert.match(workflow, /supabase@2\.101\.0 db push --linked/);
assert.match(workflow, /npm run import:war-atlas/);
assert.match(workflow, /supabase test db supabase\/tests\/wiki_data_foundation_test\.sql --linked/);
assert.match(workflow, /SUPABASE_ACCESS_TOKEN:\s*\$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/);
assert.match(workflow, /SUPABASE_DB_PASSWORD:\s*\$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/);
assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
```

It also compares substring positions to prove `db push` precedes import and import precedes pgTAP verification.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/supabase-automation.test.mjs`

Expected: FAIL with `ENOENT` for `.github/workflows/supabase-sync.yml`.

- [ ] **Step 3: Add the synchronization job**

Create a workflow with:

```yaml
name: Supabase schema and staging sync
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 4 * * 1"
  workflow_dispatch:
permissions:
  contents: read
  issues: write
concurrency:
  group: supabase-sync
  cancel-in-progress: false
```

The `sync` job checks out `main`, installs Node 22 dependencies, links with
`npx supabase@2.101.0 link --project-ref dggbwsgoddbrxvojjojy`, runs
`npx supabase@2.101.0 db push --linked`, executes
`npm run import:war-atlas` with `SUPABASE_URL=https://dggbwsgoddbrxvojjojy.supabase.co`,
runs `npx supabase@2.101.0 db lint --linked --level error --fail-on error --schema public`,
then runs the linked pgTAP contract.

- [ ] **Step 4: Add deduplicated failure reporting**

Add an `always()` reporting job using `actions/github-script@v7`. Use the stable title
`Supabase automation failure` and label `automation`. On failure, find the open
Issue and append the run URL, or create it if absent. Create the `automation` label
first when it does not exist. On success, close the open Issue with a recovery comment.
Never include environment variables in the Issue body.

- [ ] **Step 5: Run the test and verify GREEN**

Run: `node --test tests/supabase-automation.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run related regression tests**

Run:

```bash
node --test tests/import-war-atlas-cli.test.mjs tests/war-atlas-import.test.mjs tests/supabase-schema.test.mjs tests/supabase-live-contract.test.mjs tests/supabase-automation.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/supabase-sync.yml tests/supabase-automation.test.mjs
git commit -m "Automate Supabase schema and staging sync"
```

### Task 3: Operator documentation

**Files:**
- Modify: `README.md`
- Test: `tests/supabase-automation.test.mjs`

**Interfaces:**
- Consumes: workflow and secret names from Task 2
- Produces: concise setup and operational guidance for repository maintainers

- [ ] **Step 1: Extend the failing test**

Add assertions that `README.md` names all three secrets, links
`.github/workflows/supabase-sync.yml`, states the Monday schedule, and says imports
remain in staging pending review.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/supabase-automation.test.mjs`

Expected: FAIL because the README lacks the automation section.

- [ ] **Step 3: Add the minimal README section**

Document the trigger schedule, three secrets, manual dispatch location, staging-only
boundary, and stable failure Issue behavior. Do not include secret values or examples
that resemble real credentials.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node --test tests/supabase-automation.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/supabase-automation.test.mjs
git commit -m "Document Supabase automation"
```

### Task 4: Final verification and publication

**Files:**
- Verify only: all files changed by Tasks 1 through 3

**Interfaces:**
- Consumes: completed implementation
- Produces: a verified update to PR #3 and evidence from the first live workflow run

- [ ] **Step 1: Run all relevant local checks**

```bash
node --test tests/supabase-live-contract.test.mjs tests/supabase-automation.test.mjs tests/import-war-atlas-cli.test.mjs tests/war-atlas-import.test.mjs tests/supabase-schema.test.mjs
npm test
npm run lint
git diff --check 5288501..HEAD
```

Expected: every command exits 0.

- [ ] **Step 2: Confirm repository secrets**

Confirm GitHub contains the names `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, and `SUPABASE_SERVICE_ROLE_KEY` without reading their
values. Stop before publication if either of the last two names is absent.

- [ ] **Step 3: Publish the commits to PR #3**

Push `agent/wiki-data-foundation` and verify PR #3 shows the workflow, contract,
documentation, and no secret values.

- [ ] **Step 4: Run and inspect the live workflow**

After the workflow is available on `main`, trigger it or observe the scheduled/push
run. Verify migration success, import version, staged row count, pgTAP success, and
absence of an open `Supabase automation failure` Issue.

- [ ] **Step 5: Record completion**

Update the PR description with the workflow run URL and verified live counts without
including credentials or request payloads.
