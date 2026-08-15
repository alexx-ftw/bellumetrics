# Commander Elo: diseño de la wiki colaborativa

Fecha: 15 de agosto de 2026

Estado: aprobado para planificación

## 1. Propósito y relación con el diseño original

Esta especificación convierte Commander Elo en una wiki histórica estructurada. Complementa `2026-08-14-commander-elo-design.md`, que sigue definiendo el producto histórico, el grafo y la dirección del modelo estadístico.

La wiki permitirá editar artículos y datos, vincular cada afirmación a evidencia, revisar propuestas, simular su impacto y publicar rankings reproducibles. Cuando exista una diferencia entre ambos documentos sobre contribuciones, permisos, alojamiento o publicación, esta especificación prevalece para la primera versión de la wiki.

`Commander Elo` se mantiene como nombre provisional. Un posible cambio de marca no alterará el modelo de datos ni la arquitectura.

## 2. Principios

- La unidad de evidencia es una afirmación vinculada a una o más fuentes.
- El contenido narrativo y los datos calculables se editan juntos, pero se almacenan por separado.
- Nadie edita directamente una puntuación para subir o bajar un comandante.
- Cada ranking identifica la versión del dataset y del algoritmo que lo produjo.
- Toda publicación es auditable, comparable y reversible.
- La confianza editorial concede autonomía progresiva, sin eliminar la revisión reforzada de cambios sensibles.
- Las interpretaciones incompatibles se conservan explícitamente en vez de ocultarse bajo una falsa precisión.

## 3. Arquitectura del producto

La aplicación será una wiki propia construida sobre:

- Next.js y TypeScript en Vercel para la interfaz pública, el área editorial y las funciones de servidor.
- Supabase PostgreSQL como fuente canónica.
- Supabase Auth para acceso mediante enlace u OTP por email, Google y GitHub. Varias identidades podrán vincularse al mismo perfil.
- Supabase Storage solo para archivos permitidos por licencia cuando resulte necesario.
- Row Level Security para aplicar permisos en la base de datos aunque se intente evitar la interfaz.

El repositorio permanecerá en GitHub. La GitHub Page actual podrá conservarse como archivo o redirigir a la aplicación dinámica.

La primera versión podrá operar dentro de los planes gratuitos de Vercel y Supabase. La arquitectura evitará depender de funciones exclusivas de pago y mantendrá migraciones SQL y exportaciones periódicas para reducir el bloqueo de proveedor.

## 4. Entidades y relaciones

### 4.1 Entidades públicas

- Comandante o responsable político-militar.
- Enfrentamiento puntuable.
- Campaña contenedora.
- Fuente.
- Afirmación.
- Interpretación de resultado.
- Versión publicada del modelo.
- Snapshot de ranking.

### 4.2 Participación en enfrentamientos

Un enfrentamiento tendrá dos o más bandos. Cada bando podrá contener varios participantes. Cada participación registrará:

- Comandante.
- Bando.
- Rol y nivel de mando.
- Responsabilidad estimada.
- Autonomía.
- Fecha o fase de incorporación y salida.
- Presencia efectiva.
- Afirmaciones y fuentes que justifican esos atributos.

No se reducirá artificialmente Waterloo u otros mandos compartidos a una relación de uno contra uno.

### 4.3 Jerarquía y doble contabilización

Las campañas agrupan enfrentamientos y ofrecen contexto, cronología y síntesis narrativa. En la primera versión no puntúan de nuevo en el Elo. Solo los enfrentamientos verificables marcados como elegibles alimentan el cálculo.

Esta regla evita contar dos veces una batalla mediante su resultado individual y el resultado agregado de la campaña. Una futura versión del modelo podrá proponer evidencia operacional agregada, pero requerirá una versión nueva y una prueba explícita contra doble contabilización.

### 4.4 Resultados discutidos

Cada enfrentamiento tendrá una interpretación principal, un nivel de confianza y cero o más alternativas. Cada postura conservará sus afirmaciones y fuentes.

El ranking publicado usará la interpretación principal aceptada. Las alternativas podrán simularse sin modificar el ranking canónico.

## 5. Fuentes y afirmaciones

Cada fecha, participante, rol, resultado, condición inicial o explicación susceptible de discusión podrá vincularse a fuentes concretas.

Una fuente registrará al menos:

- Autor o institución.
- Título.
- Edición o publicación.
- Año.
- URL o referencia bibliográfica.
- Página, sección, capítulo o localizador cuando exista.
- Fecha de consulta para recursos web.
- Tipo de fuente.

Los tipos iniciales serán primaria, investigación académica, obra especializada, oficial, divulgativa y dudosa. La categoría no determinará por sí sola la fiabilidad.

Los revisores evaluarán independencia, proximidad al hecho, metodología, trazabilidad y concordancia. La clasificación inicial y la evaluación razonada quedarán versionadas y podrán discutirse.

## 6. Experiencia de usuario

Cada comandante, enfrentamiento o campaña tendrá:

- **Artículo:** explicación histórica legible.
- **Datos:** campos estructurados relevantes.
- **Fuentes:** mapa entre afirmaciones y referencias.
- **Historial:** versiones, autores, comparación y reversión.
- **Discusión:** deliberación editorial separada del artículo.

El editor híbrido permitirá modificar texto y campos estructurados en un mismo flujo. Antes de enviar mostrará:

- Diferencia exacta frente a la versión de partida.
- Afirmaciones nuevas o alteradas y sus citas.
- Errores de validación, posibles duplicados y contradicciones.
- Simulación del cambio en Elo, ranking y red de conexiones.
- Clasificación de riesgo editorial.

La vista de propuesta mostrará justificación, fuentes, conversación, revisores, simulación y estado.

## 7. Flujo editorial

Los estados básicos de una revisión serán borrador, propuesta, en revisión, cambios solicitados, aprobada, rechazada, publicada y revertida.

Flujo normal:

1. El usuario parte de una versión conocida.
2. El cliente y el servidor validan estructura, citas y permisos.
3. El motor ejecuta una simulación determinista sin modificar datos canónicos.
4. Se crea una propuesta inmutable con su diferencia y justificación.
5. El sistema decide si necesita revisión según autor, tipo de dato y riesgo.
6. Al aprobar, se vuelve a comprobar que la versión base no haya cambiado.
7. Se calculan los artefactos derivados definitivos.
8. La revisión, el estado canónico y el snapshot se publican atómicamente.
9. Se invalidan las páginas y cachés afectadas.

Si dos personas editan la misma versión, la segunda publicación no sobrescribe la primera. Se ofrecerá comparar y fusionar los cambios.

## 8. Reputación, roles y permisos

### 8.1 Roles

1. **Colaborador:** crea propuestas.
2. **Editor fiable:** puede publicar cambios ordinarios de bajo riesgo.
3. **Revisor:** aprueba propuestas y evalúa fuentes.
4. **Moderador:** revierte, protege páginas, resuelve disputas y sanciona abuso.
5. **Administrador:** gestiona seguridad, permisos y versiones del algoritmo.

### 8.2 Reputación

La reputación aumentará mediante:

- Ediciones aceptadas.
- Fuentes útiles y correctamente localizadas.
- Revisiones posteriormente confirmadas.
- Trabajo sostenido dentro de una especialidad.

Disminuirá mediante reversiones justificadas, contenido sin respaldo, revisiones negligentes o abuso.

La puntuación propondrá ascensos, pero no concederá automáticamente permisos sensibles. Un moderador confirmará la promoción a editor fiable, revisor o moderador.

### 8.3 Revisión reforzada

Siempre requerirán revisión, incluso si el autor es fiable:

- Cambios en el resultado principal de un enfrentamiento.
- Cambios grandes en atribución o responsabilidad.
- Fusiones o divisiones de identidades.
- Cambios con impacto extremo en el ranking.
- Cambios en reglas, parámetros o código del modelo.

Las decisiones podrán apelarse en la discusión correspondiente. Toda acción administrativa quedará registrada.

## 9. Gobierno del algoritmo

Los datos históricos y el algoritmo se versionan por separado.

La comunidad podrá proponer modificaciones del modelo, pero cada propuesta deberá incluir motivación, especificación, pruebas, análisis de sensibilidad, comparación con la versión vigente y plan de migración.

Una versión del algoritmo solo podrá publicarse tras revisión reforzada. El sistema conservará los snapshots anteriores y permitirá reproducirlos. Ningún cambio de fórmula reescribirá silenciosamente la historia del ranking.

## 10. Datos y permisos

El esquema incluirá unidades separadas para:

- Perfiles e identidades vinculadas.
- Comandantes, alias y estados de historicidad.
- Campañas, enfrentamientos, bandos y participaciones.
- Fuentes, afirmaciones y enlaces afirmación-fuente.
- Interpretaciones principales y alternativas.
- Revisiones, operaciones de cambio y propuestas.
- Revisiones editoriales, comentarios y apelaciones.
- Roles, reputación, especialidades y acciones de moderación.
- Versiones del dataset y del algoritmo.
- Ejecuciones, snapshots, ratings, trayectorias y relaciones derivadas.

Las tablas canónicas no expondrán escrituras directas al navegador. Las operaciones sensibles pasarán por funciones de servidor y políticas RLS. Las revisiones publicadas serán inmutables; revertir creará una revisión compensatoria.

## 11. Publicación segura y recuperación de errores

- Una simulación no escribe en el estado canónico.
- Una publicación no queda a medias: revisión, datos y snapshot se confirman juntos o no se confirman.
- El ranking público conserva la última versión válida si falla un recálculo.
- Los errores de validación identifican el campo, la causa y la corrección posible.
- Los trabajos fallidos conservan registros reproducibles sin exponer secretos.
- Las operaciones serán idempotentes para evitar publicaciones duplicadas por reintentos.
- Se aplicarán límites por usuario e IP, protección contra automatización abusiva y sanitización del contenido.
- Las fusiones, retiradas y sanciones serán reversibles según permisos.
- Se exportarán periódicamente datos y metadatos suficientes para reconstruir el estado fuera de Supabase.

## 12. Verificación

### 12.1 Pruebas unitarias

- Validadores de entidades, fechas, bandos, citas y estados.
- Cálculo Elo, atribución colectiva y simulación.
- Reglas contra doble contabilización.
- Clasificación de riesgo y transiciones editoriales.
- Diferencias, fusiones y reversiones.

### 12.2 Pruebas de integración

- Políticas RLS para cada rol.
- Vinculación de identidades de autenticación.
- Publicación transaccional y conflicto de versión.
- Reproducibilidad entre dataset, algoritmo y snapshot.
- Migraciones y exportación.

### 12.3 Pruebas de extremo a extremo

- Registro e inicio de sesión por cada proveedor.
- Crear, revisar, rechazar, aprobar y revertir una propuesta.
- Añadir un comandante y conectarlo mediante un enfrentamiento.
- Cambiar una fuente y ver su impacto simulado.
- Disputar un resultado sin alterar el ranking publicado.
- Verificar que un usuario sin permisos no pueda publicar ni moderar.

Se mantendrá un dataset pequeño calculado manualmente y snapshots dorados para detectar regresiones.

## 13. Entregas

### 13.1 Primera versión funcional

- Autenticación por email, Google y GitHub.
- Migración de los comandantes y batallas actuales.
- Fichas híbridas de comandantes, enfrentamientos, campañas y fuentes.
- Citas por afirmación.
- Propuestas, revisión, historial, comparación y reversión.
- Discusión editorial por página y por propuesta.
- Simulación y recálculo del ranking y del grafo.
- Interpretaciones alternativas simulables sin modificar el ranking canónico.
- Roles básicos y promoción manual.
- Metodología y versiones visibles.

### 13.2 Segunda versión

- Reputación automática.
- Apelaciones formales, vigilancia de páginas y notificaciones.
- Herramientas avanzadas para revisores.

### 13.3 Tercera versión

- Propuestas públicas de nuevas fórmulas.
- Comparación interactiva entre modelos.
- API y exportación pública completa.
- Soporte multilingüe.

## 14. Criterios de aceptación de la primera versión

La primera versión estará lista cuando:

- Un visitante pueda navegar por artículos, datos, fuentes, historial y rankings sin iniciar sesión.
- Un usuario pueda autenticarse mediante cualquiera de los tres métodos acordados.
- Un colaborador pueda proponer una edición híbrida respaldada por citas.
- La propuesta muestre su diferencia y simulación antes de revisión.
- Un revisor pueda aprobarla o rechazarla con una explicación.
- Una aprobación publique una revisión recuperable y un snapshot reproducible.
- Los datos actuales hayan sido migrados y produzcan resultados equivalentes bajo la versión inicial del algoritmo.
- Los permisos resistan las pruebas de acceso directo a la base de datos y a las funciones.
- El sistema pueda revertir una publicación sin borrar su historial.
- Las pruebas unitarias, de integración y de extremo a extremo acordadas estén superadas.

## 15. Fuera de la primera versión

- Publicación anónima.
- Promoción automática a permisos sensibles.
- Votación popular como sustituto de la evaluación de fuentes.
- Mezclar personajes ficticios con el ranking histórico.
- Publicar automáticamente datos importados sin revisión.
- Permitir que campañas agregadas puntúen nuevamente.
- Sustituir PostgreSQL por una base de grafos sin evidencia de necesidad.
- Monetización y funciones comerciales.
