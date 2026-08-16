# Supabase Automation Design

## Goal

Apply Bellumetrics database migrations safely and keep The War Atlas staging
dataset synchronized without routine manual work.

## Architecture

Use a hybrid workflow:

- Supabase CLI applies committed migrations and maintains migration history.
- Supabase REST API runs the existing idempotent staging importer.
- GitHub Actions orchestrates both operations.

The workflow uses three repository secrets:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_SERVICE_ROLE_KEY`

The project reference and API URL are non-secret configuration.

## Triggers

The workflow runs:

- after changes reach `main`;
- every Monday at 04:00 UTC;
- on manual dispatch.

Migration must succeed before import starts. A failed migration cannot leave an
import marked as successful.

## Data Flow

1. Check out the repository and install pinned dependencies.
2. Link the Supabase CLI to project `dggbwsgoddbrxvojjojy`.
3. Apply unapplied files from `supabase/migrations`.
4. Download and validate The War Atlas manifest and battle dataset.
5. Normalize the dataset deterministically.
6. Upsert one import run and its staging records through the REST API.
7. Mark the run as staged only after every batch succeeds.
8. Verify the schema, RLS state, policies, import status, and staged row count.

Canonical historical records are never created or published by this workflow.

## Failure Handling

The workflow fails on any migration, validation, import, or verification error.
On failure it creates or updates one GitHub Issue identified by a stable title
and label. Repeated failures add context to the same issue instead of creating
duplicates. A later successful run closes the open automation-failure issue.

Logs may contain counts, versions, table names, and error summaries. They must
never print credentials, authorization headers, or complete request payloads.

## Security

- Secrets are GitHub repository secrets and are passed only to the steps that
  require them.
- The service-role key is used only by the server-side importer.
- Public canonical tables retain RLS and explicit read-only grants.
- Staging tables remain inaccessible to `anon` and `authenticated`.
- GitHub permissions default to read-only, with `issues: write` granted only
  for failure reporting.
- Third-party GitHub Actions and CLI versions are pinned.

## Testing

Automated tests cover:

- workflow triggers, dependency ordering, permissions, and secret references;
- migration command construction;
- idempotent REST staging in bounded batches;
- failed-run state transitions;
- post-import schema and row-count verification;
- failure-Issue deduplication rules.

The implementation is complete when local tests pass and a GitHub Actions run
applies the migration, stages the real dataset, and verifies the live project.
