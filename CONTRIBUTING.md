# Contribuir a Bellumetrics

Gracias por ayudar a mejorar este prototipo histórico. La base actual es provisional: las puntuaciones y los conteos de fuentes son de demostración y deben revisarse con evidencia verificable.

## Qué puedes proponer

- Correcciones de un comandante, batalla, fecha, resultado o contexto.
- Nuevos comandantes y los encuentros documentados que permiten compararlos.
- Fuentes primarias o secundarias de calidad que respalden, contradigan o completen un dato.

## Evidencia necesaria

Cada propuesta debe incluir:

- Una **fuente**: URL estable o referencia bibliográfica completa (autor, título, editorial o publicación, año y, cuando sea posible, página o sección).
- El comandante o la batalla afectados, usando el nombre y, si lo conoces, el identificador de `lib/commanders.mjs`.
- La corrección propuesta con el dato actual y el dato sugerido.
- Una explicación de por qué la fuente sustenta el cambio, incluida cualquier incertidumbre, desacuerdo historiográfico o límite de la evidencia.

No aceptamos solicitudes que solo pidan subir o bajar una puntuación. Una fuente aceptada puede modificar un encuentro, sus participantes, su resultado o su peso de evidencia; después se recalcula el Elo. Nunca se edita manualmente el marcador para obtener una posición deseada.

## Proceso recomendado

1. Busca primero si ya existe un issue o discusión sobre el comandante o batalla.
2. Abre el formulario de corrección de datos o una issue para presentar la evidencia antes de un cambio amplio.
3. Para una modificación de código o datos, crea una rama y prepara un pull request enfocado.
4. Describe la fuente, el alcance de la corrección y cómo afectaría al cálculo; no declares el efecto como definitivo mientras la evidencia siga en revisión.
5. Ejecuta las comprobaciones relevantes antes de solicitar revisión.

## Preparar un pull request

```bash
npm ci
npm run lint
npm test
npm run build:pages
node --test tests/pages-export.test.mjs
```

Indica en el pull request qué archivos de datos modificaste y enlaza las fuentes. Si añades un comandante, incluye los encuentros que establecen su relación con la red; un perfil aislado no permite una comparación Elo sólida.

## Datos del prototipo

Actualmente, los perfiles y batallas de demostración viven en `lib/commanders.mjs`. Mantén los cambios pequeños, trazables y respaldados por una fuente. Las decisiones editoriales y el método se explican en la página de metodología de la aplicación.
