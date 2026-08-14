import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  return { response, html: await response.text() };
}

test("renders development preview metadata", async () => {
  const { response, html } = await render();

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(html, developmentPreviewMeta);
});

test("homepage communicates the ranking and connection product", async () => {
  const { response, html } = await render();
  assert.equal(response.status, 200);
  assert.match(html, /Commander Elo/i);
  assert.match(html, /Mide\. Compara\. Conecta\./i);
  assert.match(html, /Ranking histórico/i);
  assert.match(html, /Grados de separación/i);
  assert.match(html, /datos de demostración/i);
});
