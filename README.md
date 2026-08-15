# Bellumetrics

**Military history, measured.**

[Bellumetrics](https://alexx-ftw.github.io/bellumetrics/) es un prototipo público en español para explorar la historia militar mediante datos, fuentes, rankings y redes de enfrentamientos. **Commander Elo** es su ranking principal de comandantes.

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

## Base de datos e importación histórica

La migración inicial de Supabase está en
[`supabase/migrations/202608150001_wiki_data_foundation.sql`](supabase/migrations/202608150001_wiki_data_foundation.sql).
Separa las entidades históricas canónicas de las importaciones pendientes de revisión y aplica RLS para que el navegador solo pueda leer contenido publicado.

Después de aplicar la migración en un proyecto Supabase, configura estas variables únicamente en un entorno de servidor seguro:

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
npm run import:war-atlas
```

El importador descarga el manifiesto y el catálogo JSON de [The War Atlas](https://thewaratlas.co/data), valida su licencia CC BY 4.0 y guarda los registros en `import_runs` e `import_records`. Es idempotente por versión y nunca publica directamente comandantes, batallas ni resultados. La clave `service_role` no debe exponerse en variables públicas, GitHub Pages ni código del navegador.

La reutilización conserva la atribución requerida: **The War Atlas — thewaratlas.co**.

## Cómo contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para proponer una corrección de datos, añadir un comandante o aportar una fuente. Para una corrección concreta, abre el formulario de [corrección de datos](../../issues/new?template=data-correction.yml) con la fuente y la justificación.

Aceptamos pull requests pequeños y verificables. Antes de abrir un pull request, explica qué evidencia cambia, actualiza los datos correspondientes y ejecuta las comprobaciones relevantes.

## Alcance

Bellumetrics es una plataforma histórica experimental. Conserva la incertidumbre visible, evita convertir estimaciones provisionales en afirmaciones históricas y agradece fuentes que permitan revisar los casos discutibles.
