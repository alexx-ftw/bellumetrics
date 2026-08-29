# Task 8 report: owner-only magic-link authentication

## Delivered boundary

- Added exact `@supabase/ssr` and `@supabase/supabase-js` dependencies.
- Added browser and server Supabase clients that use only
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Added magic-link login, server-side callback code exchange, secure session
  cookie propagation (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`), and
  same-origin return-path validation.
- Added session-refresh middleware for `/curation` and a dynamic server-only
  curation route that validates JWT claims, then owner membership through the
  authenticated Supabase client and RLS. Non-members receive `403`.
- GitHub Pages remains a public static export: its build excludes server-only
  route entries and the authentication middleware. Server-capable builds retain
  `/auth/callback`, `/curation`, and middleware.

## Verification

- `node --test tests/auth-boundary.test.mjs` — 6 passing, including a cookie
  boundary test that verifies all three SSR session writers force secure
  `Set-Cookie` options.
- `npm run lint` — exit 0 (one pre-existing unused-variable warning in
  `tests/war-atlas-import.test.mjs`).
- `npm run test:curation` — 109 passing.
- `npm test` — passing build and 6 rendered-page tests.
- `npx next build` — passing; `/auth/callback` and `/curation` dynamic.
- `npm run build:pages` — passing static export without private routes.
- `git diff --check` — clean.

## Deployment follow-up

Task 11 must configure the Supabase Auth redirect allow-list for the Vercel
and local `/auth/callback` URLs, and configure the two public Supabase
variables. After the first successful owner sign-in, Task 12 must insert that
user UUID into `curator_memberships` with role `owner`.
