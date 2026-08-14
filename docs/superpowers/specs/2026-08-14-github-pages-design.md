# Commander Elo en GitHub Pages

## Objetivo

Publicar Commander Elo como proyecto abierto en `alexx-ftw/commander-elo`, accesible mediante GitHub Pages y desplegado automáticamente desde `main`.

## Arquitectura

- El código fuente y los datos de demostración permanecen en el repositorio.
- La compilación genera archivos estáticos bajo la ruta base `/commander-elo/`.
- GitHub Actions ejecuta pruebas, lint y compilación antes de desplegar el artefacto.
- Las rutas principales tendrán HTML estático para permitir enlaces directos sin usar rutas con `#`.
- Los perfiles de los comandantes incluidos se generan durante la compilación.

## Repositorio y colaboración

- Repositorio público: `alexx-ftw/commander-elo`.
- Rama principal: `main`.
- El README explica el propósito, el carácter provisional de los datos, el desarrollo local y cómo proponer cambios.
- Las contribuciones se realizan mediante issues y pull requests.

## Compatibilidad

- Los enlaces y recursos deben funcionar bajo `https://alexx-ftw.github.io/commander-elo/`.
- La versión de Sites puede seguir existiendo, pero GitHub Pages será una publicación independiente.
- No se incorporará backend ni formulario persistente en esta fase.

## Verificación

- Pruebas del modelo y del HTML.
- Lint y compilación sin errores.
- Comprobación local de la salida estática en la ruta base.
- Comprobación del workflow y de la URL pública después del despliegue.
