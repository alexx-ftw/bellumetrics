import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const nextBin = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);

function buildNext(environment) {
  execFileSync(process.execPath, [nextBin, "build"], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: "pipe",
  });
}

async function exists(path) {
  try {
    await access(new URL(path, import.meta.url));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("Vercel uses the Next.js server build and never invokes the Oracle worker", async () => {
  let source = "";
  try {
    source = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  assert.ok(source, "Vercel must declare a project build configuration");
  const config = JSON.parse(source);

  assert.equal(config.buildCommand, "npm run build:vercel");
  assert.equal(config.installCommand, "npm ci");
  assert.doesNotMatch(JSON.stringify(config), /worker:|worker\/|oracle/i);

  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts["build:vercel"], "next build");
});

test("Pages stays a /bellumetrics static export without private routes", async () => {
  buildNext({ GITHUB_PAGES: "1" });

  const html = await readFile(
    new URL("../out/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /(?:src|href)="\/bellumetrics\//);
  assert.equal(await exists("../out/curation/index.html"), false);
  assert.equal(await exists("../out/auth/callback/index.html"), false);
});

test("a normal Next build retains the server auth callback route", async () => {
  buildNext({ GITHUB_PAGES: "" });

  const manifest = JSON.parse(
    await readFile(
      new URL("../.next/server/app-paths-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest["/auth/callback/route"], "app/auth/callback/route.js");
  assert.equal(manifest["/curation/page"], "app/curation/page.js");
});

test("the Vercel workflow appends Supabase redirects even when the list is empty", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/vercel-preview.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /\+ \[\$production, \$local\]/);
  assert.match(workflow, /--arg uri_allow_list/);
  assert.doesNotMatch(workflow, /--argjson uri_allow_list/);
});
