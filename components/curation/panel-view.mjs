import { createElement as h } from "react";

const STATUS_LABELS = {
  awaiting_human: "Esperando decisión humana",
  failed: "Fallo técnico",
  pending: "Pendiente de automatización",
  leased: "En revisión automática",
  approved: "Aprobado por curación",
  rejected: "Rechazado",
  published: "Publicado",
};

function text(value, fallback = "—") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function safeExternalUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function when(value) {
  if (!value) return "Sin registro";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Sin registro" : new Intl.DateTimeFormat("es", {
    dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function paths(left, right, prefix = "") {
  if (Object.is(left, right)) return [];
  const leftObject = left && typeof left === "object" && !Array.isArray(left);
  const rightObject = right && typeof right === "object" && !Array.isArray(right);
  if (!leftObject || !rightObject) return [prefix || "valor"];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => paths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

export function createStructuralDiff(proposal = {}, review = {}) {
  return paths(stable(proposal), stable(review));
}

function Stat({ value, label, detail }) {
  return h("article", { className: "curation-stat" },
    h("strong", null, String(value)),
    h("span", null, label),
    h("small", null, detail),
  );
}

function Status({ value }) {
  return h("span", { className: `curation-status status-${value}` }, STATUS_LABELS[value] ?? value);
}

export function QueueSummaryView({ summary, cases }) {
  const snapshot = summary.snapshot;
  return h("section", { className: "curation-dashboard", "aria-label": "Panel de curación" },
    h("div", { className: "page-heading curation-heading" },
      h("h1", null, "Curación privada"),
      h("p", null, "Excepciones, fallos y decisiones humanas. La cola se limita por defecto a los casos que necesitan intervención."),
    ),
    h("div", { className: "curation-stats", "aria-label": "Resumen de automatización" },
      h(Stat, { value: summary.exceptions, label: "Excepciones", detail: "Esperando criterio humano" }),
      h(Stat, { value: summary.failures, label: "Fallos", detail: "Casos que requieren recuperación" }),
      h(Stat, { value: summary.automatic, label: "Automatización", detail: "Pendientes, arrendados o publicados" }),
      h(Stat, { value: summary.activeLeases, label: "Arrendamientos activos", detail: "Workers con caso reservado" }),
    ),
    h("div", { className: "curation-context" },
      h("article", null, h("span", null, "Plan de Codex"), h("strong", null, text(summary.codexPlan))),
      h("article", null, h("span", null, "Límite reportado"), h("strong", null, text(summary.codexRateLimit))),
      h("article", null, h("span", null, "Último snapshot"), h("strong", null, snapshot ? `${text(snapshot.dataRevision)} · ${text(snapshot.algorithmVersion)}` : "Aún no publicado"), h("small", null, snapshot ? when(snapshot.createdAt) : "")),
      h("article", null, h("span", null, "Ranking"), h("strong", null, summary.rankingFailures ? `${summary.rankingFailures} pendiente${summary.rankingFailures === 1 ? "" : "s"}` : "Sin fallos reportados")),
    ),
    h("section", { className: "primary-panel curation-queue", "aria-label": "Excepciones de curación" },
      h("div", { className: "panel-title" }, h("div", null, h("h2", null, "Cola de excepciones"), h("p", null, "awaiting_human y failed"))),
      cases.length === 0
        ? h("p", { className: "curation-empty" }, "No hay excepciones pendientes. La automatización no ha requerido intervención humana.")
        : h("ol", { className: "curation-case-list" }, cases.map((item) => h("li", { key: item.id },
          h("a", { href: `/curation/${item.id}` },
            h("div", null, h(Status, { value: item.status }), h("strong", null, text(item.payload?.title, item.caseKey)), h("small", null, `${item.entityType} · prioridad ${item.priority} · ${text(item.sourceRevision)}`)),
            h("time", { dateTime: item.updatedAt }, when(item.updatedAt)),
          ),
          item.lastError ? h("p", null, text(item.lastError)) : null,
        ))),
    ),
  );
}

function EvidenceList({ sources }) {
  return h("ul", { className: "curation-evidence" }, sources.length
    ? sources.map((source, index) => {
      const href = safeExternalUrl(source.url);
      return h("li", { key: `${source.url ?? source.citation}-${index}` }, href
      ? h("a", { href, target: "_blank", rel: "noreferrer" }, text(source.citation, href))
      : text(source.citation));
    })
    : h("li", null, "No se registraron enlaces de fuente."));
}

function Review({ review }) {
  const decision = review.decision ?? {};
  return h("article", { className: "curation-review" },
    h("header", null, h("h3", null, review.reviewRole === "proposer" ? "Propuesta" : "Revisión independiente"), h("small", null, `${text(review.model)} · ${text(review.promptVersion)}`)),
    h("p", null, text(decision.reason, "Sin razonamiento estructurado.")),
    h("dl", null, h("div", null, h("dt", null, "Acción"), h("dd", null, text(decision.action))), h("div", null, h("dt", null, "Mutación"), h("dd", null, h("code", null, decision.canonicalMutation ? JSON.stringify(decision.canonicalMutation) : "Sin mutación")))),
    h(EvidenceList, { sources: Array.isArray(review.evidence) ? review.evidence : [] }),
  );
}

function ActionForm({ action, caseId, label, kind, mutation, needsMutation = false, eventId }) {
  const mutationValue = mutation ?? (needsMutation ? {} : null);
  return h("form", { action, className: "curation-action" },
    h("input", { type: "hidden", name: "caseId", value: caseId }),
    h("input", { type: "hidden", name: "action", value: kind ?? (mutation ? "approve_corrected" : "retry") }),
    mutationValue ? h("textarea", { name: "mutation", defaultValue: JSON.stringify(mutationValue, null, 2), "aria-label": "Mutación corregida en JSON" }) : null,
    eventId ? h("input", { type: "hidden", name: "eventId", value: eventId }) : null,
    h("input", { name: "reason", required: true, maxLength: 2000, placeholder: "Motivo registrado en auditoría", "aria-label": `Motivo para ${label}` }),
    h("button", { type: "submit" }, label),
  );
}

export function CaseReviewView({ caseItem, reviews, sources, action }) {
  const proposal = reviews.find((review) => review.reviewRole === "proposer")?.decision ?? {};
  const independent = reviews.find((review) => review.reviewRole === "reviewer")?.decision ?? {};
  const diff = createStructuralDiff(proposal, independent);
  return h("section", { className: "curation-detail", "aria-label": "Detalle de curación" },
    h("div", { className: "page-heading curation-heading" }, h("a", { href: "/curation", className: "curation-back" }, "Volver a la cola"), h("h1", null, text(caseItem.payload?.title, caseItem.caseKey)), h(Status, { value: caseItem.status }), h("p", null, `${caseItem.entityType} · revisión ${text(caseItem.sourceRevision)} · actualizado ${when(caseItem.updatedAt)}`)),
    h("div", { className: "curation-detail-grid" },
      h("section", { className: "content-panel" }, h("h2", null, "Evidencia y fuentes"), h(EvidenceList, { sources })),
      h("section", { className: "content-panel" }, h("h2", null, "Diferencia estructural"), diff.length ? h("ul", { className: "curation-diff" }, diff.map((path) => h("li", { key: path }, h("code", null, path)))) : h("p", null, "Las revisiones coinciden estructuralmente.")),
    ),
    h("section", { className: "curation-reviews" }, reviews.map((review) => h(Review, { key: review.reviewRole, review }))),
    h("section", { className: "content-panel" }, h("h2", null, "Decisión humana"),
      h("div", { className: "curation-actions" },
        h(ActionForm, { action, caseId: caseItem.id, label: "Aprobar corrección", kind: "approve_corrected", mutation: proposal.canonicalMutation, needsMutation: true }),
        h(ActionForm, { action, caseId: caseItem.id, label: "Rechazar", kind: "reject" }),
        h(ActionForm, { action, caseId: caseItem.id, label: "Fusionar", kind: "merge", mutation: proposal.canonicalMutation?.action === "merge_commanders" ? proposal.canonicalMutation : null, needsMutation: true }),
        h(ActionForm, { action, caseId: caseItem.id, label: "Separar", kind: "separate", mutation: proposal.canonicalMutation?.action === "separate_commanders" ? proposal.canonicalMutation : null, needsMutation: true }),
        h(ActionForm, { action, caseId: caseItem.id, label: "Reintentar", kind: "retry" }),
      ),
    ),
  );
}

export function EventHistoryView({ events, rankingJobs, action }) {
  return h("section", { className: "content-panel curation-history", "aria-label": "Historial de publicaciones" },
    h("h2", null, "Historial de publicaciones"),
    events.length ? h("ol", null, events.map((event) => h("li", { key: event.id },
      h("div", null, h("strong", null, text(event.action)), h("span", null, `${text(event.actorType)} · ${text(event.actorId)} · ${when(event.createdAt)}`), event.reason ? h("p", null, event.reason) : null),
      event.reversible ? h(ActionForm, { action, caseId: event.caseId, eventId: event.id, label: "Revertir publicación", kind: "revert" }) : h("small", null, event.revertsEventId ? "Ya revertido" : "No reversible"),
    ))) : h("p", null, "Todavía no hay publicaciones auditadas para este caso."),
    rankingJobs.filter((job) => job.status === "failed").map((job) => h("p", { className: "curation-ranking-failure", key: job.id }, `Ranking pendiente de recuperación: ${text(job.algorithmVersion)} · ${text(job.lastError)}`)),
  );
}
