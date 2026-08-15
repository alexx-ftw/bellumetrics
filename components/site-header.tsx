import Link from "next/link";
import {CrownMark} from "./icons";
const nav=[["Rankings","/rankings"],["Comandantes","/rankings#comandantes"],["Batallas","/rankings#batallas"],["Red histórica","/network"],["Metodología","/methodology"]];
export function SiteHeader(){return <header className="site-header"><nav className="nav-shell" aria-label="Navegación principal"><Link className="brand" href="/" aria-label="Bellumetrics, inicio"><CrownMark className="brand-mark"/><span><strong>BELLUMETRICS</strong><small>Military history, measured.</small></span></Link><div className="nav-links">{nav.map(([label,href])=><Link key={href} href={href}>{label}</Link>)}</div></nav></header>}
