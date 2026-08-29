# Task 9 report: exception-first curation panel

## Delivered

- Replaced the owner-confirmation placeholder with a compact Spanish dashboard
  focused on `awaiting_human` and `failed` cases. It shows automation,
  exceptions, technical failures, active leases, Codex plan/rate metadata,
  ranking failures, and the latest reproducible snapshot.
- Added private case detail routes with normalized source links, both recorded
  independent reviews, a JSON structural-difference list, audited publication
  history, ranking-failure visibility, and human action forms.
- Added server actions that validate bounded form data, independently recheck
  the authenticated owner membership, and invoke only `owner_curation_action`.
  No client or application code receives a service-role credential.
- Added `202608250001_owner_curation_actions.sql`. The authenticated owner RPC
  locks the case, validates the supported action/mutation, appends audit data,
  clears stale leases where appropriate, delegates reversals to the existing
  audited reversal RPC, and returns the updated case.
- Kept `page.server.tsx` and used `[caseId]/page.server.tsx` deliberately:
  `next.config.ts` excludes both from the GitHub Pages static export while
  retaining them in server-capable Next deployments.

## Verification

- `node --test tests/curation-ui.test.mjs tests/auth-boundary.test.mjs` — 13 passing.
- `npm run lint` — exit 0; one pre-existing unused-variable warning remains in
  `tests/war-atlas-import.test.mjs`.
- `npx next build` — passing; `/curation` and `/curation/[caseId]` dynamic.
- `npm run build:pages` and `node --test tests/pages-export.test.mjs` — passing;
  no curation route is exported.
- `npm run test:curation` — 115 passing.
- `npm test` — passing (build plus rendered public routes).
- PGlite applied the foundation, curation/publication, and new owner-action
  migrations successfully.
- `git diff --check` — clean.

## Fix R1

- `202608250002_owner_canonical_publication.sql` replaces the placeholder
  state-only owner flow with a private owner-publication primitive. It accepts
  only strict battle/identity mutations, rechecks `auth.uid()` owner status,
  locks the affected case and canonical graph, captures the real prior state,
  publishes canonical rows, creates a human editorial event, marks the case
  `published`, and queues one idempotent Elo job. It uses existing recorded
  cited review evidence without fabricating AI reviews.
- Repeating the same owner publication returns the existing human event/job;
  standard reversal now works because human events use the same canonical
  action names and snapshot shapes as Task 6.
- `reject` and `retry` preserve their case-transition behavior and audit exact
  before/after case rows. Reversal rejects an event from another case.
- The detail UI offers reversal only for unreverted canonical publication
  events with captured snapshots. Evidence URLs are parsed and rendered only
  for `https:` or `http:`; `javascript:` and `data:` values remain plain text.

Additional adversarial PGlite and rendered-UI coverage verifies malformed
owner mutations, cross-case reversal rejection, idempotent owner publication,
reversal, unsupported scheme suppression, and RPC grants.
