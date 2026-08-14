import Link from "next/link";
import { battles, getCommander } from "../../lib/commanders.mjs";

const displayYear = (year:number) => year < 0 ? `${Math.abs(year)} a. C.` : String(year);

export default function BattlesPage() {
  return <main className="page-shell"><header className="page-heading"><p className="eyebrow">Enlaces de la red</p><h1>Batallas y campañas</h1><p>Cada registro crea una relación directa entre dos participantes.</p></header><section className="battle-list">{battles.toSorted((a,b)=>b.year-a.year).map(battle=>{const a=getCommander(battle.a);const b=getCommander(battle.b);return <article key={battle.id}><time>{displayYear(battle.year)}</time><div><h2>{battle.name}</h2><p><Link href={`/commander/${a?.id}`}>{a?.name}</Link><span>contra</span><Link href={`/commander/${b?.id}`}>{b?.name}</Link></p></div><div className="battle-result"><strong>{battle.outcome}</strong><small>{battle.confidence}% confianza</small></div></article>})}</section></main>;
}
