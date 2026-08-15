# Bellumetrics Wiki Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure Supabase schema and a reproducible importer that stages The War Atlas data for editorial review without publishing imported facts automatically.

**Architecture:** Canonical historical entities live in normalized PostgreSQL tables protected by row-level security. External datasets enter separate staging tables through a service-role-only CLI, preserving raw payloads, checksums, dataset version, license, and attribution; a later editorial workflow will promote reviewed records into canonical tables.

**Tech Stack:** PostgreSQL/Supabase migrations, Node.js 22 ESM, Node test runner, `@electric-sql/pglite` for migration integration tests, native `fetch` for Supabase REST imports.

## Global Constraints

- Platform name is **Bellumetrics** and **Commander Elo** remains the primary ranking name.
- Every imported fact remains unpublished until reviewed; imports never write directly to canonical tables.
- The War Atlas dataset is CC BY 4.0 and must retain attribution to `The War Atlas — thewaratlas.co`.
- Canonical browser access is read-only and limited to published rows; staging data is inaccessible to anonymous and authenticated browser roles.
- All identifiers are lowercase snake_case, all foreign keys are indexed, and timestamps use `timestamptz`.
- Import runs are idempotent by `(source_dataset, source_version)` and records by `(import_run_id, entity_type, external_id)`.

---

### Task 1: Supabase canonical and staging schema

**Files:**
- Create: `supabase/migrations/202608150001_wiki_data_foundation.sql`
- Create: `tests/supabase-schema.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Supabase `auth.uid()` only through future editorial migrations; this migration does not require authentication functions.
- Produces: canonical tables `commanders`, `campaigns`, `engagements`, `engagement_sides`, `participations`, `result_interpretations`, `sources`, `claims`, `claim_sources`, `commander_claims`, `engagement_claims`, `participation_claims`, and `result_interpretation_claims`; staging tables `import_runs` and `import_records`.

- [ ] **Step 1: Add the migration test dependency**

Run:

```bash
NPM_CONFIG_CACHE=/tmp/bellumetrics-wiki-npm-cache npm install --save-dev @electric-sql/pglite@0.5.5
```

- [ ] **Step 2: Write the failing migration integration test**

Create `tests/supabase-schema.test.mjs` that loads the SQL file into a real in-memory PGlite database, creates the Supabase API roles when absent, applies the migration, and asserts:

```js
const expectedTables = [
  "campaigns", "claim_sources", "claims", "commander_claims",
  "commanders", "engagement_claims", "engagement_sides", "engagements",
  "import_records", "import_runs", "participation_claims", "participations",
  "result_interpretation_claims", "result_interpretations", "sources",
];

assert.deepEqual(actualTables, expectedTables);
assert.equal(importRecordsRls, true);
assert.equal(commandersRls, true);
```

Insert one published and one pending commander as the database owner, switch to the `anon` role, and assert only the published row can be selected and an insert is rejected.

- [ ] **Step 3: Run the migration test and verify RED**

Run:

```bash
node --test tests/supabase-schema.test.mjs
```

Expected: FAIL because `supabase/migrations/202608150001_wiki_data_foundation.sql` does not exist.

- [ ] **Step 4: Implement the SQL migration**

Create the canonical and staging tables with:

```sql
create table public.import_runs (
  id bigint generated always as identity primary key,
  source_dataset text not null,
  source_version text not null,
  source_url text not null,
  license_name text not null,
  attribution text not null,
  status text not null default 'importing'
    check (status in ('importing', 'staged', 'failed')),
  row_counts jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  unique (source_dataset, source_version)
);

create table public.import_records (
  id bigint generated always as identity primary key,
  import_run_id bigint not null references public.import_runs(id) on delete cascade,
  entity_type text not null check (entity_type in ('battle', 'commander', 'war', 'faction', 'source')),
  external_id text not null,
  wikidata_qid text,
  checksum text not null,
  payload jsonb not null,
  staged_at timestamptz not null default now(),
  unique (import_run_id, entity_type, external_id)
);
```

Use `bigint generated always as identity` primary keys, explicit checks for lifecycle values and numeric ranges, indexes for every foreign key and public listing query, and partial unique indexes for non-null Wikidata QIDs. Enable RLS on every table. Grant `select` on canonical tables to `anon` and `authenticated`, create published-only select policies, and revoke all staging-table privileges from both roles. Do not add client write policies.

- [ ] **Step 5: Run the migration test and verify GREEN**

Run:

```bash
node --test tests/supabase-schema.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the schema**

```bash
git add package.json package-lock.json supabase/migrations/202608150001_wiki_data_foundation.sql tests/supabase-schema.test.mjs
git commit -m "Add Supabase wiki data foundation"
```

### Task 2: The War Atlas normalization

**Files:**
- Create: `lib/import/war-atlas.mjs`
- Create: `tests/war-atlas-import.test.mjs`

**Interfaces:**
- Consumes: `normalizeWarAtlasDataset({ manifest, battles })` where `manifest` is the published dataset manifest and `battles` is the nested JSON array.
- Produces: `{ run, records }`, where `run` carries source metadata and `records` contains deterministic staging rows with `entity_type`, `external_id`, `wikidata_qid`, `checksum`, and `payload`.
- Produces: `chunkRecords(records, size = 500)` for bounded Supabase REST requests.

- [ ] **Step 1: Write normalization tests with a literal fixture**

Use a two-battle fixture that includes repeated commanders, missing QIDs, two sides, source slugs, force ranges, and Unicode names. Assert literal outputs for:

```js
assert.equal(result.run.sourceDataset, "the-war-atlas");
assert.equal(result.run.sourceVersion, "2026-07-03");
assert.equal(result.records.filter((row) => row.entityType === "battle").length, 2);
assert.equal(result.records.filter((row) => row.entityType === "commander").length, 3);
assert.equal(result.records[0].checksum.length, 64);
assert.deepEqual(chunkRecords([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
```

Also assert that a manifest without `CC BY 4.0`, a duplicate battle slug with different payload, or a commander without a slug throws a descriptive validation error.

- [ ] **Step 2: Run the normalization tests and verify RED**

Run:

```bash
node --test tests/war-atlas-import.test.mjs
```

Expected: FAIL because `lib/import/war-atlas.mjs` does not exist.

- [ ] **Step 3: Implement deterministic normalization**

Implement:

```js
export function normalizeWarAtlasDataset({ manifest, battles }) { /* validate and normalize */ }
export function chunkRecords(records, size = 500) { /* bounded slices */ }
```

Canonicalize object keys recursively before calculating SHA-256 with `node:crypto`. Emit one `battle` record per battle and deduplicate embedded commanders by slug, rejecting conflicting duplicate payloads. Preserve every original battle payload and source slug in the staged JSON. Do not infer winners, Elo eligibility, roles, responsibility, or confidence where the source is blank.

- [ ] **Step 4: Run the normalization tests and verify GREEN**

Run:

```bash
node --test tests/war-atlas-import.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the normalizer**

```bash
git add lib/import/war-atlas.mjs tests/war-atlas-import.test.mjs
git commit -m "Normalize The War Atlas dataset"
```

### Task 3: Idempotent Supabase staging CLI

**Files:**
- Create: `scripts/import-war-atlas.mjs`
- Create: `tests/import-war-atlas-cli.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: environment variables `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Consumes: The War Atlas URLs `https://thewaratlas.co/downloads/manifest.json` and `https://thewaratlas.co/downloads/battles.json`.
- Produces: `stageWarAtlas({ supabaseUrl, serviceRoleKey, fetchImpl, manifestUrl?, battlesUrl?, batchSize? })` returning `{ importRunId, sourceVersion, recordsStaged }`.

- [ ] **Step 1: Write the failing CLI boundary test**

Create an in-process HTTP server that serves literal manifest/battle fixtures and records Supabase REST requests. Assert that `stageWarAtlas`:

```js
assert.equal(result.sourceVersion, "2026-07-03");
assert.equal(result.recordsStaged, 5);
assert.equal(requests.filter((request) => request.path === "/rest/v1/import_records").length, 3);
assert.equal(requests.at(-1).body.status, "staged");
```

Use a batch size of two in the test. Assert a failed batch marks the run `failed` and rethrows without writing to canonical table endpoints.

- [ ] **Step 2: Run the CLI test and verify RED**

Run:

```bash
node --test tests/import-war-atlas-cli.test.mjs
```

Expected: FAIL because `scripts/import-war-atlas.mjs` does not exist.

- [ ] **Step 3: Implement the REST importer and CLI**

Implement native-fetch requests with service-role headers:

```js
const headers = {
  apikey: serviceRoleKey,
  authorization: `Bearer ${serviceRoleKey}`,
  "content-type": "application/json",
};
```

Upsert the import run by `(source_dataset, source_version)`, upsert record batches by `(import_run_id, entity_type, external_id)`, then mark the run `staged`. On error, mark it `failed` with a bounded message and set `completed_at`. Export the orchestration function and execute it only when the module is run directly. Never log the service-role key.

- [ ] **Step 4: Add the npm command and operator documentation**

Add:

```json
"import:war-atlas": "node scripts/import-war-atlas.mjs"
```

Document migration application, required environment variables, attribution, staging-only behavior, and the command in `README.md`.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --test tests/supabase-schema.test.mjs tests/war-atlas-import.test.mjs tests/import-war-atlas-cli.test.mjs
npm test
npm run lint
npm run build:pages
node --test tests/pages-export.test.mjs
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the importer**

```bash
git add scripts/import-war-atlas.mjs tests/import-war-atlas-cli.test.mjs package.json README.md
git commit -m "Stage The War Atlas imports in Supabase"
```

## Self-review

- Spec coverage: this plan covers canonical/staging separation, claim-source structures, multi-commander participation, campaign containment, disputed outcomes as non-inferred staged payloads, RLS, provenance, licensing, idempotency, and the ban on automatic publication. Authentication, editorial proposals, promotion, Elo recalculation, and dynamic pages remain explicitly separate working increments.
- Placeholder scan: no `TBD`, deferred code placeholder, or unspecified error handling remains.
- Type consistency: dataset metadata, normalized record fields, REST column names, conflict keys, and batch behavior are consistent across all three tasks.
