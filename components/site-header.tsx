import Link from "next/link";
import {CrownMark} from "./icons";
const nav=[["Rankings","/rankings"],["Comandantes","/rankings#comandantes"],["Batallas","/rankings#batallas"],["Red histórica","/network"],["Metodología","/methodology"]];
export function SiteHeader(){return <header className="site-header"><nav className="nav-shell" aria-label="Navegación principal"><Link className="brand" href="/" aria-label="Commander Elo, inicio"><CrownMark className="brand-mark"/><span><strong>COMMANDER ELO</strong><small>Ranking histórico y análisis de conexiones</small></span></Link><div className="nav-links">{nav.map(([label,href])=><Link key={href} href={href}>{label}</Link>)}</div></nav></header>}
