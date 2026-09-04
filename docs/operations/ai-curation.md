# Operación de la curación autónoma

La ruta activa es una tarea programada nativa de ChatGPT/Codex. Se ejecuta una
vez por hora, procesa como máximo un caso y un trabajo de ranking, y usa los
conectores autorizados de GitHub y Supabase. No necesita servidor, clave de
OpenAI API ni credenciales ChatGPT en GitHub. Consume el cupo incluido en la
suscripción ChatGPT del propietario, sujeto a los límites y disponibilidad de
su plan, por lo que no genera una factura API separada.

## Archivos de operación

- `deploy/codex/scheduled-task.json` fija título, horario, zona horaria,
  conectores y límite de lote.
- `worker/curation/prompts/scheduled-task-v1.md` es la instrucción completa y
  versionada que se guarda en la tarea.
- `proposer-v1.md`, `reviewer-v1.md`, los contratos de curación y `elo.mjs`
  siguen siendo la fuente ejecutable de decisiones y ranking.

Las tareas web no conservan un checkout local entre ejecuciones. Por eso el
prompt recupera esos archivos mediante el conector GitHub y exige que todos
procedan del mismo ref. `main` es el ref normal; durante la aceptación previa al
merge puede usarse `agent/ai-curation-implementation`.

## Activación

1. Autorice los conectores GitHub y Supabase para la cuenta ChatGPT que
   administrará la tarea. Limite GitHub al repositorio `alexx-ftw/bellumetrics`
   y confirme el proyecto Supabase `dggbwsgoddbrxvojjojy`.
2. Ejecute manualmente el contenido completo de `scheduled-task-v1.md` contra
   un único caso de aceptación. Revise que haya dos contextos independientes,
   dos revisiones persistidas antes del consenso, mutaciones solo mediante RPC
   y un informe sin payloads ni valores de autorización.
3. No programe la tarea si la prueba manual falla. Corrija el prompt o los
   permisos y repita hasta obtener una ejecución fiable.
4. Después de la prueba, cree `Curar Bellumetrics` con el manifiesto: repetición
   horaria, modo exacto y zona `Atlantic/Canary`. Antes de crearla, una lectura
   inocua debe confirmar que ambos conectores siguen autorizados.
5. Revise las primeras ejecuciones desde Scheduled. Pause la tarea ante un ref
   inesperado, una mutación fuera de los RPC permitidos o un informe sin
   evidencia verificable.

No añada una clave OpenAI a Vercel o GitHub Actions. Tampoco copie una caché de
login Codex a CI. La sesión ChatGPT y las autorizaciones de conectores las
gestiona la plataforma.

## Salud y recuperación de la ruta activa

Cada ejecución debe informar el ref usado, IDs no sensibles y estados finales.
El estado duradero se comprueba en Supabase: casos pendientes o
`awaiting_human`, leases vencidos, último evento editorial, trabajo de ranking
y último snapshot. No se inspeccionan payloads completos para un healthcheck.

Si una ejecución se interrumpe, el lease vence y la siguiente ejecución horaria
puede recuperarlo. Las revisiones ya persistidas se reutilizan por rol, pero el
revisor nuevo recibe solo el caso original. La publicación y el snapshot son
idempotentes. Para reintentar inmediatamente, use Run now en Scheduled; no
edite leases directamente.

Si un conector caduca, pause la tarea, vuelva a autorizarlo, haga una lectura de
prueba y ejecute una iteración manual antes de reanudar. Para retirar la
automatización, páusela o elimínela en Scheduled. Esto no elimina cola,
auditoría ni snapshots de Supabase.

## Alternativa heredada: Oracle/systemd

`deploy/oracle/` se conserva como fallback autohospedado y no es la ruta
operativa activa. No ejecute simultáneamente esta alternativa y la tarea nativa
durante la aceptación. Si en el futuro se elige el fallback, pause primero la
tarea programada y siga las instrucciones siguientes.

El worker combinado de curación y ranking puede ejecutarse en una instancia
privada Oracle Always Free VM.Standard.E2.1.Micro: AMD x86_64 con 1 GB de RAM.
El artefacto Codex revisado está fijado a x86_64; Ampere A1/Arm no es compatible
con este despliegue. La instancia no es una fuente de verdad: Supabase conserva
la cola, auditoría y snapshots, por lo que una reconstrucción no pierde trabajo.
No abra listeners ni reglas de entrada para este servicio; mantenga únicamente
el acceso administrativo SSH con claves según la política de la instancia.

### Instalación y primer inicio

En VM.Standard.E2.1.Micro x86_64 Linux con Node 22+, prepare una URL HTTPS
canónica de GitHub y el SHA completo (40 hexadecimales en minúsculas) de un
commit. El instalador rechaza tags, ramas, rutas no GitHub y cualquier referencia
ambigua; obtiene ese SHA, hace checkout detached y vuelve a comprobar `HEAD`
antes de instalar. Requiere `bubblewrap` en `/usr/bin/bwrap` con `--bind-fd`,
crea la cuenta no interactiva `bellumetrics-worker`, instala las dependencias de
producción exactas y deja la aplicación en `/opt/bellumetrics/app`.

```bash
export BELLUMETRICS_REPOSITORY=https://github.com/ORG/bellumetrics.git
export BELLUMETRICS_REF=0123456789abcdef0123456789abcdef01234567
sudo /path/to/bellumetrics/deploy/oracle/install.sh
sudoedit /etc/bellumetrics/worker.env
sudo chmod 600 /etc/bellumetrics/worker.env
```

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CURATION_CODEX_MODEL`, and
leave `CURATION_CODEX_HOME=/var/lib/bellumetrics/codex`. That directory is
outside the checkout and must remain owned by `bellumetrics-worker`, mode 700.
It is authentication-only: never inspect, copy, back up, or log its contents.

Authenticate interactively as the service account, then verify the same home:

```bash
sudo -u bellumetrics-worker env CODEX_HOME=/var/lib/bellumetrics/codex \
  /opt/bellumetrics/app/node_modules/.bin/codex login --device-auth
sudo -u bellumetrics-worker env CODEX_HOME=/var/lib/bellumetrics/codex \
  /opt/bellumetrics/app/node_modules/.bin/codex login status
sudo chown bellumetrics-worker:bellumetrics-worker /var/lib/bellumetrics/codex
sudo chmod 700 /var/lib/bellumetrics/codex
sudo stat -c '%U %G %a %n' /var/lib/bellumetrics/codex
sudo systemctl restart bellumetrics-worker.service
sudo systemctl status bellumetrics-worker.service
```

The service runs `worker/index.mjs`, so curation and ranking remain together.
The Codex runner separately verifies the exact reviewed x86_64 native Codex
0.149.1 artifact and creates its credential mount with `--bind-fd`; there is
no non-isolated fallback.

### Memoria y swap

VM.Standard.E2.1.Micro tiene solo 1 GB de RAM. Antes de instalar, reserve al
menos 1 GiB de swap activo; el instalador lo comprueba y falla en vez de iniciar
Node/Codex bajo presión de memoria. Se recomiendan 2 GiB si el volumen tiene
espacio suficiente. Revise el espacio libre y cree un archivo nuevo, sin
sobrescribir uno existente:

```bash
free -h
swapon --show
df -h /var/lib
sudo test ! -e /var/lib/bellumetrics.swap
sudo fallocate -l 2G /var/lib/bellumetrics.swap
sudo chmod 600 /var/lib/bellumetrics.swap
sudo mkswap /var/lib/bellumetrics.swap
sudo swapon /var/lib/bellumetrics.swap
echo '/var/lib/bellumetrics.swap none swap sw 0 0' | sudo tee -a /etc/fstab
```

Confirm with `swapon --show` after reboot. Do not place swap inside the
repository or the Codex authentication directory.

### Salud y recuperación

Run the following as root (it reads the root-only environment file):

```bash
sudo /opt/bellumetrics/app/deploy/oracle/healthcheck.sh
sudo journalctl -u bellumetrics-worker.service --since '1 hour ago' --no-pager
```

The health check reports only process state, the latest successful case,
exception count, latest ranking snapshot, and stale lease counts. It does not
fetch payloads or print request headers or secrets. A failed check is a reason
to inspect service status and logs, not to expose the environment file.

Leases expire and can be safely reclaimed by the worker after restart. For a
persistently failed or expired case, use the private curator panel's retry or
resolution flow; never edit leases directly in the browser. This is the lease
recovery procedure; it is safe because worker transitions are idempotent.

### Copias de seguridad y restauración

Supabase is the backup source for the queue, audit data, and snapshots. If the
VM is lost, restore a clean checkout with the installer, recreate the root-only
environment file from the secret store, reauthenticate the worker, and start
the service. Do not back up, restore, or transfer the Codex authentication
directory.

### Rotación y cierre de sesión

For ChatGPT logout or token rotation, stop the service, act only as the worker
user with its external `CODEX_HOME`, verify status, then restart:

```bash
sudo systemctl stop bellumetrics-worker.service
sudo -u bellumetrics-worker env CODEX_HOME=/var/lib/bellumetrics/codex \
  /opt/bellumetrics/app/node_modules/.bin/codex logout
sudo -u bellumetrics-worker env CODEX_HOME=/var/lib/bellumetrics/codex \
  /opt/bellumetrics/app/node_modules/.bin/codex login --device-auth
sudo -u bellumetrics-worker env CODEX_HOME=/var/lib/bellumetrics/codex \
  /opt/bellumetrics/app/node_modules/.bin/codex login status
sudo systemctl start bellumetrics-worker.service
```

To rotate the database credential, update only
`/etc/bellumetrics/worker.env` with `sudoedit`, preserve mode 600, and restart
the service. Do not put either credential in Git, CI, Vercel, Supabase tables,
or logs.
