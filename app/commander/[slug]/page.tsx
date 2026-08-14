import Link from "next/link";
import { battlesForCommander, commanders, getCommander } from "../../../lib/commanders.mjs";

export function generateStaticParams(){return commanders.map(commander=>({slug:commander.id}));}
const displayYear = (year:number) => year < 0 ? `${Math.abs(year)} a. C.` : String(year);

export default async function CommanderPage({params}:{params:Promise<{slug:string}>}) {
  const {slug}=await params;
  const commander=getCommander(slug);
  if(!commander)return <main className="page-shell"><h1>Comandante no encontrado</h1><Link href="/commanders">Volver al archivo</Link></main>;
  const encounters=battlesForCommander(slug);
  return <main className="page-shell profile-page">
    <header className="profile-hero"><div className="profile-monogram">{commander.shortName.slice(0,1)}</div><div><p className="eyebrow">{commander.era} · {commander.domain}</p><h1>{commander.name}</h1><p className="profile-meta">{commander.nation} · {commander.years}</p><p>{commander.summary}</p></div></header>
    <section className="rating-cards"><article><span>Histórico</span><strong>{commander.ratings.historical}</strong></article><article><span>Ajustado</span><strong>{commander.ratings.adjusted}</strong></article><article><span>Táctico</span><strong>{commander.ratings.tactical}</strong></article><article><span>Estratégico</span><strong>{commander.ratings.strategic}</strong></article></section>
    <div className="profile-columns"><section className="content-panel"><h2>Encuentros documentados</h2><div className="profile-battles">{encounters.map(battle=>{const opponent=getCommander(battle.a===slug?battle.b:battle.a);return <article key={battle.id}><time>{displayYear(battle.year)}</time><div><strong>{battle.name}</strong><p>contra <Link href={`/commander/${opponent?.id}`}>{opponent?.name}</Link></p></div><span>{battle.outcome}</span></article>})}</div></section><aside className="content-panel confidence-card"><h2>Confianza de los datos</h2><strong>{commander.confidence}%</strong><i style={{"--confidence":`${commander.confidence}%`} as React.CSSProperties}/><p>{commander.sources} referencias ilustrativas asociadas al perfil. La cifra mide cobertura del prototipo, no consenso académico.</p><Link href="/methodology">Ver metodología</Link></aside></div>
  </main>;
}
