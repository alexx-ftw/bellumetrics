# Bellumetrics: curación autónoma con Codex

Fecha: 16 de agosto de 2026

Estado: aprobado para planificación

## Propósito

Bellumetrics procesará automáticamente los registros históricos importados. Codex investigará, normalizará, contrastará y publicará los casos resolubles. El curador humano verá principalmente excepciones, conflictos y decisiones que las revisiones de IA no hayan podido resolver.

## Arquitectura

- Vercel alojará la aplicación Next.js pública y el panel privado.
- Supabase alojará autenticación, staging, datos canónicos, cola de curación, auditoría y snapshots.
- Una instancia privada Oracle Cloud VM.Standard.E2.1.Micro Always Free (AMD x86_64, 1 GB RAM) ejecutará continuamente el worker. El artefacto Codex revisado está fijado a x86_64; no se admite Ampere A1/Arm para este worker.
- El worker usará Codex SDK con la cuenta ChatGPT Pro del propietario. Consumirá los límites de la suscripción, no una clave facturada por tokens.
- GitHub Actions seguirá importando datasets y aplicando migraciones.
- GitHub Pages permanecerá disponible hasta verificar Vercel.

La instancia de Oracle no será fuente de verdad. Podrá reconstruirse desde el repositorio y Supabase. Oracle Always Free no ofrece SLA y puede sufrir falta de capacidad, pero una caída no perderá trabajos.

## Acceso y credenciales

El primer lanzamiento tendrá un único curador. Supabase Auth enviará un enlace mágico al email autorizado. Una membresía y RLS protegerán todos los datos editoriales.

Las credenciales de ChatGPT existirán únicamente en el volumen privado del worker, con permisos restrictivos. No se copiarán al repositorio, GitHub Actions, navegador, Vercel ni Supabase. Si se pierde la instancia, el propietario volverá a iniciar sesión.

## Flujo autónomo

1. Una importación crea o actualiza registros de staging y casos idempotentes.
2. El worker obtiene un caso mediante un arrendamiento temporal.
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

Las tablas expuestas tendrán RLS y privilegios mínimos. El worker usará una identidad limitada a sus operaciones.

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

- El worker correrá como servicio systemd sin SSH por contraseña.
- Oracle bloqueará conexiones entrantes innecesarias.
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
- El worker inicia sesión con ChatGPT Pro y procesa casos sin clave de API Platform.
- Dos revisiones independientes producen una decisión auditable.
- Los acuerdos se ejecutan y los desacuerdos llegan al panel.
- Una batalla aprobada genera datos canónicos y un snapshot Elo.
- Una fusión puede revertirse sin perder relaciones ni fuentes.
- Reiniciar el worker no pierde ni duplica trabajo.
- Ninguna credencial privada llega al cliente, repositorio o logs.
