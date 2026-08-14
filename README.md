# Commander Elo

[Commander Elo](https://alexx-ftw.github.io/commander-elo/) es un prototipo público en español para explorar comparaciones históricas entre comandantes mediante resultados, contexto y redes de enfrentamientos.

> **Datos provisionales:** la muestra, los conteos de fuentes y las puntuaciones actuales son datos de demostración. No son conclusiones históricas ni una clasificación definitiva.

## Qué incluye

- Ranking histórico y modos de comparación ajustado, táctico y estratégico.
- Perfiles de comandantes y sus enfrentamientos registrados.
- Explorador de red para encontrar conexiones entre comandantes.
- Página de metodología que explica el uso del Elo, la evidencia y la incertidumbre.

## Datos y cálculo

Los datos de demostración están en [`lib/commanders.mjs`](lib/commanders.mjs): contiene los perfiles de comandantes, los encuentros y las puntuaciones mostradas por el prototipo. Las páginas consumen ese módulo y la metodología se presenta en [`app/methodology/page.tsx`](app/methodology/page.tsx).

Las correcciones se tratan como cambios de evidencia y de datos, no como ediciones manuales de una puntuación. Cuando se acepta evidencia, se revisan los encuentros y sus atributos y se recalcula el Elo con el conjunto actualizado.

## Desarrollo local

Requiere Node.js 22 o posterior.

```bash
npm ci
npm run dev
```

Para comprobar la exportación estática que publica GitHub Pages:

```bash
npm run build:pages
node --test tests/pages-export.test.mjs
```

También están disponibles `npm test` y `npm run lint` para las comprobaciones del proyecto.

## Cómo contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para proponer una corrección de datos, añadir un comandante o aportar una fuente. Para una corrección concreta, abre el formulario de [corrección de datos](../../issues/new?template=data-correction.yml) con la fuente y la justificación.

Aceptamos pull requests pequeños y verificables. Antes de abrir un pull request, explica qué evidencia cambia, actualiza los datos correspondientes y ejecuta las comprobaciones relevantes.

## Alcance

Commander Elo es una herramienta comparativa experimental. Conserva la incertidumbre visible, evita convertir estimaciones provisionales en afirmaciones históricas y agradece fuentes que permitan revisar los casos discutibles.
