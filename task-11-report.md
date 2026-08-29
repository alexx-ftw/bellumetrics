# Task 11 report: Vercel curation deployment preparation

## Delivered

- Added `vercel.json` with `npm ci` and the application-only build command
  `npm run build`. It does not invoke either Oracle worker entrypoint.
- Added an executable deployment contract. It builds the GitHub Pages variant
  and verifies the `/bellumetrics` asset path with no exported `/curation` or
  `/auth/callback` route, then builds the normal Next variant and verifies the
  server auth callback and private curation route manifest entries.
- Kept the GitHub Pages workflow byte-for-byte unchanged and enabled. The
  existing Pages URL remains the live public publication.
- Documented Vercel as an un-deployed configurable preview. The README names
  only `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
  `NEXT_PUBLIC_SITE_URL`; no values or server credentials are stored.
- Deferred the Supabase Auth production and local callback allow-list to Task
  12, once a real Vercel origin is known. No deployment, Vercel project,
  Supabase configuration, GitHub workflow, or worker was changed remotely.

`next.config.ts` already separated the two build modes correctly, so it and the
Pages workflow required no change for this task.

## Verification

- `node --test tests/deployment-config.test.mjs tests/pages-export.test.mjs` —
  6 passing.
- `npm run lint` — exit 0; one pre-existing unused-variable warning remains in
  `tests/war-atlas-import.test.mjs`.
- `npm run test:db` — 9 passing.
- `npm run test:curation` — 119 passing.
- `npm test` — passing build and 6 rendered-page tests.
- `npm run build:pages` — passing static export.
- `git diff --check` — clean before committing.
