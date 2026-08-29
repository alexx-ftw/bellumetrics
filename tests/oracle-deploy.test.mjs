import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deploymentRoot = path.join(repositoryRoot, "deploy", "oracle");
const execFileAsync = promisify(execFile);

function parseUnit(text) {
  const sections = new Map();
  let section;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      section = heading[1];
      sections.set(section, new Map());
      continue;
    }
    const setting = /^([^=]+)=(.*)$/.exec(line);
    if (setting && section) sections.get(section).set(setting[1], setting[2]);
  }
  return sections;
}

test("Oracle worker unit runs the combined worker under an unprivileged hardened service account", async () => {
  const unitPath = path.join(deploymentRoot, "bellumetrics-worker.service");
  const unit = parseUnit(await readFile(unitPath, "utf8"));
  const service = unit.get("Service");

  assert.equal(service.get("User"), "bellumetrics-worker");
  assert.equal(service.get("Group"), "bellumetrics-worker");
  assert.equal(service.get("WorkingDirectory"), "/opt/bellumetrics/app");
  assert.equal(service.get("EnvironmentFile"), "/etc/bellumetrics/worker.env");
  assert.match(service.get("ExecStart"), /\/worker\/index\.mjs(?:\s|$)/);
  assert.equal(service.get("Restart"), "always");
  assert.equal(service.get("NoNewPrivileges"), "true");
  assert.equal(service.get("ProtectSystem"), "strict");
  assert.equal(service.get("ProtectHome"), "true");
  assert.equal(service.get("PrivateTmp"), "true");
  assert.equal(service.get("CapabilityBoundingSet"), "");
  assert.equal(service.has("ListenStream"), false);
  assert.equal(service.has("ListenDatagram"), false);
  assert.equal(service.has("Socket"), false);
});

test("Oracle package installs only production dependencies, an external auth home, and bind-fd capable bubblewrap", async () => {
  const installer = await readFile(path.join(deploymentRoot, "install.sh"), "utf8");
  const example = await readFile(path.join(deploymentRoot, "env.example"), "utf8");

  assert.match(installer, /npm ci --omit=dev/);
  assert.match(installer, /readonly config_root="\/etc\/bellumetrics"/);
  assert.match(installer, /readonly environment_file="\$\{config_root\}\/worker\.env"/);
  assert.match(installer, /install -o root -g root -m 0600 .*env\.example/);
  assert.match(installer, /readonly state_root="\/var\/lib\/bellumetrics"/);
  assert.match(installer, /readonly codex_home="\$\{state_root\}\/codex"/);
  assert.match(installer, /--bind-fd/);
  assert.match(installer, /0\.149\.1/);
  assert.doesNotMatch(installer, /auth\.json.*(?:cat|cp|base64|print)/i);
  assert.match(example, /^CURATION_CODEX_HOME=\/var\/lib\/bellumetrics\/codex$/m);
  assert.match(example, /^CURATION_CODEX_MODEL=/m);
});

test("Oracle deployment is consistently targeted at the x86_64 E2.1.Micro shape with 1 GB RAM", async () => {
  const [installer, runbook, design] = await Promise.all([
    readFile(path.join(deploymentRoot, "install.sh"), "utf8"),
    readFile(path.join(repositoryRoot, "docs", "operations", "ai-curation.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs", "superpowers", "specs", "2026-08-16-ai-curation-design.md"), "utf8"),
  ]);

  for (const document of [installer, runbook, design]) {
    assert.match(document, /VM\.Standard\.E2\.1\.Micro/);
    assert.match(document, /x86_64/i);
    assert.match(document, /1\s*GB/i);
    assert.doesNotMatch(document, /Ampere A1 Always Free ejecutará/i);
  }
  assert.match(installer, /SwapTotal/);
  assert.match(runbook, /swap/i);
});

test("Oracle installer accepts only a canonical HTTPS GitHub repository and a full commit SHA", async () => {
  const installer = await readFile(path.join(deploymentRoot, "install.sh"), "utf8");

  assert.match(installer, /BELLUMETRICS_REPOSITORY.*github\\\.com/);
  assert.match(installer, /BELLUMETRICS_REF.*\^\[0-9a-f\]\{40\}\$/);
  assert.match(installer, /git -C "\$\{app_root\}" fetch --depth 1 origin "\$\{BELLUMETRICS_REF\}"/);
  assert.match(installer, /git -C "\$\{app_root\}" rev-parse --verify HEAD/);
  assert.match(installer, /checked-out release does not match BELLUMETRICS_REF/);
});

test("Oracle environment file validation rejects links and unsafe ownership before loading credentials", async () => {
  const [installer, healthcheck] = await Promise.all([
    readFile(path.join(deploymentRoot, "install.sh"), "utf8"),
    readFile(path.join(deploymentRoot, "healthcheck.sh"), "utf8"),
  ]);

  for (const script of [installer, healthcheck]) {
    assert.match(script, /\[\[ -L \$\{environment_file\} \]\]/);
    assert.match(script, /stat -c '%u' "\$\{environment_file\}"/);
    assert.match(script, /stat -c '%a' "\$\{environment_file\}"/);
    assert.match(script, /worker_environment_(?:not_regular|symlink|owner|mode|parent)/);
  }
  assert.doesNotMatch(installer, /chown root:root "\$\{environment_file\}"/);
  assert.doesNotMatch(installer, /chmod 600 "\$\{environment_file\}"/);
});

test("Oracle installer rejects an existing world-writable config root without repairing its mode", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "bellumetrics-install-config-root-"));
  const unsafeConfigRoot = path.join(fixtureRoot, "bellumetrics");
  try {
    await mkdir(unsafeConfigRoot, { mode: 0o777 });
    await chmod(unsafeConfigRoot, 0o777);

    await assert.rejects(
      execFileAsync(
        path.join(deploymentRoot, "install.sh"),
        ["--validate-config-root", unsafeConfigRoot],
      ),
      /worker_environment_parent/,
    );

    assert.equal((await stat(unsafeConfigRoot)).mode & 0o777, 0o777);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Oracle health check is executable and limits its Supabase reads to operational metadata", async () => {
  const healthcheckPath = path.join(deploymentRoot, "healthcheck.sh");
  const healthcheck = await readFile(healthcheckPath, "utf8");

  await access(healthcheckPath, 1);
  assert.match(healthcheck, /systemctl is-active --quiet bellumetrics-worker/);
  assert.match(healthcheck, /curation_cases\?status=eq\.published&select=id,updated_at/);
  assert.match(healthcheck, /status=in\.\(awaiting_human,failed\)&select=id/);
  assert.match(healthcheck, /ranking_snapshots\?select=id,data_revision,algorithm_version,created_at/);
  assert.match(healthcheck, /lease_expires_at=lt\./);
  assert.doesNotMatch(healthcheck, /select=[^\n]*(?:payload|authorization|api[_-]?key|secret)/i);
});

test("Oracle health check sends the service credential only through curl stdin, never curl argv", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "bellumetrics-healthcheck-"));
  const fakeBin = path.join(fixtureRoot, "bin");
  const environmentFile = path.join(fixtureRoot, "worker.env");
  const curlArguments = path.join(fixtureRoot, "curl-argv");
  const serviceKey = "eyJhbGciOiJIUzI1NiJ9.test-signature";
  try {
    await mkdir(fakeBin);
    await writeFile(environmentFile, [
      "SUPABASE_URL=https://project-ref.supabase.co",
      `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
      "CURATION_CODEX_HOME=/var/lib/bellumetrics/codex",
      "",
    ].join("\n"), { mode: 0o600 });
    await chmod(environmentFile, 0o600);
    await writeFile(path.join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(path.join(fakeBin, "curl"), [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" >\"$HEALTHCHECK_CURL_ARGV\"",
      "cat >/dev/null",
      "printf '[]'",
      "",
    ].join("\n"), { mode: 0o755 });
    await chmod(path.join(fakeBin, "systemctl"), 0o755);
    await chmod(path.join(fakeBin, "curl"), 0o755);

    const { stdout } = await execFileAsync(
      path.join(deploymentRoot, "healthcheck.sh"),
      [],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
          BELLUMETRICS_WORKER_ENV_FILE: environmentFile,
          HEALTHCHECK_CURL_ARGV: curlArguments,
        },
      },
    );

    assert.match(stdout, /^process=active$/m);
    assert.match(stdout, /^health=ok$/m);
    const argumentsSeenByCurl = await readFile(curlArguments, "utf8");
    assert.match(argumentsSeenByCurl, /^--config$/m);
    assert.match(argumentsSeenByCurl, /^-$/m);
    assert.doesNotMatch(argumentsSeenByCurl, new RegExp(serviceKey));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
