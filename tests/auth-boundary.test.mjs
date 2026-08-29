import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  try {
    return await readFile(new URL(path, root), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function cookieBoundary() {
  const moduleSource = await source("lib/supabase/cookie-options.mjs");
  if (!moduleSource) return null;

  return import(`data:text/javascript,${encodeURIComponent(moduleSource)}`);
}

test("uses scoped public-key Supabase clients in browser and server code", async () => {
  const [browser, server] = await Promise.all([
    source("lib/supabase/browser.ts"),
    source("lib/supabase/server.ts"),
  ]);

  assert.match(browser, /createBrowserClient/);
  assert.match(server, /createServerClient/);
  for (const file of [browser, server]) {
    assert.match(file, /NEXT_PUBLIC_SUPABASE_URL/);
    assert.match(file, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    assert.doesNotMatch(file, /SUPABASE_SERVICE_ROLE_KEY/);
  }
});

test("hardens every Supabase session Set-Cookie option", async () => {
  const boundary = await cookieBoundary();
  assert.ok(boundary, "cookie hardening boundary must exist");

  assert.deepEqual(boundary.hardenAuthCookieOptions({
    httpOnly: false,
    secure: false,
    sameSite: "none",
    path: "/temporary",
    maxAge: 3600,
  }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 3600,
  });

  const [server, middleware, callback] = await Promise.all([
    source("lib/supabase/server.ts"),
    source("middleware.ts"),
    source("app/auth/callback/route.ts"),
  ]);
  for (const file of [server, middleware, callback]) {
    assert.match(file, /hardenAuthCookieOptions\(options\)/);
    assert.match(file, /cookieOptions: authCookieOptions/);
  }
});

test("refreshes a verified session and redirects unauthenticated curation visitors to login", async () => {
  const middleware = await source("middleware.ts");

  assert.match(middleware, /createServerClient/);
  assert.match(middleware, /auth\.getClaims\(\)/);
  assert.match(middleware, /pathname\.startsWith\(["']\/curation["']\)/);
  assert.match(middleware, /\/login/);
  assert.match(middleware, /return_to/);
  assert.match(middleware, /GITHUB_PAGES/);
});

test("enforces owner membership through the authenticated RLS client for curation", async () => {
  const [page, nextConfig] = await Promise.all([
    source("app/curation/page.server.tsx"),
    source("next.config.ts"),
  ]);

  assert.match(page, /dynamic = "force-dynamic"/);
  assert.match(page, /auth\.getClaims\(\)/);
  assert.match(page, /from\(["']curator_memberships["']\)/);
  assert.match(page, /eq\(["']user_id["']/);
  assert.match(page, /eq\(["']role["'],\s*["']owner["']\)/);
  assert.match(page, /forbidden\(\)/);
  assert.match(nextConfig, /pageExtensions: \["tsx"\]/);
  assert.match(nextConfig, /"server\.tsx"/);
  assert.match(nextConfig, /authInterrupts: true/);
});

test("sends magic links and exchanges callback codes only into same-origin destinations", async () => {
  const [login, callback] = await Promise.all([
    source("app/login/page.tsx"),
    source("app/auth/callback/route.ts"),
  ]);

  assert.match(login, /signInWithOtp/);
  assert.match(login, /emailRedirectTo/);
  assert.match(login, /new URL\(/);
  assert.match(callback, /exchangeCodeForSession/);
  assert.match(callback, /new URL\(/);
  assert.match(callback, /next/);
  assert.match(callback, /origin/);
  assert.match(callback, /pathname\.startsWith\(["']\/["']\)/);
});

test("does not reference a service-role key under browser-bundled application code", async () => {
  const paths = [
    "app/login/page.tsx",
    "app/auth/callback/route.ts",
    "app/curation/page.server.tsx",
    "components/site-header.tsx",
    "lib/supabase/browser.ts",
  ];
  const files = await Promise.all(paths.map(source));

  for (const file of files) {
    assert.doesNotMatch(file, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(file, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/);
  }
});

test("rechecks owner authorization and uses an audited RPC for every curation mutation", async () => {
  const actions = await source("app/curation/actions.ts");

  assert.match(actions, /"use server"/);
  assert.match(actions, /auth\.getClaims\(\)/);
  assert.match(actions, /from\("curator_memberships"\)/);
  assert.match(actions, /eq\("user_id", userId\)/);
  assert.match(actions, /eq\("role", "owner"\)/);
  assert.match(actions, /ACTIONS\.has\(action\)/);
  assert.match(actions, /supabase\.rpc\("owner_curation_action"/);
  assert.doesNotMatch(actions, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(actions, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/);
});
