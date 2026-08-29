import { createClient } from "../../lib/supabase/server";

export type CurationCase = {
  id: number;
  caseKey: string;
  entityType: string;
  sourceRevision: string;
  status: string;
  priority: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown>;
};

type Review = {
  reviewRole: string;
  model: string;
  promptVersion: string;
  evidence: Array<Record<string, unknown>>;
  decision: Record<string, unknown>;
};

type EditorialEvent = {
  id: number;
  caseId: number;
  actorType: string;
  actorId: string | null;
  action: string;
  reason: string | null;
  createdAt: string;
  revertsEventId: number | null;
  reversible: boolean;
};

type RankingJob = {
  id: number;
  status: string;
  algorithmVersion: string;
  lastError: string | null;
};

function mapCase(value: Record<string, unknown>): CurationCase {
  return {
    id: Number(value.id), caseKey: String(value.case_key), entityType: String(value.entity_type),
    sourceRevision: String(value.source_revision), status: String(value.status), priority: Number(value.priority),
    leaseOwner: typeof value.lease_owner === "string" ? value.lease_owner : null,
    leaseExpiresAt: typeof value.lease_expires_at === "string" ? value.lease_expires_at : null,
    attemptCount: Number(value.attempt_count), lastError: typeof value.last_error === "string" ? value.last_error : null,
    createdAt: String(value.created_at), updatedAt: String(value.updated_at),
    payload: value.payload && typeof value.payload === "object" && !Array.isArray(value.payload) ? value.payload as Record<string, unknown> : {},
  };
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function mapReview(value: Record<string, unknown>): Review {
  return {
    reviewRole: String(value.review_role), model: String(value.model), promptVersion: String(value.prompt_version),
    evidence: Array.isArray(value.evidence) ? value.evidence as Array<Record<string, unknown>> : [],
    decision: value.decision && typeof value.decision === "object" && !Array.isArray(value.decision) ? value.decision as Record<string, unknown> : {},
  };
}

function sourceList(payload: Record<string, unknown>, reviews: Review[]) {
  const items: Array<Record<string, unknown>> = [];
  const payloadSources = payload.sources;
  if (Array.isArray(payloadSources)) items.push(...payloadSources.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))));
  reviews.forEach((review) => items.push(...review.evidence));
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.url ?? ""}|${item.citation ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => ({ citation: typeof item.citation === "string" ? item.citation : "Fuente sin cita", url: safeHttpUrl(item.url) }));
}

export async function loadDashboard() {
  const supabase = await createClient();
  const activeLeaseTime = new Date().toISOString();
  const [queueResult, automaticResult, exceptionsResult, failuresResult, leasesResult, rankingFailuresResult, snapshotResult] = await Promise.all([
    supabase.from("curation_cases").select("id,case_key,entity_type,source_revision,status,priority,lease_owner,lease_expires_at,attempt_count,last_error,created_at,updated_at,payload").in("status", ["awaiting_human", "failed"]).order("priority", { ascending: false }).order("updated_at", { ascending: false }).limit(50),
    supabase.from("curation_cases").select("id", { count: "exact", head: true }).in("status", ["pending", "leased", "approved", "published"]),
    supabase.from("curation_cases").select("id", { count: "exact", head: true }).eq("status", "awaiting_human"),
    supabase.from("curation_cases").select("id", { count: "exact", head: true }).eq("status", "failed"),
    supabase.from("curation_cases").select("id", { count: "exact", head: true }).eq("status", "leased").gt("lease_expires_at", activeLeaseTime),
    supabase.from("ranking_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
    supabase.from("ranking_snapshots").select("data_revision,algorithm_version,created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const result of [queueResult, automaticResult, exceptionsResult, failuresResult, leasesResult, rankingFailuresResult, snapshotResult]) {
    if (result.error) throw new Error("No se pudo cargar el panel de curación.");
  }
  return {
    cases: ((queueResult.data ?? []) as Array<Record<string, unknown>>).map(mapCase),
    summary: {
      automatic: automaticResult.count ?? 0, exceptions: exceptionsResult.count ?? 0, failures: failuresResult.count ?? 0,
      activeLeases: leasesResult.count ?? 0, rankingFailures: rankingFailuresResult.count ?? 0,
      codexPlan: process.env.CURATION_CODEX_PLAN ?? "No reportado",
      codexRateLimit: process.env.CURATION_CODEX_RATE_LIMIT ?? "No reportado",
      snapshot: snapshotResult.data ? { dataRevision: snapshotResult.data.data_revision, algorithmVersion: snapshotResult.data.algorithm_version, createdAt: snapshotResult.data.created_at } : null,
    },
  };
}

export async function loadCaseDetail(caseId: number) {
  const supabase = await createClient();
  const [caseResult, reviewsResult, eventsResult, rankingResult] = await Promise.all([
    supabase.from("curation_cases").select("id,case_key,entity_type,source_revision,status,priority,lease_owner,lease_expires_at,attempt_count,last_error,created_at,updated_at,payload").eq("id", caseId).maybeSingle(),
    supabase.from("ai_reviews").select("review_role,model,prompt_version,evidence,decision").eq("case_id", caseId).order("created_at", { ascending: true }),
    supabase.from("editorial_events").select("id,case_id,actor_type,actor_id,action,reason,created_at,reverts_event_id,before_state,after_state").eq("case_id", caseId).order("created_at", { ascending: false }),
    supabase.from("ranking_jobs").select("id,status,algorithm_version,last_error,editorial_events!inner(case_id)").eq("editorial_events.case_id", caseId).order("created_at", { ascending: false }),
  ]);
  if (caseResult.error || reviewsResult.error || eventsResult.error || rankingResult.error || !caseResult.data) return null;
  const caseItem = mapCase(caseResult.data as Record<string, unknown>);
  const reviews = ((reviewsResult.data ?? []) as Array<Record<string, unknown>>).map(mapReview);
  return {
    caseItem, reviews, sources: sourceList(caseItem.payload, reviews),
    events: ((eventsResult.data ?? []) as Array<Record<string, unknown>>).map((value) => {
      const action = String(value.action);
      const hasSnapshots = Boolean(value.before_state && value.after_state);
      return {
        id: Number(value.id), caseId: Number(value.case_id), actorType: String(value.actor_type), actorId: typeof value.actor_id === "string" ? value.actor_id : null, action, reason: typeof value.reason === "string" ? value.reason : null, createdAt: String(value.created_at), revertsEventId: typeof value.reverts_event_id === "number" ? value.reverts_event_id : null,
        reversible: hasSnapshots && ["approve_battle", "merge_commanders", "separate_commanders"].includes(action) && value.reverts_event_id === null,
      } satisfies EditorialEvent;
    }),
    rankingJobs: ((rankingResult.data ?? []) as Array<Record<string, unknown>>).map((value) => ({ id: Number(value.id), status: String(value.status), algorithmVersion: String(value.algorithm_version), lastError: typeof value.last_error === "string" ? value.last_error : null } satisfies RankingJob)),
  };
}
