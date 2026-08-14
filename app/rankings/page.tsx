import { RankingTable } from "../../components/ranking-table";
import { commanders } from "../../lib/commanders.mjs";

export default function RankingsPage() {
  return <main className="page-shell">
    <header className="page-heading"><p className="eyebrow">Resultados comparables</p><h1>Ranking de comandantes</h1><p>Cuatro lecturas provisionales del mismo conjunto de datos. Cambia de criterio para ver cuánto depende una posición del resultado, el contexto, la táctica o la estrategia.</p></header>
    <section className="content-panel page-ranking"><RankingTable limit={commanders.length}/></section>
    <aside className="caveat"><strong>Lectura responsable:</strong> un Elo compara resultados dentro de una red de oponentes. No convierte épocas, recursos y fuentes desiguales en certezas.</aside>
  </main>;
}
