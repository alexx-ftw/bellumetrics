# Bellumetrics: curación autónoma con Codex

Fecha: 16 de agosto de 2026

Estado: aprobado para planificación

Actualización operativa: 4 de septiembre de 2026. El alojamiento Oracle se
sustituye por una tarea programada nativa de ChatGPT/Codex para evitar coste de
infraestructura y facturación separada de API.

## Propósito

Bellumetrics procesará automáticamente los registros históricos importados. Codex investigará, normalizará, contrastará y publicará los casos resolubles. El curador humano verá principalmente excepciones, conflictos y decisiones que las revisiones de IA no hayan podido resolver.

## Arquitectura

- Vercel alojará la aplicación Next.js pública y el panel privado.
- Supabase alojará autenticación, staging, datos canónicos, cola de curación, auditoría y snapshots.
- Una tarea programada nativa de ChatGPT/Codex ejecutará una iteración cada hora con los conectores autorizados de GitHub y Supabase.
- La tarea usará el acceso incluido en la suscripción ChatGPT del propietario, sujeto a sus límites, sin clave de OpenAI API ni facturación separada por token.
- GitHub Actions seguirá importando datasets y aplicando migraciones.
- GitHub Pages permanecerá disponible hasta verificar Vercel.

La tarea programada no será fuente de verdad. Cada ejecución será independiente
y Supabase conservará cola, leases, revisiones, auditoría y snapshots. Una
ejecución interrumpida podrá recuperarse en la siguiente hora sin duplicar una
publicación. `deploy/oracle/` se conserva únicamente como alternativa heredada
autohospedada y no forma parte de la ruta activa.

Si se activa esa alternativa, su único objetivo soportado sigue siendo Oracle
Cloud VM.Standard.E2.1.Micro, AMD x86_64 con 1 GB de RAM. Debe pausarse antes la
tarea nativa y aplicarse el runbook heredado completo.

## Acceso y credenciales

El primer lanzamiento tendrá un único curador. Supabase Auth enviará un enlace mágico al email autorizado. Una membresía y RLS protegerán todos los datos editoriales.

La sesión de ChatGPT permanecerá gestionada por la propia plataforma. Las
autorizaciones de GitHub y Supabase se concederán como conectores y no se
copiarán al repositorio, GitHub Actions, navegador, Vercel ni tablas de
Supabase. La tarea no usará ni persistirá una caché de login de Codex.

## Flujo autónomo

1. Una importación crea o actualiza registros de staging y casos idempotentes.
2. La tarea programada obtiene como máximo un caso mediante un arrendamiento temporal.
3. Un agente proponente investiga, contrasta fuentes y prepara una acción estructurada.
4. Un agente independiente revisa la evidencia sin reutilizar la conclusión anterior.
5. Si ambos llegan a una decisión compatible, el orquestador la ejecuta.
6. Si discrepan, faltan evidencias o detectan riesgo, el caso llega al curador.
7. Una publicación actualiza los datos canónicos y crea un trabajo de recálculo.
8. El motor determinista recalcula Elo, ranking y conexiones y publica un snapshot versionado.

No habrá umbrales editoriales numéricos codificados. Los agentes decidirán según el contexto, independencia de fuentes, contradicciones, precedentes y consecuencias. Sí habrá restricciones técnicas fijas de autenticación, integridad, formato, idempotencia, auditoría y reversión.

## Acciones permitidas

Codex podrá normalizar nombres, fechas, participantes y resultados; vincular fuentes y afirmaciones; fusionar o separar identidades; aprobar, rechazar o escalar batallas; publicar revisiones; e iniciar el recálculo.

Una fusión preservará alias, fuentes, relaciones e historial y será reversible. Ningún agente podrá editar directamente una puntuación Elo.

## Panel privado

La ruta /curation mostrará:

- Resumen del trabajo automático, excepciones y fallos.
- Cola compacta de batallas y posibles duplicados.
- Propuesta, fuentes, razonamientos de ambos agentes y diferencias.
- Acciones para aprobar, corregir, rechazar, fusionar, separar o revertir.
- Historial de publicaciones y ejecuciones de ranking.

La interfaz estará optimizada para escritorio y será utilizable en móvil.

## Modelo editorial nuevo

- curator_memberships: usuarios autorizados y roles.
- curation_cases: entidad, estado, arrendamiento, prioridad y revisión de origen.
- ai_reviews: agente, modelo, instrucciones versionadas, evidencia y decisión.
- editorial_events: actor, acción, estado anterior, estado posterior y motivo.
- ranking_jobs: solicitud, estado, reintentos y error.
- ranking_snapshots: revisión de datos, algoritmo y resultados reproducibles.

Las tablas expuestas tendrán RLS y privilegios mínimos. La tarea usará el
conector autorizado y limitará todas sus mutaciones a los RPC versionados del
worker.

## Fiabilidad

- Los trabajos serán idempotentes y recuperables.
- Los arrendamientos expirarán para liberar casos abandonados.
- Los fallos se reintentarán y acabarán en revisión humana si persisten.
- Publicación y auditoría ocurrirán en una transacción.
- Un fallo de Elo mantendrá el snapshot anterior y dejará el nuevo trabajo pendiente.
- Cada decisión registrará versiones de datos, instrucciones, modelo y algoritmo.

## Pruebas

Se probarán RLS, casos idempotentes, arrendamientos, respuestas estructuradas, consenso, desacuerdo, escalado, fusiones reversibles, publicación transaccional, snapshots reproducibles, acceso mágico y la interfaz de excepciones.

Las pruebas del worker usarán respuestas grabadas. La suite normal no consumirá cuota de Codex.

## Operación y seguridad

- La tarea se probará manualmente con un único caso antes de programarla.
- Se ejecutará como máximo una vez por hora y procesará como máximo un caso por ejecución durante el despliegue inicial.
- Cada ejecución comprobará primero el acceso de solo lectura a GitHub y Supabase y fallará cerrada si falta contexto o autorización.
- GitHub Actions no almacenará ni ejecutará autenticación de la cuenta ChatGPT.
- Los secretos no aparecerán en logs.
- El panel mostrará el consumo y los límites reportados por Codex.
- Toda decisión automática podrá revertirse sin borrar historial.

## Fuera de alcance inicial

- Edición pública anónima.
- Varios curadores.
- Votaciones comunitarias.
- Cambio automático de proveedor de IA.
- Codex en GitHub Actions mediante una API de pago.
- Campañas agregadas puntuadas otra vez en Elo.

## Criterios de aceptación

- Solo el propietario accede al panel mediante enlace mágico.
- La tarea nativa usa la sesión ChatGPT del propietario y procesa casos sin clave de API Platform.
- Dos revisiones independientes producen una decisión auditable.
- Los acuerdos se ejecutan y los desacuerdos llegan al panel.
- Una batalla aprobada genera datos canónicos y un snapshot Elo.
- Una fusión puede revertirse sin perder relaciones ni fuentes.
- Interrumpir una ejecución no pierde trabajo y la siguiente ejecución no duplica publicaciones.
- Ninguna credencial privada llega al cliente, repositorio o logs.
