import { forbidden, redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { QueueSummary } from "../../components/curation/queue-summary";
import { loadDashboard } from "./data";

export const dynamic = "force-dynamic";

export default async function CurationPage() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || !userId) redirect("/login?return_to=%2Fcuration");
  const { data: membership, error: membershipError } = await supabase
    .from("curator_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();
  if (membershipError || !membership) forbidden();
  const dashboard = await loadDashboard();
  return <main className="page-shell"><QueueSummary {...dashboard} /></main>;
}
