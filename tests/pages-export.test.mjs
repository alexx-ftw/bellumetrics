import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
      /(?:src|href)="\/commander-elo\//,
      `${route} should reference a /commander-elo/ asset or link`,
    );
  }

  const home = pages.find(({ route }) => route === "index.html");
  assert.match(home.html, /href="\/commander-elo\/network\/"/);
  assert.match(home.html, /href="\/commander-elo\/rankings\/"/);
});
