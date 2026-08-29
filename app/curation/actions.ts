"use server";

import { forbidden } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "../../lib/supabase/server";

const ACTIONS = new Set(["approve_corrected", "reject", "merge", "separate", "retry", "revert"]);
const MAX_REASON_LENGTH = 2000;
const MAX_MUTATION_LENGTH = 40_000;

function positiveId(value: FormDataEntryValue | null, label: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${label} no es válido.`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} no es válido.`);
  return id;
}

function requiredText(value: FormDataEntryValue | null, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`${label} no es válido.`);
  return value.trim();
}

function optionalMutation(value: FormDataEntryValue | null): Record<string, unknown> | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_MUTATION_LENGTH) throw new Error("La mutación es demasiado extensa.");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("La mutación debe ser JSON estructurado.");
  }
}

async function requireOwner() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || typeof userId !== "string") forbidden();
  const { data: membership, error: membershipError } = await supabase
    .from("curator_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();
  if (membershipError || !membership) forbidden();
  return supabase;
}

export async function performCurationAction(formData: FormData) {
  const caseId = positiveId(formData.get("caseId"), "El caso");
  const action = requiredText(formData.get("action"), "La acción", 40);
  if (!ACTIONS.has(action)) throw new Error("La acción no está permitida.");
  const reason = requiredText(formData.get("reason"), "El motivo", MAX_REASON_LENGTH);
  const mutation = optionalMutation(formData.get("mutation"));
  const eventId = formData.get("eventId") === null ? null : positiveId(formData.get("eventId"), "El evento");
  if (action === "approve_corrected" && !mutation) throw new Error("La corrección necesita una mutación estructurada.");
  if ((action === "merge" || action === "separate") && !mutation) throw new Error("La decisión de identidad necesita una mutación estructurada.");
  if (action === "revert" && !eventId) throw new Error("La reversión necesita una publicación.");

  const supabase = await requireOwner();
  const { data, error } = await supabase.rpc("owner_curation_action", {
    p_case_id: caseId,
    p_action: action,
    p_mutation: mutation ? { mutation, eventId } : eventId ? { eventId } : {},
    p_reason: reason,
  });
  if (error || !data) throw new Error("No se pudo registrar la decisión de curación.");
  revalidatePath("/curation");
  revalidatePath(`/curation/${caseId}`);
  return data;
}
