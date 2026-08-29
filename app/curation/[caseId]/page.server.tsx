import { notFound } from "next/navigation";
import { CaseReview } from "../../../components/curation/case-review";
import { EventHistory } from "../../../components/curation/event-history";
import { performCurationAction } from "../actions";
import { loadCaseDetail } from "../data";

export const dynamic = "force-dynamic";

export default async function CurationCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId: value } = await params;
  if (!/^\d+$/.test(value)) notFound();
  const detail = await loadCaseDetail(Number(value));
  if (!detail) notFound();
  return <main className="page-shell">
    <CaseReview caseItem={detail.caseItem} reviews={detail.reviews} sources={detail.sources} action={performCurationAction} />
    <EventHistory events={detail.events} rankingJobs={detail.rankingJobs} action={performCurationAction} />
  </main>;
}
