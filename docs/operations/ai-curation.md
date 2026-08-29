# Operación del worker de curación

El worker combinado de curación y ranking se ejecuta en una instancia privada
Oracle Always Free VM.Standard.E2.1.Micro: AMD x86_64 con 1 GB de RAM. Este es
el objetivo requerido porque el artefacto Codex revisado está fijado a x86_64;
Ampere A1/Arm no es compatible con este despliegue. La instancia no es una
fuente de verdad: Supabase conserva la cola, auditoría y snapshots, por lo que
una reconstrucción no pierde trabajo. No abra listeners ni reglas de entrada
para este servicio; únicamente mantenga el acceso administrativo SSH con claves
según la política de la instancia.

## Instalación y primer inicio

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

## Memoria y swap

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

## Salud y recuperación

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

## Copias de seguridad y restauración

Supabase is the backup source for the queue, audit data, and snapshots. If the
VM is lost, restore a clean checkout with the installer, recreate the root-only
environment file from the secret store, reauthenticate the worker, and start
the service. Do not back up, restore, or transfer the Codex authentication
directory.

## Rotation and logout

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
