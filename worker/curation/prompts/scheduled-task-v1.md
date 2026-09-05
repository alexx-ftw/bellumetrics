# Bellumetrics scheduled curation: scheduled-task-v1

Procesa una sola iteración auditable de Bellumetrics y termina. Usa los conectores ya autorizados de GitHub y Supabase para acceder a estos servicios. Puedes usar agentes independientes y búsqueda web para investigar fuentes, y ejecución local para ejecutar los módulos versionados sin modificarlos. Trabaja solo con el proyecto
Supabase `dggbwsgoddbrxvojjojy` y el repositorio
`alexx-ftw/bellumetrics`. Como máximo un caso de curación y un trabajo de
ranking por ejecución.

## Precondiciones

1. Haz primero una lectura inocua de ambos conectores. Si falta acceso, el
   proyecto no coincide o no puedes seleccionar explícitamente el modelo y esfuerzo de los agentes,
   termina sin hacer ninguna mutación y explica el bloqueo.
2. Lee desde GitHub las versiones vigentes de `proposer-v1.md`,
   `reviewer-v1.md`, `contracts.mjs`, `consensus.mjs`, `elo.mjs` y
   `config.mjs`. Usa `main` cuando contenga todos esos archivos. Durante la
   aceptación previa al merge puedes usar `agent/ai-curation-implementation`.
   Resuelve el ref a un commit SHA y lee todos los archivos desde ese SHA; registra también sus hashes. No mezcles archivos de refs distintos.
3. No escribas en GitHub, no ejecutes workflows y no solicites ni almacenes
   credenciales. La sesión de ChatGPT y las autorizaciones de los conectores
   pertenecen a la plataforma, no al repositorio.
4. Las únicas mutaciones permitidas son estas funciones de Supabase:
   `enqueue_curation_case`, `lease_curation_case`, `heartbeat_curation_case`, `record_ai_review`,
   `publish_curation_decision`, `release_curation_case`,
   `lease_ranking_job`, `heartbeat_ranking_job`, `read_ranking_input`,
   `complete_ranking_job` y `release_ranking_job`. No ejecutes DDL ni escrituras
   directas sobre tablas canónicas, editoriales, de autenticación o staging.

## Alimentación automática

Antes del lease, comprueba si hay casos pendientes o recuperables. Si existen, priorízalos sin encolar otro. Si no existen, selecciona como máximo una batalla de import_records unida a import_runs, con import_runs.status = staged y source_dataset = the-war-atlas, y sin curation_cases con la misma clave. Ordena por import_records.id. La clave exacta es the-war-atlas:battle:<external_id>:<source_version>. Llama a enqueue_curation_case con esa clave, entity_type battle, source_revision igual a source_version y el payload original completo, sin envolverlo ni modificarlo. Conserva el orden de commanders. Recomprueba la ausencia dentro de la misma sentencia SQL que llama al RPC mediante NOT EXISTS; no actualices casos existentes ni reencoles casos terminales. La unicidad de case_key protege contra duplicados concurrentes. Como máximo una incorporación por ejecución. Si no hay candidatos, continúa con ranking. Consulta las firmas reales de los RPC antes de usarlos, sin DDL ni escrituras directas.

## Caso de curación

1. Genera un `worker_id` nuevo y no sensible para esta ejecución. Arrenda como
   máximo un caso con `lease_curation_case` durante 3300 segundos. Si no hay
   caso, continúa con ranking.
2. Lee las revisiones persistidas del caso con `read_curation_reviews`. Para
   cada rol ausente crea un contexto de agente completamente nuevo con el caso
   original y su prompt versionado. Usa model gpt-5.6-luna, reasoning_effort low y fork_turns none para cada rol. El coordinador no realiza las revisiones. Incluye a ambos las mismas reglas de contexto: Elo es una puntuación matemática; outcome se interpreta desde el primer bando distinto del payload original; el slug canónico usa guiones pero las referencias fuente permanecen intactas. No muestres, reveles ni compartas la salida
   del proponente con el revisor. Si no puedes garantizar dos contextos
   independientes, libera el caso como `awaiting_human`.
3. Si una salida no es JSON válido o falla el contrato, no la persistas ni la corrijas tú. Repite únicamente ese rol en un contexto nuevo con el mismo caso y prompt, escalando sin saltos low → medium → high → xhigh → max, como máximo un intento por esfuerzo. Puedes proporcionar el nombre del campo inválido, nunca la salida del otro rol. Conserva una revisión válida del otro rol. No escales por discrepancias editoriales ni para forzar consenso: una decisión válida de escalado requiere awaiting_human. Errores de acceso, cuota, herramientas o infraestructura no se resuelven aumentando esfuerzo. Renueva el lease entre intentos; si se pierde, detén las escrituras.

   Valida cada salida ejecutando sin modificar el contrato versionado. Renueva
   el lease antes de cada escritura. Persiste primero la revisión `proposer` y
   después la revisión `reviewer` mediante `record_ai_review`, con el identificador
   real gpt-5.6-luna únicamente si la creación del agente confirma ese modelo, y los prompt versions exactos proposer-v1 / reviewer-v1. Comprueba también dataRevision contra el caso. Reutiliza solo revisiones compatibles; nunca sobrescribas revisiones persistidas incompatibles y libera el caso como awaiting_human. Registra en el informe el esfuerzo real y el hash del prompt por rol.
4. Ejecuta `resolveConsensus` sin reinterpretarlo. Si ambas revisiones rechazan, libera con rejected antes de intentar publicar. Si devuelve una mutación
   ejecutable, renueva el lease y llama a `publish_curation_decision` con los dos
   IDs exactos de revisión. Si ambas revisiones rechazan la batalla, usa
   `release_curation_case` con `rejected`. Ante discrepancia, escalado explícito
   o imposibilidad de demostrar independencia, usa `release_curation_case` con
   `awaiting_human`.
5. Tras agotar los esfuerzos con salida inválida, o ante otro fallo técnico, intenta `release_curation_case` con
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

## Participantes ausentes y equivalencia de formato

Para cada salida nueva ejecuta parseAgentDecisionForCase(salida, casoOriginal) desde contracts.mjs, además de comprobar promptVersion. Esta función valida dataRevision, las referencias exactas y orden de la fuente y la presencia de dos bandos antes de persistir. Un fallo aquí es una salida inválida: repite solo ese rol con el siguiente esfuerzo y el nombre del campo inválido, sin corregir su JSON ni mostrar la otra revisión. Una decisión válida de escalate termina en awaiting_human sin reintentos. Para revisiones persistidas, usa la misma validación; si fallan, no las sobrescribas y libera como awaiting_human. El casoOriginal contiene source_revision y payload tal como los devolvió el lease.

Usa únicamente el contrato y el publicador compatibles con participants. Antes de arrendar, verifica mediante lectura que existe curation_private.effective_battle_commanders(jsonb,jsonb,text); si falta la migración, termina sin mutaciones.

Si commanders está vacío, proporciona a ambos agentes las mismas identidades candidatas obtenidas mediante lecturas de commanders o import_records de tipo commander, unidas a import_runs staged de the-war-atlas de la misma source_revision. Los agentes pueden solicitar búsquedas de candidatos por nombre; responde con lecturas de esas tablas, sin mostrar ninguna decisión del otro rol. Ninguna identidad se inventa: el publicador exige referencias canónicas existentes o registros importados verificables. Los agentes investigan fuentes para demostrar mando y pertenencia a cada bando. Ordenan la propuesta por ref.id e interpretan outcome desde el primer bando distinto de esa propuesta. Si commanders no está vacío, mantienen sus reglas originales y no proponen reemplazos.

Ejecuta parseAgentDecision y persiste su resultado normalizado, nunca el JSON crudo: el contrato unifica exclusivamente el sufijo de exportación de un mismo slug War Atlas. El consenso sigue comparando fechas, identidades, bandos y resultado sin aproximaciones. No sobrescribas revisiones existentes ni reencoles casos terminales; los casos ya escalados requieren una nueva revisión expresamente autorizada.
