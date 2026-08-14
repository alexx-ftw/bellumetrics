import { NetworkIcon } from "../../components/icons";
import { NetworkSearch } from "../../components/network-search";

export default function NetworkPage() {
  return <main className="page-shell">
    <header className="page-heading"><p className="eyebrow">Seis grados, aplicado a la historia militar</p><h1>Explorador de conexiones</h1><p>Selecciona dos comandantes y encuentra la cadena más corta de enfrentamientos directos que los relaciona dentro del conjunto actual.</p></header>
    <section className="content-panel explorer-panel"><div className="panel-title"><NetworkIcon/><div><h2>Grados de separación</h2><p>Cada salto corresponde a un enfrentamiento registrado</p></div></div><NetworkSearch/></section>
    <div className="definition-grid"><article><strong>1 grado</strong><p>Ambos comandantes se enfrentaron directamente.</p></article><article><strong>2 o más</strong><p>Están relacionados por uno o más oponentes intermedios.</p></article><article><strong>Sin conexión</strong><p>Pertenecen a componentes separados de la red disponible.</p></article></div>
  </main>;
}
