import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const exportedRoutes = [
  "index.html",
  "network/index.html",
  "rankings/index.html",
  "commander/napoleon-bonaparte/index.html",
];

test("exports the required GitHub Pages routes with base-path assets and links", async () => {
  const pages = await Promise.all(
    exportedRoutes.map(async (route) => ({
      route,
      html: await readFile(new URL(`../out/${route}`, import.meta.url), "utf8"),
    })),
  );

  for (const { route, html } of pages) {
    assert.ok(html.length > 0, `${route} should contain HTML`);
    assert.match(
      html,
      /(?:src|href)="\/bellumetrics\/_next\//,
      `${route} should reference a /bellumetrics/_next/ asset`,
    );
    assert.match(
      html,
      /href="\/bellumetrics\/(?!_next\/)[^"]+"/,
      `${route} should include a /bellumetrics/ route link`,
    );
  }

  const home = pages.find(({ route }) => route === "index.html");
  assert.match(home.html, /href="\/bellumetrics\/network\/"/);
  assert.match(home.html, /href="\/bellumetrics\/rankings\/"/);
  assert.match(
    home.html,
    /rel="(?:shortcut icon|icon)" href="\/bellumetrics\/favicon\.svg"/,
    "the homepage favicon should use the Pages base path",
  );

  for (const { route, html } of pages) {
    assert.doesNotMatch(
      html,
      /(?:src|href)="\/(?!bellumetrics(?:\/|"))/,
      `${route} should not include a root-relative resource URL outside /bellumetrics`,
    );
  }
});

test("configures the GitHub Pages deployment workflow", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    workflow,
    /push:\s*\n\s*branches:\s*\[\s*main\s*\]/,
    "workflow should deploy on pushes to main",
  );
  assert.match(
    workflow,
    /uses:\s*actions\/upload-pages-artifact@v\d+/,
    "workflow should upload a Pages artifact",
  );
  assert.match(
    workflow,
    /uses:\s*actions\/deploy-pages@v\d+/,
    "workflow should deploy the Pages artifact",
  );
  assert.match(workflow, /path:\s*\.\/out\b/, "workflow should upload ./out");
  assert.match(
    workflow,
    /- name: Build the Pages export\s+run: npm run build:pages\s+- name: Test the Pages export\s+run: node --test tests\/pages-export\.test\.mjs\s+- name: Upload the Pages artifact/s,
    "workflow should test the export immediately after building and before upload",
  );
});

test("keeps hero decoration inside the Pages viewport", async () => {
  const cssDirectory = new URL("../out/_next/static/chunks/", import.meta.url);
  const cssFiles = (await readdir(cssDirectory)).filter((file) => file.endsWith(".css"));
  const stylesheets = await Promise.all(
    cssFiles.map((file) => readFile(new URL(file, cssDirectory), "utf8")),
  );

  assert.match(
    stylesheets.join("\n"),
    /\.hero\{[^}]*\boverflow:clip\b/,
    "the hero must clip its outward-positioned decorative pseudo-elements",
  );
});
