import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  CaseReviewView,
  EventHistoryView,
  QueueSummaryView,
  createStructuralDiff,
} from "../components/curation/panel-view.mjs";

const disagreement = {
  id: 41,
  caseKey: "the-war-atlas:battle:waterloo:2026-08-24",
  entityType: "battle",
  status: "awaiting_human",
  priority: 12,
  sourceRevision: "war-atlas-2026-08-24",
  updatedAt: "2026-08-25T09:30:00Z",
  payload: { title: "Waterloo", sources: [{ url: "https://example.test/waterloo", citation: "Chandler" }] },
};

const proposer = {
  reviewRole: "proposer",
  model: "gpt-5-codex",
  promptVersion: "proposer-v1",
  evidence: [{ citation: "Chandler, p. 1021", url: "https://example.test/chandler" }],
  decision: { action: "approve_battle", reason: "Las fuentes identifican el encuentro.", canonicalMutation: { action: "approve_battle", battle: { slug: "waterloo" } } },
};

const reviewer = {
  reviewRole: "reviewer",
  model: "gpt-5-codex",
  promptVersion: "reviewer-v1",
  evidence: [{ citation: "Oxford DNB", url: "https://example.test/oxford" }],
  decision: { action: "reject_battle", reason: "El desenlace importado no queda establecido." },
};

function markup(element) {
  return renderToStaticMarkup(element);
}

test("renders the empty automation state without manufacturing exceptions", () => {
  const html = markup(React.createElement(QueueSummaryView, {
    summary: { automatic: 0, exceptions: 0, failures: 0, activeLeases: 0, rankingFailures: 0, codexPlan: "No reportado", codexRateLimit: "No reportado", snapshot: null },
    cases: [],
  }));

  assert.match(html, /No hay excepciones pendientes/i);
  assert.match(html, /Automatización/i);
  assert.doesNotMatch(html, /Waterloo/i);
});

test("renders disagreement and failed cases ahead of automatic work", () => {
  const html = markup(React.createElement(QueueSummaryView, {
    summary: { automatic: 9, exceptions: 1, failures: 1, activeLeases: 2, rankingFailures: 1, codexPlan: "ChatGPT Pro", codexRateLimit: "Restan 42 solicitudes", snapshot: { dataRevision: "data-v7", algorithmVersion: "elo-v1", createdAt: "2026-08-25T10:00:00Z" } },
    cases: [disagreement, { ...disagreement, id: 42, caseKey: "failed-import", status: "failed", lastError: "respuesta no válida" }],
  }));

  assert.match(html, /Esperando decisión humana/i);
  assert.match(html, /Fallo técnico/i);
  assert.match(html, /Arrendamientos activos/i);
  assert.match(html, /ChatGPT Pro/i);
  assert.match(html, /data-v7/i);
});

test("renders evidence, both independent reviews, a structural diff, and human actions", () => {
  const html = markup(React.createElement(CaseReviewView, {
    caseItem: disagreement,
    reviews: [proposer, reviewer],
    sources: [{ citation: "Chandler, p. 1021", url: "https://example.test/chandler" }, { citation: "Oxford DNB", url: "https://example.test/oxford" }],
    action: async () => {},
  }));

  for (const label of ["Propuesta", "Revisión independiente", "Diferencia estructural", "Aprobar corrección", "Rechazar", "Fusionar", "Separar", "Reintentar"]) {
    assert.match(html, new RegExp(label, "i"));
  }
  assert.match(html, /https:\/\/example\.test\/chandler/);
  assert.match(html, /approve_battle/);
  assert.match(html, /reject_battle/);
});

test("renders proposed merges, completed publications, ranking failures, and reversible history", () => {
  const html = markup(React.createElement(EventHistoryView, {
    events: [{ id: 8, action: "merge_commanders", actorType: "ai", actorId: "worker-1", reason: "Identidad coincidente", createdAt: "2026-08-25T08:00:00Z", revertsEventId: null, reversible: true }],
    rankingJobs: [{ id: 4, status: "failed", algorithmVersion: "elo-v1", lastError: "entrada incompleta" }],
    action: async () => {},
  }));

  assert.match(html, /merge_commanders/);
  assert.match(html, /Ranking pendiente de recuperación/i);
  assert.match(html, /Revertir publicación/i);
});

test("does not offer reversal for a non-canonical history event", () => {
  const html = markup(React.createElement(EventHistoryView, {
    events: [{ id: 9, action: "retry", actorType: "human", actorId: "owner", reason: "Reintento", createdAt: "2026-08-25T09:00:00Z", revertsEventId: null, reversible: false }],
    rankingJobs: [], action: async () => {},
  }));
  assert.doesNotMatch(html, /Revertir publicación/i);
  assert.match(html, /No reversible/i);
});

test("uses mobile-safe markup rather than a fixed-width queue table", () => {
  const html = markup(React.createElement(QueueSummaryView, {
    summary: { automatic: 1, exceptions: 1, failures: 0, activeLeases: 0, rankingFailures: 0, codexPlan: "No reportado", codexRateLimit: "No reportado", snapshot: null },
    cases: [disagreement],
  }));

  assert.match(html, /curation-queue/);
  assert.match(html, /aria-label="Excepciones de curación"/);
  assert.doesNotMatch(html, /<table/);
});

test("identifies a proposed merge as a material structural difference", () => {
  assert.deepEqual(createStructuralDiff(
    { action: "merge_commanders", canonicalMutation: { action: "merge_commanders", source: { id: "a" }, target: { id: "b" } } },
    { action: "separate_commanders", canonicalMutation: { action: "separate_commanders", source: { id: "a" }, target: { id: "b" } } },
  ), ["action", "canonicalMutation.action"]);
});

test("does not render executable or data URL evidence as a link", () => {
  const html = markup(React.createElement(CaseReviewView, {
    caseItem: disagreement,
    reviews: [proposer, reviewer],
    sources: [
      { citation: "Unsafe", url: "javascript:alert(1)" },
      { citation: "Encoded unsafe", url: "data:text/html,alert(1)" },
      { citation: "Safe", url: "https://example.test/safe" },
    ],
    action: async () => {},
  }));
  assert.doesNotMatch(html, /href="(?:javascript|data):[^>]*>Unsafe</i);
  assert.doesNotMatch(html, /href="(?:javascript|data):[^>]*>Encoded unsafe</i);
  assert.match(html, /href="https:\/\/example\.test\/safe"/);
  assert.match(html, /Unsafe/);
});
