import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createCodexRunner,
  verifyPinnedCodexInstallation,
} from "../worker/curation/codex-runner.mjs";
import { assertOpenAiStrictSchema } from "../lib/curation/openai-structured-output.mjs";
import {
  createCurationWorker,
} from "../worker/curation/orchestrator.mjs";
import { attachSignalHandlers, main } from "../worker/curation/index.mjs";

const execFileAsync = promisify(execFile);

const expectedCodexSecurityConfig = {
  check_for_update_on_startup: false,
  experimental_thread_store: "in_memory",
  features: {
    apply_patch_freeform: false,
    apps_mcp_path_override: false,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    code_mode: false,
    code_mode_buffered_exec: false,
    code_mode_host: false,
    code_mode_interrupt: false,
    code_mode_only: false,
    collaboration_modes: false,
    computer_use: false,
    default_mode_request_user_input: false,
    deferred_executor: false,
    deferred_tool_world_state: false,
    enable_fanout: false,
    enable_mcp_apps: false,
    exec_permission_approvals: false,
    executor_capability_discovery: false,
    external_agent_memory_import: false,
    external_migration: false,
    goals: false,
    hooks: false,
    in_app_browser: false,
    in_app_chat: false,
    in_app_updates: false,
    js_repl: false,
    js_repl_tools_only: false,
    mcp_2026_07_28: false,
    mentions_v2: false,
    multi_agent: false,
    multi_agent_v2: false,
    non_prefixed_mcp_tool_names: false,
    plugins: false,
    plugin_hooks: false,
    plugin_sharing: false,
    psp: false,
    recommended_plugins: false,
    realtime_conversation: false,
    remote_control: false,
    remote_plugin: false,
    request_permissions_tool: false,
    request_rule: false,
    search_tool: false,
    send_async_message: false,
    shell_snapshot: false,
    shell_tool: false,
    shell_zsh_fork: false,
    skill_env_var_dependency_prompt: false,
    skill_mcp_dependency_install: false,
    skill_search: false,
    standalone_web_search: false,
    terminal_visualization_instructions: false,
    tool_call_mcp_elicitation: false,
    tool_search: false,
    tool_search_always_defer_mcp_tools: false,
    tool_suggest: false,
    unavailable_dummy_tools: false,
    unified_exec: false,
    unified_exec_zsh_fork: false,
    view_image: false,
    web_search_cached: false,
    web_search_request: false,
    workspace_dependencies: false,
  },
  file_opener: "none",
  history: { persistence: "none" },
  hooks: {},
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  log_dir: "/tmp/codex-runtime/log",
  marketplaces: {},
  mcp_servers: {},
  plugins: {},
  shell_environment_policy: {
    ignore_default_excludes: false,
    inherit: "none",
  },
  sqlite_home: "/tmp/codex-runtime/sqlite",
  tools: {
    experimental_request_user_input: false,
    update_plan: false,
    web_search: true,
  },
};

function credentialDirectoryStats({
  directory = true,
  mode = 0o40700,
  symbolicLink = false,
  uid = process.getuid(),
} = {}) {
  return {
    mode,
    uid,
    isDirectory: () => directory,
    isSymbolicLink: () => symbolicLink,
  };
}

const safeCredentialDirectoryLstat = async () => credentialDirectoryStats();

const leasedCase = {
  id: 41,
  case_key: "battle:waterloo",
  entity_type: "battle",
  source_revision: "source-v1",
  payload: {
    stagedRecord: { title: "Battle of Waterloo", year: 1815 },
    canonicalCandidates: [{ id: "battle:waterloo", title: "Waterloo" }],
    rubric: { requirePrimarySources: true },
  },
};

function rejection(promptVersion, reason = "The evidence does not meet the rubric.") {
  return {
    action: "reject_battle",
    evidence: [{
      citation: "Chandler, The Campaigns of Napoleon, p. 1021",
      url: "https://example.test/chandler-waterloo",
      locator: "p. 1021",
    }],
    reason,
    canonicalMutation: null,
    dataRevision: "source-v1",
    promptVersion,
    confidence: 0.8,
  };
}

function escalation(promptVersion) {
  return {
    action: "escalate",
    evidence: [{ citation: "The available sources conflict." }],
    reason: "A human curator must resolve the source conflict.",
    canonicalMutation: null,
    dataRevision: "source-v1",
    promptVersion,
  };
}

function identityDecision(action, promptVersion) {
  return {
    action,
    evidence: [{ citation: "Identity evidence from the staged source." }],
    reason: "The cited identities are unambiguous.",
    canonicalMutation: {
      action,
      source: { type: "commander", id: "wikidata:Q1" },
      target: { type: "commander", id: "wikidata:Q2" },
    },
    dataRevision: "source-v1",
    promptVersion,
  };
}

function approvalDecision(promptVersion) {
  return {
    action: "approve_battle",
    evidence: [{
      citation: "Chandler, The Campaigns of Napoleon, p. 1021",
      url: "https://example.test/chandler-waterloo",
      locator: "p. 1021",
    }],
    reason: "The source identifies the battle and its commanders.",
    canonicalMutation: {
      action: "approve_battle",
      battle: {
        ref: { type: "battle", id: "war-atlas:waterloo" },
        slug: "waterloo",
        title: "Battle of Waterloo",
        startYear: 1815,
        endYear: 1815,
        outcome: "victory",
      },
      commanderRefs: [
        { type: "commander", id: "wikidata:Q517" },
        { type: "commander", id: "wikidata:Q152245" },
      ],
    },
    dataRevision: "source-v1",
    promptVersion,
    confidence: 0.92,
  };
}

function fakeRepository({ reviews = [], leases = [leasedCase], events = [] } = {}) {
  const storedReviews = [...reviews];
  const remainingLeases = [...leases];
  return {
    storedReviews,
    async lease() {
      events.push("lease");
      return remainingLeases.shift() ?? null;
    },
    async heartbeat() {
      events.push("heartbeat");
      return true;
    },
    async readReviews() {
      events.push("read-reviews");
      return storedReviews.map((review) => structuredClone(review));
    },
    async recordReview(review) {
      events.push(`record-${review.reviewRole}`);
      storedReviews.push({
        review_role: review.reviewRole,
        model: review.model,
        prompt_version: review.promptVersion,
        evidence: review.evidence,
        decision: review.decision,
      });
      return storedReviews.length;
    },
    async release({ outcome }) {
      events.push(`release-${outcome}`);
      return true;
    },
  };
}

const skipPinnedCodexVerification = async () => {};

test("pinned Codex verifier accepts only the reviewed installed capability registry", async () => {
  assert.deepEqual(await verifyPinnedCodexInstallation(), {
    version: "0.149.1",
    target: "x86_64-unknown-linux-musl",
    allowedAgentTools: ["web_search"],
  });

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-unreviewed-binary-"));
  try {
    const unreviewedExecutable = path.join(fixtureRoot, "codex");
    await writeFile(unreviewedExecutable, "not the reviewed Codex binary\n", "utf8");

    await assert.rejects(
      verifyPinnedCodexInstallation({ codexExecutable: unreviewedExecutable }),
      /Codex (installation|binary|capability registry).*not reviewed/i,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("pinned Codex verifier derives the sole allowed tool from a complete fail-closed policy", async () => {
  const incompletePolicy = structuredClone(expectedCodexSecurityConfig);
  const omittedCapabilities = [
    "code_mode",
    "code_mode_host",
    "deferred_executor",
    "hooks",
    "in_app_browser",
    "multi_agent_v2",
    "plugins",
    "tool_suggest",
  ];
  for (const capability of omittedCapabilities) {
    delete incompletePolicy.features[capability];
  }

  await assert.rejects(
    verifyPinnedCodexInstallation({ securityConfig: incompletePolicy }),
    (error) => {
      assert.match(error.message, /capability policy.*explicit deny/i);
      for (const capability of omittedCapabilities) {
        assert.match(error.message, new RegExp(capability));
      }
      return true;
    },
  );

  const permissivePolicy = structuredClone(expectedCodexSecurityConfig);
  permissivePolicy.features.code_mode = true;
  await assert.rejects(
    verifyPinnedCodexInstallation({ securityConfig: permissivePolicy }),
    /capability policy.*must be false: code_mode/i,
  );
});

test("Codex runner refuses an unverified effective capability registry", async () => {
  let clientConstructed = false;
  const runner = createCodexRunner({
    cwd: process.cwd(),
    model: "gpt-test",
    launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
    codexExecutable: "/opt/openai/codex",
    credentialDirectory: "/var/lib/bellumetrics/codex-home",
    accessImpl: async () => {},
    lstatImpl: safeCredentialDirectoryLstat,
    realpathImpl: async (candidate) => candidate,
    verifyCodexInstallationImpl: async () => {
      throw new Error("Codex capability registry is not reviewed");
    },
    codexFactory: async () => {
      clientConstructed = true;
      throw new Error("unverified Codex must not be constructed");
    },
  });

  await assert.rejects(
    runner.runProposer(leasedCase),
    /capability registry is not reviewed/i,
  );
  assert.equal(clientConstructed, false);
});

test("Codex runner uses fresh read-only isolated threads with identical raw case context", async () => {
  const threadCalls = [];
  const clientOptions = [];
  const finalResponses = [
    rejection("proposer-v1", "PROPOSER-PRIVATE-SENTINEL"),
    rejection("reviewer-v1", "Independent reviewer conclusion."),
  ];
  const codexFactory = async (options) => {
    clientOptions.push(options);
    return {
      startThread(threadOptions) {
        const threadNumber = threadCalls.length;
        return {
          async run(prompt, turnOptions) {
            const rawCaseContext = await readFile(
              path.join(threadOptions.workingDirectory, "case-context.json"),
              "utf8",
            );
            const instructions = await readFile(
              path.join(threadOptions.workingDirectory, "instructions.md"),
              "utf8",
            );
            threadCalls.push({
              options: threadOptions,
              prompt,
              turnOptions,
              rawCaseContext,
              instructions,
            });
            return {
              items: [],
              finalResponse: JSON.stringify(finalResponses[threadNumber]),
              usage: null,
            };
          },
        };
      },
    };
  };
  const runner = createCodexRunner({
    cwd: process.cwd(),
    model: "gpt-test",
    reasoningEffort: "high",
    codexFactory,
    launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
    codexExecutable: "/opt/openai/codex",
    credentialDirectory: "/var/lib/bellumetrics/codex-home",
    bwrapExecutable: "/usr/bin/bwrap",
    sourceEnv: {
      LANG: "host-locale",
      HTTPS_PROXY: "http://proxy.test:8443",
      NO_PROXY: "localhost,127.0.0.1",
      OPENAI_API_KEY: "must-not-leak",
      SUPABASE_SERVICE_ROLE_KEY: "must-not-leak",
      DATABASE_URL: "must-not-leak",
      APPLICATION_SECRET: "must-not-leak",
    },
    accessImpl: async () => {},
    lstatImpl: safeCredentialDirectoryLstat,
    realpathImpl: async (candidate) => candidate,
    verifyCodexInstallationImpl: skipPinnedCodexVerification,
  });

  assert.deepEqual(await runner.runProposer(leasedCase), finalResponses[0]);
  assert.deepEqual(await runner.runReviewer(leasedCase), finalResponses[1]);

  assert.equal(threadCalls.length, 2);
  assert.equal(clientOptions.length, 2);
  assert.notEqual(threadCalls[0].options.workingDirectory, threadCalls[1].options.workingDirectory);
  for (const [index, call] of threadCalls.entries()) {
    assert.deepEqual(clientOptions[index], {
      codexPathOverride: "/opt/bellumetrics/codex-isolation-launcher.sh",
      config: expectedCodexSecurityConfig,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
        HTTPS_PROXY: "http://proxy.test:8443",
        NO_PROXY: "localhost,127.0.0.1",
        CODEX_BWRAP_EXECUTABLE: "/usr/bin/bwrap",
        CODEX_REAL_EXECUTABLE: "/opt/openai/codex",
        CODEX_RESEARCH_DIRECTORY: call.options.workingDirectory,
        CODEX_CREDENTIAL_DIRECTORY: "/var/lib/bellumetrics/codex-home",
      },
    });
    assert.equal(call.options.sandboxMode, "read-only");
    assert.equal(call.options.approvalPolicy, "never");
    assert.equal(call.options.networkAccessEnabled, true);
    assert.equal(call.options.webSearchMode, "live");
    assert.equal(call.options.model, "gpt-test");
    assert.equal(call.options.modelReasoningEffort, "high");
    assert.equal(call.options.skipGitRepoCheck, true);
    assert.equal(call.options.workingDirectory.startsWith(process.cwd()), false);
    assert.deepEqual(JSON.parse(call.rawCaseContext), leasedCase);
    assert.match(call.instructions, /only.*JSON/i);
    assert.equal(typeof call.turnOptions.outputSchema, "object");
  }
  assert.equal(threadCalls[0].rawCaseContext, threadCalls[1].rawCaseContext);
  assert.doesNotMatch(threadCalls[1].prompt, /PROPOSER-PRIVATE-SENTINEL/);
  await assert.rejects(access(threadCalls[0].options.workingDirectory), /ENOENT/);
  await assert.rejects(access(threadCalls[1].options.workingDirectory), /ENOENT/);
});

test("Codex runner fails closed before client construction when bubblewrap is unavailable", async () => {
  let clientConstructed = false;
  const runner = createCodexRunner({
    cwd: process.cwd(),
    model: "gpt-test",
    launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
    codexExecutable: "/opt/openai/codex",
    credentialDirectory: "/var/lib/bellumetrics/codex-home",
    bwrapExecutable: "/missing/bwrap",
    accessImpl: async (candidate) => {
      if (candidate === "/missing/bwrap") {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
    },
    codexFactory: async () => {
      clientConstructed = true;
      throw new Error("must not construct Codex without isolation");
    },
    verifyCodexInstallationImpl: skipPinnedCodexVerification,
  });

  await assert.rejects(runner.runProposer(leasedCase), /bubblewrap isolation unavailable/i);
  assert.equal(clientConstructed, false);
});

test("Codex runner rejects proxy URLs containing credentials before client construction", async () => {
  let clientConstructed = false;
  const runner = createCodexRunner({
    cwd: process.cwd(),
    model: "gpt-test",
    launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
    codexExecutable: "/opt/openai/codex",
    credentialDirectory: "/var/lib/bellumetrics/codex-home",
    sourceEnv: {
      HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.test:8443",
    },
    accessImpl: async () => {},
    lstatImpl: safeCredentialDirectoryLstat,
    realpathImpl: async (candidate) => candidate,
    codexFactory: async () => {
      clientConstructed = true;
      throw new Error("credentialed proxy must not reach Codex");
    },
    verifyCodexInstallationImpl: skipPinnedCodexVerification,
  });

  await assert.rejects(
    runner.runProposer(leasedCase),
    /HTTPS_PROXY.*must not contain userinfo/i,
  );
  assert.equal(clientConstructed, false);
});

test("Codex runner rejects the original credential-directory symlink before realpath", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-credential-boundary-"));
  try {
    const repositoryRoot = path.join(fixtureRoot, "repository");
    const credentialTarget = path.join(fixtureRoot, "credentials");
    const credentialLink = path.join(fixtureRoot, "external-credentials");
    await Promise.all([
      mkdir(repositoryRoot),
      mkdir(credentialTarget),
    ]);
    await symlink(credentialTarget, credentialLink);
    let clientConstructed = false;
    const runner = createCodexRunner({
      cwd: repositoryRoot,
      model: "gpt-test",
      launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
      codexExecutable: "/opt/openai/codex",
      credentialDirectory: credentialLink,
      accessImpl: async () => {},
      codexFactory: async () => {
        clientConstructed = true;
        throw new Error("must not mount repository credentials");
      },
      verifyCodexInstallationImpl: skipPinnedCodexVerification,
    });

    await assert.rejects(
      runner.runProposer(leasedCase),
      /credentialDirectory must not be a symbolic link/i,
    );
    assert.equal(clientConstructed, false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Codex runner requires a worker-owned credential directory without group or other writes", async (t) => {
  const workerUid = process.getuid();
  const scenarios = [
    {
      name: "different owner",
      stats: credentialDirectoryStats({ uid: workerUid + 1 }),
      error: /credentialDirectory must be owned by the worker/i,
    },
    {
      name: "mode 0777",
      stats: credentialDirectoryStats({ mode: 0o40777 }),
      error: /credentialDirectory must not be group- or other-writable/i,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let clientConstructed = false;
      const runner = createCodexRunner({
        cwd: process.cwd(),
        model: "gpt-test",
        launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
        codexExecutable: "/opt/openai/codex",
        credentialDirectory: "/var/lib/bellumetrics/codex-home",
        accessImpl: async () => {},
        lstatImpl: async () => scenario.stats,
        realpathImpl: async (candidate) => candidate,
        verifyCodexInstallationImpl: skipPinnedCodexVerification,
        codexFactory: async () => {
          clientConstructed = true;
          throw new Error("unsafe credential directory reached Codex construction");
        },
      });

      await assert.rejects(runner.runProposer(leasedCase), scenario.error);
      assert.equal(clientConstructed, false);
    });
  }
});

test("Codex runner validates the original credential path and preserves it for the launcher", async () => {
  const calls = [];
  let launcherEnvironment;
  const credentialDirectory = "/var/lib/bellumetrics/codex-home";
  const canonicalCredentialDirectory = "/srv/codex-auth-state";
  const runner = createCodexRunner({
    cwd: process.cwd(),
    model: "gpt-test",
    launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
    codexExecutable: "/opt/openai/codex",
    credentialDirectory,
    accessImpl: async () => {},
    lstatImpl: async (candidate) => {
      calls.push(`lstat:${candidate}`);
      return credentialDirectoryStats();
    },
    realpathImpl: async (candidate) => {
      calls.push(`realpath:${candidate}`);
      return candidate === credentialDirectory ? canonicalCredentialDirectory : candidate;
    },
    verifyCodexInstallationImpl: skipPinnedCodexVerification,
    codexFactory: async (options) => {
      launcherEnvironment = options.env;
      return {
        startThread() {
          return {
            async run() {
              return {
                items: [],
                finalResponse: JSON.stringify(rejection("proposer-v1")),
                usage: null,
              };
            },
          };
        },
      };
    },
  });

  await runner.runProposer(leasedCase);

  assert.equal(calls[0], `lstat:${credentialDirectory}`);
  assert.equal(calls.includes(`realpath:${credentialDirectory}`), true);
  assert.equal(
    launcherEnvironment.CODEX_CREDENTIAL_DIRECTORY,
    credentialDirectory,
  );
});

test("Codex runner rejects a turn that used any agent tool other than hosted web search", async () => {
  let callCount = 0;
  const runner = createCodexRunner({
    cwd: process.cwd(),
    model: "gpt-test",
    launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
    codexExecutable: "/opt/openai/codex",
    credentialDirectory: "/var/lib/bellumetrics/codex-home",
    accessImpl: async () => {},
    lstatImpl: safeCredentialDirectoryLstat,
    realpathImpl: async (candidate) => candidate,
    verifyCodexInstallationImpl: skipPinnedCodexVerification,
    codexFactory: async () => ({
      startThread() {
        return {
          async run() {
            callCount += 1;
            return {
              items: [{
                id: "tool-1",
                type: "command_execution",
                command: "id",
                aggregated_output: "",
                exit_code: 0,
                status: "completed",
              }],
              finalResponse: JSON.stringify(rejection("proposer-v1")),
              usage: null,
            };
          },
        };
      },
    }),
  });

  await assert.rejects(
    runner.runProposer(leasedCase),
    /unapproved Codex tool item: command_execution/i,
  );
  assert.equal(callCount, 1);
});

test("worker entrypoint requires a dedicated external Codex credential directory", async () => {
  await assert.rejects(
    main({
      argv: ["--once"],
      env: {
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-secret",
        CURATION_CODEX_MODEL: "gpt-test",
      },
      processLike: new EventEmitter(),
      fetchImpl: async () => new Response("null", { status: 200 }),
    }),
    /CURATION_CODEX_HOME is required/,
  );
});

test("Codex output schema and prompts cover every exact decision mutation shape", async () => {
  const expectedDecisions = [
    approvalDecision("proposer-v1"),
    rejection("proposer-v1"),
    escalation("proposer-v1"),
    identityDecision("merge_commanders", "proposer-v1"),
    identityDecision("separate_commanders", "proposer-v1"),
  ];
  const decisions = expectedDecisions.map((decision) => ({
    ...decision,
    confidence: decision.confidence ?? null,
    evidence: decision.evidence.map((item) => ({
      ...item,
      url: item.url ?? null,
      locator: item.locator ?? null,
    })),
  }));
  const schemas = [];
  const prompts = [];
  const codexFactory = async () => ({
    startThread() {
      return {
        async run(prompt, { outputSchema }) {
          prompts.push(prompt);
          schemas.push(outputSchema);
          return {
            items: [],
            finalResponse: JSON.stringify(decisions[schemas.length - 1]),
            usage: null,
          };
        },
      };
    },
  });
  const runner = createCodexRunner({
    cwd: process.cwd(),
    model: "gpt-test",
    codexFactory,
    launcherPath: "/opt/bellumetrics/codex-isolation-launcher.sh",
    codexExecutable: "/opt/openai/codex",
    credentialDirectory: "/var/lib/bellumetrics/codex-home",
    accessImpl: async () => {},
    lstatImpl: safeCredentialDirectoryLstat,
    realpathImpl: async (candidate) => candidate,
    verifyCodexInstallationImpl: skipPinnedCodexVerification,
  });

  for (const expectedDecision of expectedDecisions) {
    assert.deepEqual(await runner.runProposer(leasedCase), expectedDecision);
  }

  assert.equal(schemas.length, 5);
  for (const schema of schemas) {
    assert.equal(assertOpenAiStrictSchema(schema), schema);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      schema.required,
      [
        "action",
        "evidence",
        "reason",
        "confidence",
        "canonicalMutation",
        "dataRevision",
        "promptVersion",
      ],
    );
    assert.deepEqual(schema.properties.action.enum, [
      "approve_battle",
      "reject_battle",
      "escalate",
      "merge_commanders",
      "separate_commanders",
    ]);
    assert.deepEqual(schema.properties.confidence.type, ["number", "null"]);
    assert.deepEqual(
      schema.properties.evidence.items.required,
      ["citation", "url", "locator"],
    );
    assert.deepEqual(schema.properties.evidence.items.properties.url.type, [
      "string",
      "null",
    ]);
    const mutationVariants = schema.properties.canonicalMutation.anyOf;
    assert.equal(mutationVariants.length, 4);
    const [approval, nullMutation, merge, separation] = mutationVariants;
    assert.deepEqual(
      Object.keys(approval.properties),
      ["action", "battle", "commanderRefs"],
    );
    assert.equal(approval.additionalProperties, false);
    assert.equal(
      approval.properties.battle.additionalProperties,
      false,
    );
    assert.deepEqual(approval.properties.battle.required, [
      "ref",
      "slug",
      "title",
      "startYear",
      "endYear",
      "outcome",
    ]);
    assert.deepEqual(nullMutation, { type: "null" });
    for (const identityShape of [merge, separation]) {
      assert.deepEqual(
        Object.keys(identityShape.properties),
        ["action", "source", "target"],
      );
      assert.equal(identityShape.additionalProperties, false);
    }
  }
  for (const prompt of prompts) {
    assert.match(prompt, /"action": "approve_battle"/);
    assert.match(prompt, /"commanderRefs"/);
    assert.match(prompt, /"action": "reject_battle"/);
    assert.match(prompt, /"action": "escalate"/);
    assert.match(prompt, /"action": "merge_commanders"/);
    assert.match(prompt, /"action": "separate_commanders"/);
    assert.match(prompt, /"source": \{ "type": "commander", "id":/);
    assert.match(prompt, /"target": \{ "type": "commander", "id":/);
    assert.match(prompt, /"confidence": null/);
    assert.match(prompt, /"url": null/);
    assert.match(prompt, /all fields.*required/i);
  }
});

test("isolation launcher exposes only per-run inputs and not the repository", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-output-schema-"));
  try {
    const fakeBwrap = path.join(fixtureRoot, "bwrap");
    const fakeCodex = path.join(fixtureRoot, "codex");
    const researchDirectory = path.join(fixtureRoot, "research");
    const credentialDirectory = path.join(fixtureRoot, "credentials");
    const schemaPath = path.join(fixtureRoot, "schema.json");
    await Promise.all([
      mkdir(researchDirectory),
      mkdir(credentialDirectory),
      writeFile(fakeBwrap, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", "utf8"),
      writeFile(fakeCodex, "#!/bin/sh\nexit 99\n", "utf8"),
      writeFile(path.join(credentialDirectory, "auth.json"), "fake-auth-fixture\n", {
        encoding: "utf8",
        mode: 0o600,
      }),
      writeFile(schemaPath, "{}\n", "utf8"),
    ]);
    await Promise.all([chmod(fakeBwrap, 0o755), chmod(fakeCodex, 0o755)]);

    const launcher = fileURLToPath(new URL(
      "../worker/curation/codex-isolation-launcher.sh",
      import.meta.url,
    ));
    const { stdout } = await execFileAsync(
      launcher,
      ["exec", "--output-schema", schemaPath, "--json"],
      {
      env: {
        CODEX_BWRAP_EXECUTABLE: fakeBwrap,
        CODEX_REAL_EXECUTABLE: fakeCodex,
        CODEX_RESEARCH_DIRECTORY: researchDirectory,
        CODEX_CREDENTIAL_DIRECTORY: credentialDirectory,
        },
      },
    );
    const argumentsPassed = stdout.trim().split("\n");

    assert.equal(argumentsPassed.includes("--clearenv"), true);
    assert.equal(argumentsPassed.includes("--unshare-all"), true);
    assert.equal(argumentsPassed.includes("--share-net"), true);
    const mountSources = argumentsPassed.flatMap((value, index) => (
      value === "--bind" || value === "--ro-bind"
        ? [argumentsPassed[index + 1]]
        : []
    ));
    for (const forbiddenSource of ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl"]) {
      assert.equal(
        mountSources.includes(forbiddenSource),
        false,
        `launcher exposed broad runtime tree ${forbiddenSource}`,
      );
    }
    const forbiddenCheckout = "/usr/src/app";
    assert.equal(
      mountSources.some((source) => (
        forbiddenCheckout === source || forbiddenCheckout.startsWith(`${source}/`)
      )),
      false,
      "a checkout under /usr must remain hidden",
    );
    assert.equal(
      mountSources.includes("/etc/ssl/certs/ca-certificates.crt"),
      true,
    );
    assert.deepEqual(
      argumentsPassed.slice(argumentsPassed.indexOf(researchDirectory) - 1, argumentsPassed.indexOf(researchDirectory) + 2),
      ["--ro-bind", researchDirectory, researchDirectory],
    );
    const credentialBindIndex = argumentsPassed.indexOf("--bind-fd");
    assert.notEqual(credentialBindIndex, -1);
    assert.match(argumentsPassed[credentialBindIndex + 1], /^\d+$/);
    assert.equal(argumentsPassed[credentialBindIndex + 2], "/codex-home");
    assert.equal(argumentsPassed.includes(credentialDirectory), false);
    const innerPathIndex = argumentsPassed.findIndex((value, index) => (
      value === "PATH" && argumentsPassed[index - 1] === "--setenv"
    ));
    const innerShellIndex = argumentsPassed.findIndex((value, index) => (
      value === "SHELL" && argumentsPassed[index - 1] === "--setenv"
    ));
    assert.equal(argumentsPassed[innerPathIndex + 1], "/nonexistent");
    assert.equal(argumentsPassed[innerShellIndex + 1], "/nonexistent");
    assert.deepEqual(
      argumentsPassed.slice(argumentsPassed.indexOf(schemaPath) - 1, argumentsPassed.indexOf(schemaPath) + 2),
      ["--ro-bind", schemaPath, schemaPath],
    );
    const schemaDirectoryIndex = argumentsPassed.findIndex((value, index) => (
      value === fixtureRoot && argumentsPassed[index - 1] === "--dir"
    ));
    assert.notEqual(schemaDirectoryIndex, -1);
    assert.equal(argumentsPassed.includes(process.cwd()), false);
    assert.deepEqual(argumentsPassed.slice(-5), [
      "/opt/codex/codex",
      "exec",
      "--output-schema",
      schemaPath,
      "--json",
    ]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("isolation launcher accepts only one regular auth.json credential-state file", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-output-schema-"));
  try {
    const fakeBwrap = path.join(fixtureRoot, "bwrap");
    const fakeCodex = path.join(fixtureRoot, "codex");
    const researchDirectory = path.join(fixtureRoot, "research");
    const credentialDirectory = path.join(fixtureRoot, "credentials");
    const schemaPath = path.join(fixtureRoot, "schema.json");
    await Promise.all([
      mkdir(researchDirectory),
      writeFile(fakeBwrap, "#!/bin/sh\nexit 99\n", "utf8"),
      writeFile(fakeCodex, "#!/bin/sh\nexit 99\n", "utf8"),
      writeFile(schemaPath, "{}\n", "utf8"),
    ]);
    await Promise.all([chmod(fakeBwrap, 0o755), chmod(fakeCodex, 0o755)]);
    const launcher = fileURLToPath(new URL(
      "../worker/curation/codex-isolation-launcher.sh",
      import.meta.url,
    ));

    const rejectedStates = [
      ["credential directory mode 0777", async () => {
        await chmod(credentialDirectory, 0o777);
      }],
      ["AGENTS.override.md", async () => {
        await writeFile(path.join(credentialDirectory, "AGENTS.override.md"), "override\n");
      }],
      ["hooks/hooks.json", async () => {
        await mkdir(path.join(credentialDirectory, "hooks"));
        await writeFile(path.join(credentialDirectory, "hooks", "hooks.json"), "{}\n");
      }],
      ["arbitrary file", async () => {
        await writeFile(path.join(credentialDirectory, "notes.txt"), "not auth state\n");
      }],
      ["missing auth.json", async () => {
        await rm(path.join(credentialDirectory, "auth.json"));
      }],
      ["auth.json directory", async () => {
        await rm(path.join(credentialDirectory, "auth.json"));
        await mkdir(path.join(credentialDirectory, "auth.json"));
      }],
      ["auth.json symlink", async () => {
        const target = path.join(fixtureRoot, "outside-auth.json");
        await writeFile(target, "outside fixture\n");
        await rm(path.join(credentialDirectory, "auth.json"));
        await symlink(target, path.join(credentialDirectory, "auth.json"));
      }],
    ];

    for (const [name, mutate] of rejectedStates) {
      await rm(credentialDirectory, { recursive: true, force: true });
      await mkdir(credentialDirectory);
      await writeFile(path.join(credentialDirectory, "auth.json"), "fake-auth-fixture\n", {
        mode: 0o600,
      });
      await mutate();

      await assert.rejects(
        execFileAsync(launcher, ["exec", "--output-schema", schemaPath, "--json"], {
          env: {
            CODEX_BWRAP_EXECUTABLE: fakeBwrap,
            CODEX_REAL_EXECUTABLE: fakeCodex,
            CODEX_RESEARCH_DIRECTORY: researchDirectory,
            CODEX_CREDENTIAL_DIRECTORY: credentialDirectory,
          },
        }),
        (error) => {
          assert.equal(error.code, 78, name);
          assert.match(error.stderr, /credential auth-state allowlist/i, name);
          return true;
        },
      );
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("isolation launcher binds a stable credential descriptor across writable-ancestor substitution", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-output-schema-race-"));
  try {
    const fakeBwrap = path.join(fixtureRoot, "bwrap");
    const fakeCodex = path.join(fixtureRoot, "codex");
    const researchDirectory = path.join(fixtureRoot, "research");
    const credentialDirectory = path.join(fixtureRoot, "credentials");
    const schemaPath = path.join(fixtureRoot, "schema.json");
    const fakeBwrapSource = `#!/bin/bash
set -euo pipefail
credential_fd=
arguments=("$@")
for ((index = 0; index < \${#arguments[@]}; index += 1)); do
  if [[ \${arguments[$index]} == --bind-fd ]]; then
    credential_fd=\${arguments[$((index + 1))]:-}
    [[ \${arguments[$((index + 2))]:-} == /codex-home ]]
    break
  fi
done
if [[ ! $credential_fd =~ ^[0-9]+$ ]]; then
  echo "stable credential descriptor missing" >&2
  exit 97
fi
original_identity=$(stat -Lc '%d:%i' -- "$CODEX_CREDENTIAL_DIRECTORY")
mv -- "$CODEX_CREDENTIAL_DIRECTORY" "$CODEX_CREDENTIAL_DIRECTORY-original"
mkdir -m 0700 -- "$CODEX_CREDENTIAL_DIRECTORY"
descriptor_identity=$(stat -Lc '%d:%i' -- "/proc/self/fd/$credential_fd")
replacement_identity=$(stat -Lc '%d:%i' -- "$CODEX_CREDENTIAL_DIRECTORY")
printf 'original=%s\ndescriptor=%s\nreplacement=%s\n' \
  "$original_identity" "$descriptor_identity" "$replacement_identity"
[[ $descriptor_identity == "$original_identity" ]]
[[ $descriptor_identity != "$replacement_identity" ]]
`;
    await Promise.all([
      mkdir(researchDirectory),
      mkdir(credentialDirectory),
      writeFile(fakeBwrap, fakeBwrapSource, "utf8"),
      writeFile(fakeCodex, "#!/bin/sh\nexit 99\n", "utf8"),
      writeFile(path.join(credentialDirectory, "auth.json"), "fake-auth-fixture\n", {
        encoding: "utf8",
        mode: 0o600,
      }),
      writeFile(schemaPath, "{}\n", "utf8"),
    ]);
    await Promise.all([
      chmod(fakeBwrap, 0o755),
      chmod(fakeCodex, 0o755),
      chmod(fixtureRoot, 0o777),
    ]);

    const launcher = fileURLToPath(new URL(
      "../worker/curation/codex-isolation-launcher.sh",
      import.meta.url,
    ));
    const { stdout } = await execFileAsync(
      launcher,
      ["exec", "--output-schema", schemaPath, "--json"],
      {
        env: {
          CODEX_BWRAP_EXECUTABLE: fakeBwrap,
          CODEX_REAL_EXECUTABLE: fakeCodex,
          CODEX_RESEARCH_DIRECTORY: researchDirectory,
          CODEX_CREDENTIAL_DIRECTORY: credentialDirectory,
        },
      },
    );
    const identities = Object.fromEntries(stdout.trim().split("\n").map((line) => (
      line.split("=", 2)
    )));

    assert.equal(identities.descriptor, identities.original);
    assert.notEqual(identities.descriptor, identities.replacement);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("worker persists each independent review before consensus and dry execution", async () => {
  const events = [];
  const repository = fakeRepository({ events });
  let proposerContext;
  let reviewerContext;
  const runner = {
    async runProposer(caseContext) {
      events.push("proposer");
      proposerContext = structuredClone(caseContext);
      return JSON.stringify(rejection("proposer-v1", "PROPOSER-PRIVATE-SENTINEL"));
    },
    async runReviewer(caseContext) {
      events.push("reviewer");
      reviewerContext = structuredClone(caseContext);
      return rejection("reviewer-v1", "Independent reviewer conclusion.");
    },
  };
  const worker = createCurationWorker({
    repository,
    runner,
    workerId: "worker-a",
    model: "gpt-test",
    resolveConsensusFn(proposal, review) {
      events.push("consensus");
      assert.equal(proposal.action, "reject_battle");
      assert.equal(review.action, "reject_battle");
      return { kind: "execute", decision: proposal };
    },
    async executeDecision() {
      events.push("execute");
    },
  });

  const result = await worker.runOnce();

  assert.equal(result.kind, "execute");
  assert.deepEqual(events, [
    "lease",
    "read-reviews",
    "proposer",
    "record-proposer",
    "reviewer",
    "record-reviewer",
    "consensus",
    "heartbeat",
    "execute",
    "release-rejected",
  ]);
  assert.deepEqual(proposerContext, reviewerContext);
  assert.deepEqual(reviewerContext, {
    caseId: 41,
    caseKey: "battle:waterloo",
    entityType: "battle",
    dataRevision: "source-v1",
    payload: leasedCase.payload,
  });
  assert.doesNotMatch(JSON.stringify(reviewerContext), /PROPOSER-PRIVATE-SENTINEL/);
});

test("new decisions must match the leased revision, role version, and entity type", async (t) => {
  const commanderCase = {
    ...leasedCase,
    id: 42,
    case_key: "commander:identity",
    entity_type: "commander",
  };
  const scenarios = [
    {
      name: "stale proposer data revision",
      leased: leasedCase,
      proposer: { ...rejection("proposer-v1"), dataRevision: "source-v0" },
      reviewer: rejection("reviewer-v1"),
      expectedRecords: [],
      error: /dataRevision.*source-v1/i,
    },
    {
      name: "reviewer carrying the proposer prompt version",
      leased: leasedCase,
      proposer: rejection("proposer-v1"),
      reviewer: rejection("proposer-v1"),
      expectedRecords: ["record-proposer"],
      error: /promptVersion.*reviewer-v1/i,
    },
    {
      name: "battle-only action for a commander case",
      leased: commanderCase,
      proposer: rejection("proposer-v1"),
      reviewer: rejection("reviewer-v1"),
      expectedRecords: [],
      error: /reject_battle.*commander/i,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const events = [];
      let executed = false;
      const worker = createCurationWorker({
        repository: fakeRepository({ events, leases: [scenario.leased] }),
        runner: {
          runProposer: async () => scenario.proposer,
          runReviewer: async () => scenario.reviewer,
        },
        workerId: "worker-a",
        model: "gpt-test",
        executeDecision: async () => {
          executed = true;
        },
      });

      await assert.rejects(worker.runOnce(), scenario.error);
      assert.deepEqual(
        events.filter((event) => event.startsWith("record-")),
        scenario.expectedRecords,
      );
      assert.equal(executed, false);
    });
  }
});

test("stored reviews must retain compatible role, model, and revision metadata", async (t) => {
  const validProposal = rejection("proposer-v1");
  const validReview = rejection("reviewer-v1");
  const baseRows = [
    {
      review_role: "proposer",
      model: "gpt-test",
      prompt_version: "proposer-v1",
      evidence: validProposal.evidence,
      decision: validProposal,
    },
    {
      review_role: "reviewer",
      model: "gpt-test",
      prompt_version: "reviewer-v1",
      evidence: validReview.evidence,
      decision: validReview,
    },
  ];
  const scenarios = [
    {
      name: "wrong stored model",
      rows: [{ ...baseRows[0], model: "gpt-old" }, baseRows[1]],
      error: /stored proposer model.*gpt-test/i,
    },
    {
      name: "wrong stored role version",
      rows: [{ ...baseRows[0], prompt_version: "reviewer-v1" }, baseRows[1]],
      error: /stored proposer prompt_version.*proposer-v1/i,
    },
    {
      name: "stale stored decision revision",
      rows: [
        {
          ...baseRows[0],
          decision: { ...validProposal, dataRevision: "source-v0" },
        },
        baseRows[1],
      ],
      error: /dataRevision.*source-v1/i,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let executed = false;
      const worker = createCurationWorker({
        repository: fakeRepository({ reviews: scenario.rows }),
        runner: {
          runProposer: async () => {
            throw new Error("stored proposer must not be rerun");
          },
          runReviewer: async () => {
            throw new Error("stored reviewer must not be rerun");
          },
        },
        workerId: "worker-a",
        model: "gpt-test",
        executeDecision: async () => {
          executed = true;
        },
      });

      await assert.rejects(worker.runOnce(), scenario.error);
      assert.equal(executed, false);
    });
  }
});

test("worker escalates incompatible decisions and then releases for human review", async () => {
  const events = [];
  const repository = fakeRepository({ events });
  const worker = createCurationWorker({
    repository,
    runner: {
      runProposer: async () => rejection("proposer-v1"),
      runReviewer: async () => escalation("reviewer-v1"),
    },
    workerId: "worker-a",
    model: "gpt-test",
    async executeDecision() {
      events.push("unexpected-execute");
    },
  });

  const result = await worker.runOnce();

  assert.equal(result.kind, "escalate");
  assert.equal(result.reason, "explicit_escalation");
  assert.equal(events.at(-1), "release-awaiting_human");
  assert.equal(events.includes("unexpected-execute"), false);
});

test("worker schedules a 60 second heartbeat for an active case and clears it", async () => {
  const events = [];
  const repository = fakeRepository({ events });
  let heartbeatCallback;
  let heartbeatDelay;
  let clearedTimer;
  const worker = createCurationWorker({
    repository,
    runner: {
      async runProposer() {
        await heartbeatCallback();
        return rejection("proposer-v1");
      },
      runReviewer: async () => rejection("reviewer-v1"),
    },
    workerId: "worker-a",
    model: "gpt-test",
    setIntervalFn(callback, delay) {
      heartbeatCallback = callback;
      heartbeatDelay = delay;
      return "heartbeat-timer";
    },
    clearIntervalFn(timer) {
      clearedTimer = timer;
    },
  });

  await worker.runOnce();

  assert.equal(heartbeatDelay, 60_000);
  assert.equal(events.includes("heartbeat"), true);
  assert.equal(clearedTimer, "heartbeat-timer");
});

test("heartbeat renewals are serialized even when interval callbacks overlap", async () => {
  const events = [];
  let heartbeatCallback;
  let heartbeatCalls = 0;
  let activeHeartbeats = 0;
  let maximumActiveHeartbeats = 0;
  const heartbeatResolvers = [];
  const repository = {
    ...fakeRepository({ events }),
    async heartbeat() {
      events.push("heartbeat");
      heartbeatCalls += 1;
      activeHeartbeats += 1;
      maximumActiveHeartbeats = Math.max(maximumActiveHeartbeats, activeHeartbeats);
      if (heartbeatCalls <= 2) {
        await new Promise((resolve) => heartbeatResolvers.push(resolve));
      }
      activeHeartbeats -= 1;
      return true;
    },
  };
  const worker = createCurationWorker({
    repository,
    runner: {
      async runProposer() {
        const first = heartbeatCallback();
        const second = heartbeatCallback();
        await new Promise((resolve) => setImmediate(resolve));
        try {
          assert.equal(heartbeatCalls, 1);
          assert.equal(maximumActiveHeartbeats, 1);
        } catch (error) {
          for (const resolve of heartbeatResolvers) resolve();
          await Promise.allSettled([first, second]);
          throw error;
        }
        heartbeatResolvers.shift()();
        await first;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(heartbeatCalls, 2);
        assert.equal(maximumActiveHeartbeats, 1);
        heartbeatResolvers.shift()();
        await second;
        return rejection("proposer-v1");
      },
      runReviewer: async () => rejection("reviewer-v1"),
    },
    workerId: "worker-a",
    model: "gpt-test",
    setIntervalFn(callback) {
      heartbeatCallback = callback;
      return "heartbeat-timer";
    },
    clearIntervalFn() {},
  });

  await worker.runOnce();

  assert.equal(maximumActiveHeartbeats, 1);
});

test("lease ownership is renewed immediately before execution or escalation", async (t) => {
  const scenarios = [
    {
      name: "execute",
      reviewer: rejection("reviewer-v1"),
      forbiddenEvent: "execute",
      terminalOutcome: "release-rejected",
    },
    {
      name: "escalate",
      reviewer: escalation("reviewer-v1"),
      forbiddenEvent: "release-awaiting_human",
      terminalOutcome: "release-awaiting_human",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const events = [];
      const repository = {
        ...fakeRepository({ events }),
        async heartbeat() {
          events.push("heartbeat-rejected");
          return false;
        },
      };
      const worker = createCurationWorker({
        repository,
        runner: {
          runProposer: async () => rejection("proposer-v1"),
          runReviewer: async () => scenario.reviewer,
        },
        workerId: "worker-a",
        model: "gpt-test",
        async executeDecision() {
          events.push("execute");
        },
      });

      await assert.rejects(worker.runOnce(), /lease heartbeat was rejected/i);
      assert.equal(events.includes("heartbeat-rejected"), true);
      assert.equal(events.includes(scenario.forbiddenEvent), false);
      assert.equal(events.includes(scenario.terminalOutcome), false);
      assert.equal(events.at(-1), "release-technical_failure");
    });
  }
});

test("a rejected terminal release is an orchestration error", async (t) => {
  const scenarios = [
    {
      name: "execution release",
      reviewer: rejection("reviewer-v1"),
      rejectedOutcome: "rejected",
    },
    {
      name: "human escalation release",
      reviewer: escalation("reviewer-v1"),
      rejectedOutcome: "awaiting_human",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const events = [];
      const repository = {
        ...fakeRepository({ events }),
        async release({ outcome }) {
          events.push(`release-${outcome}`);
          return outcome !== scenario.rejectedOutcome;
        },
      };
      const worker = createCurationWorker({
        repository,
        runner: {
          runProposer: async () => rejection("proposer-v1"),
          runReviewer: async () => scenario.reviewer,
        },
        workerId: "worker-a",
        model: "gpt-test",
      });

      await assert.rejects(
        worker.runOnce(),
        new RegExp(`release.*${scenario.rejectedOutcome}.*rejected`, "i"),
      );
      assert.equal(events.includes(`release-${scenario.rejectedOutcome}`), true);
      assert.equal(events.at(-1), "release-technical_failure");
    });
  }
});

test("a heartbeat loss during execution cannot return execute success", async () => {
  const events = [];
  let heartbeatCallback;
  let heartbeatCalls = 0;
  const repository = {
    ...fakeRepository({ events }),
    async heartbeat() {
      heartbeatCalls += 1;
      events.push(`heartbeat-${heartbeatCalls}`);
      return heartbeatCalls === 1;
    },
  };
  const worker = createCurationWorker({
    repository,
    runner: {
      runProposer: async () => rejection("proposer-v1"),
      runReviewer: async () => rejection("reviewer-v1"),
    },
    workerId: "worker-a",
    model: "gpt-test",
    setIntervalFn(callback) {
      heartbeatCallback = callback;
      return "heartbeat-timer";
    },
    clearIntervalFn() {},
    async executeDecision() {
      events.push("execute");
      await assert.rejects(heartbeatCallback(), /lease heartbeat was rejected/i);
    },
  });

  await assert.rejects(worker.runOnce(), /lease heartbeat was rejected/i);
  assert.equal(events.includes("release-rejected"), false);
  assert.equal(events.at(-1), "release-technical_failure");
});

test("restart reuses persisted reviews for orchestration state without leaking proposer output", async () => {
  const events = [];
  const persistedProposal = rejection("proposer-v1", "PROPOSER-PRIVATE-SENTINEL");
  const repository = fakeRepository({
    events,
    reviews: [{
      review_role: "proposer",
      model: "gpt-test",
      prompt_version: "proposer-v1",
      evidence: persistedProposal.evidence,
      decision: persistedProposal,
    }],
  });
  let reviewerContext;
  const worker = createCurationWorker({
    repository,
    runner: {
      runProposer: async () => {
        throw new Error("proposer must not be rerun");
      },
      async runReviewer(caseContext) {
        events.push("reviewer");
        reviewerContext = structuredClone(caseContext);
        return rejection("reviewer-v1", "Independent reviewer conclusion.");
      },
    },
    workerId: "worker-a",
    model: "gpt-test",
  });

  await worker.runOnce();

  assert.equal(events.includes("proposer"), false);
  assert.equal(events.filter((event) => event === "record-proposer").length, 0);
  assert.equal(events.filter((event) => event === "record-reviewer").length, 1);
  assert.doesNotMatch(JSON.stringify(reviewerContext), /PROPOSER-PRIVATE-SENTINEL/);
});

test("restart with both stored reviews resumes at consensus without another model call", async () => {
  const events = [];
  const proposal = rejection("proposer-v1");
  const review = rejection("reviewer-v1");
  const repository = fakeRepository({
    events,
    reviews: [
      {
        review_role: "proposer",
        model: "gpt-test",
        prompt_version: "proposer-v1",
        evidence: proposal.evidence,
        decision: proposal,
      },
      {
        review_role: "reviewer",
        model: "gpt-test",
        prompt_version: "reviewer-v1",
        evidence: review.evidence,
        decision: review,
      },
    ],
  });
  const worker = createCurationWorker({
    repository,
    runner: {
      runProposer: async () => {
        throw new Error("proposer must not be rerun");
      },
      runReviewer: async () => {
        throw new Error("reviewer must not be rerun");
      },
    },
    workerId: "worker-a",
    model: "gpt-test",
    resolveConsensusFn(storedProposal, storedReview) {
      events.push("consensus");
      assert.deepEqual(storedProposal, proposal);
      assert.deepEqual(storedReview, review);
      return { kind: "execute", decision: storedProposal };
    },
    async executeDecision() {
      events.push("execute");
    },
  });

  await worker.runOnce();

  assert.deepEqual(events, [
    "lease",
    "read-reviews",
    "consensus",
    "heartbeat",
    "execute",
    "release-rejected",
  ]);
});

test("malformed output is never persisted and is retried with exponential backoff", async () => {
  const events = [];
  const controller = new AbortController();
  const repository = fakeRepository({ events, leases: [leasedCase, leasedCase] });
  let proposerCalls = 0;
  const sleepDelays = [];
  const worker = createCurationWorker({
    repository,
    runner: {
      async runProposer() {
        proposerCalls += 1;
        if (proposerCalls === 1) return "{not valid json";
        return rejection("proposer-v1");
      },
      runReviewer: async () => rejection("reviewer-v1"),
    },
    workerId: "worker-a",
    model: "gpt-test",
    async sleep(delay) {
      sleepDelays.push(delay);
    },
    async executeDecision() {
      controller.abort();
    },
  });

  await worker.run({ signal: controller.signal });

  assert.equal(proposerCalls, 2);
  assert.deepEqual(sleepDelays, [1_000]);
  assert.equal(events[2], "release-technical_failure");
  assert.equal(events.filter((event) => event === "record-proposer").length, 1);
});

test("retry delay is capped at 15 minutes and idle polling waits five seconds", async () => {
  const failureController = new AbortController();
  const failureDelays = [];
  const failingWorker = createCurationWorker({
    repository: {
      async lease() {
        throw new Error("temporary queue outage");
      },
    },
    runner: {},
    workerId: "worker-a",
    model: "gpt-test",
    async sleep(delay) {
      failureDelays.push(delay);
      if (failureDelays.length === 12) failureController.abort();
    },
  });
  await failingWorker.run({ signal: failureController.signal });
  assert.deepEqual(failureDelays, [
    1_000,
    2_000,
    4_000,
    8_000,
    16_000,
    32_000,
    64_000,
    128_000,
    256_000,
    512_000,
    900_000,
    900_000,
  ]);

  const idleController = new AbortController();
  const idleDelays = [];
  const idleWorker = createCurationWorker({
    repository: { lease: async () => null },
    runner: {},
    workerId: "worker-a",
    model: "gpt-test",
    async sleep(delay) {
      idleDelays.push(delay);
      idleController.abort();
    },
  });
  await idleWorker.run({ signal: idleController.signal });
  assert.deepEqual(idleDelays, [5_000]);
});

test("technical errors are redacted before persistence and logging", async () => {
  const releases = [];
  const logs = [];
  const repository = {
    ...fakeRepository(),
    async release(value) {
      releases.push(value);
      return true;
    },
  };
  const worker = createCurationWorker({
    repository,
    runner: {
      runProposer: async () => {
        throw new Error(
          "request failed for supabase-secret with Authorization: Bearer codex-secret",
        );
      },
    },
    workerId: "worker-a",
    model: "gpt-test",
    secrets: ["supabase-secret"],
    logger: { error: (message) => logs.push(message) },
  });

  await assert.rejects(worker.runOnce(), /\[REDACTED\]/);

  assert.equal(releases[0].outcome, "technical_failure");
  assert.doesNotMatch(releases[0].errorText, /supabase-secret|codex-secret/);
  assert.doesNotMatch(logs.join("\n"), /supabase-secret|codex-secret/);
});

test("SIGTERM aborts the loop through a removable graceful-shutdown handler", () => {
  const processLike = new EventEmitter();
  const controller = new AbortController();
  const detach = attachSignalHandlers({ processLike, controller });

  processLike.emit("SIGTERM");

  assert.equal(controller.signal.aborted, true);
  detach();
  assert.equal(processLike.listenerCount("SIGTERM"), 0);
});

test("an abort signal interrupts the default idle sleep promptly", async () => {
  const controller = new AbortController();
  const worker = createCurationWorker({
    repository: { lease: async () => null },
    runner: {},
    workerId: "worker-a",
    model: "gpt-test",
  });
  const startedAt = Date.now();

  const running = worker.run({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await running;

  assert.ok(Date.now() - startedAt < 500, "worker waited for the full idle poll after abort");
});
