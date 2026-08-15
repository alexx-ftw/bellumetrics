const steps = [
  ["1", "Registrar el encuentro", "Fecha, participantes, escala, tipo de acción, resultado y fuentes."],
  ["2", "Estimar la evidencia", "La confianza refleja cantidad, calidad y acuerdo entre las fuentes."],
  ["3", "Actualizar el Elo", "El resultado mueve la puntuación según la diferencia previa y el peso del encuentro."],
  ["4", "Mostrar incertidumbre", "Los datos incompletos y las decisiones discutibles permanecen visibles."],
];

export default function MethodologyPage() {
  return <main className="page-shell methodology">
    <header className="page-heading"><p className="eyebrow">Modelo abierto y revisable</p><h1>Metodología</h1><p>El Commander Elo de Bellumetrics es un instrumento comparativo, no una sentencia sobre quién fue el mejor comandante de la historia.</p></header>
    <section className="method-grid">{steps.map(([number,title,text])=><article key={number}><span>{number}</span><h2>{title}</h2><p>{text}</p></article>)}</section>
    <section className="prose-panel"><h2>Dos familias de puntuación</h2><div className="two-columns"><div><h3>Elo histórico</h3><p>Parte del resultado documentado de cada encuentro. Premia vencer a rivales mejor valorados y reduce el efecto de resultados esperables.</p></div><div><h3>Elo ajustado</h3><p>Explora correcciones por recursos, localización, experiencia, calidad de la evidencia y otras ventajas previas.</p></div></div><h2>Qué significa provisional</h2><p>La demostración actual usa una muestra pequeña y puntuaciones diseñadas para probar la interfaz. Antes de tratarlas como resultados históricos habría que ampliar las fuentes, definir reglas editoriales, publicar el cálculo y someter los casos dudosos a revisión.</p><h2>Incertidumbre y redes desconectadas</h2><p>Una conexión indirecta demuestra relación dentro del grafo, pero no garantiza comparabilidad perfecta. Si dos grupos no comparten oponentes, sus Elo pueden ordenarse visualmente aunque la evidencia no permita una comparación fuerte.</p></section>
  </main>;
}
