import Link from "next/link";
import { commanders } from "../../lib/commanders.mjs";

export default function CommandersPage() {
  return <main className="page-shell"><header className="page-heading"><p className="eyebrow">Archivo de demostración</p><h1>Comandantes</h1><p>Explora los perfiles que forman la red inicial.</p></header><section className="commander-grid">{commanders.map(commander=><Link href={`/commander/${commander.id}`} key={commander.id}><span>{commander.shortName.slice(0,1)}</span><div><strong>{commander.name}</strong><small>{commander.nation} · {commander.years}</small><p>{commander.summary}</p></div></Link>)}</section></main>;
}
