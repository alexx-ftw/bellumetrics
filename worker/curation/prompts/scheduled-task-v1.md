# Bellumetrics scheduled curation: scheduled-task-v1

Procesa una sola iteración auditable de Bellumetrics y termina. Usa únicamente
los conectores ya autorizados de GitHub y Supabase. Trabaja solo con el proyecto
Supabase `dggbwsgoddbrxvojjojy` y el repositorio
`alexx-ftw/bellumetrics`. Como máximo un caso de curación y un trabajo de
ranking por ejecución.

## Precondiciones

1. Haz primero una lectura inocua de ambos conectores. Si falta acceso, el
   proyecto no coincide o no puedes identificar el modelo de esta ejecución,
   termina sin hacer ninguna mutación y explica el bloqueo.
2. Lee desde GitHub las versiones vigentes de `proposer-v1.md`,
   `reviewer-v1.md`, `contracts.mjs`, `consensus.mjs`, `elo.mjs` y
   `config.mjs`. Usa `main` cuando contenga todos esos archivos. Durante la
   aceptación previa al merge puedes usar `agent/ai-curation-implementation`.
   No mezcles archivos de refs distintos.
3. No escribas en GitHub, no ejecutes workflows y no solicites ni almacenes
   credenciales. La sesión de ChatGPT y las autorizaciones de los conectores
   pertenecen a la plataforma, no al repositorio.
4. Las únicas mutaciones permitidas son estas funciones de Supabase:
   `lease_curation_case`, `heartbeat_curation_case`, `record_ai_review`,
   `publish_curation_decision`, `release_curation_case`,
   `lease_ranking_job`, `heartbeat_ranking_job`, `read_ranking_input`,
   `complete_ranking_job` y `release_ranking_job`. No ejecutes DDL ni escrituras
   directas sobre tablas canónicas, editoriales, de autenticación o staging.

## Caso de curación

1. Genera un `worker_id` nuevo y no sensible para esta ejecución. Arrenda como
   máximo un caso con `lease_curation_case` durante 3300 segundos. Si no hay
   caso, continúa con ranking.
2. Lee las revisiones persistidas del caso con `read_curation_reviews`. Para
   cada rol ausente crea un contexto de agente completamente nuevo con el caso
   original y su prompt versionado. No muestres, reveles ni compartas la salida
   del proponente con el revisor. Si no puedes garantizar dos contextos
   independientes, libera el caso como `awaiting_human`.
3. Valida cada salida ejecutando sin modificar el contrato versionado. Renueva
   el lease antes de cada escritura. Persiste primero la revisión `proposer` y
   después la revisión `reviewer` mediante `record_ai_review`, con el identificador
   real del mismo modelo de esta ejecución y los prompt versions exactos.
4. Ejecuta `resolveConsensus` sin reinterpretarlo. Si devuelve una mutación
   ejecutable, renueva el lease y llama a `publish_curation_decision` con los dos
   IDs exactos de revisión. Si ambas revisiones rechazan la batalla, usa
   `release_curation_case` con `rejected`. Ante discrepancia, escalado explícito
   o imposibilidad de demostrar independencia, usa `release_curation_case` con
   `awaiting_human`.
5. Ante una salida inválida u otro fallo técnico, intenta `release_curation_case` con
   `technical_failure` y un mensaje breve ya saneado. Nunca incluyas payloads,
   cabeceras, sesiones, URLs firmadas ni valores de autorización en errores o
   informes.

## Ranking determinista

Después de la curación, arrenda como máximo un trabajo con
`lease_ranking_job`. Obtén su entrada únicamente con `read_ranking_input` y
ejecuta, sin reimplementarlo, `calculateSnapshot` desde el código versionado con
el `algorithm_version` del trabajo. Renueva el lease y publica exactamente su
`inputDigest` y resultado con `complete_ranking_job`. Si no puedes ejecutar el
código exacto o verificar el digest, usa `release_ranking_job` con un error
técnico saneado y no publiques un snapshot aproximado.

## Informe

Devuelve solo el ref de GitHub usado, IDs no sensibles, estados finales y el
resultado de cada comprobación. No incluyas datos históricos completos,
razonamientos privados, secretos ni contenido de sesión. Si no había trabajo,
indica `idle`.
