import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAgentDecision } from "../../lib/curation/contracts.mjs";
import { assertOpenAiStrictSchema } from "../../lib/curation/openai-structured-output.mjs";

const PROMPTS = {
  proposer: new URL("./prompts/proposer-v1.md", import.meta.url),
  reviewer: new URL("./prompts/reviewer-v1.md", import.meta.url),
};

const DEFAULT_LAUNCHER_PATH = fileURLToPath(
  new URL("./codex-isolation-launcher.sh", import.meta.url),
);
const CODEX_SECURITY_CONFIG = {
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
    remote_plugin: false,
    remote_control: false,
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
const PINNED_CODEX_INSTALLATION = {
  version: "0.149.1",
  target: "x86_64-unknown-linux-musl",
  executableSha256: "73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba",
  featureRegistryLength: 2_330,
  featureRegistrySha256: "92370ff2fc87d42b7b1e62527bbef02d95e6b429811edaa02ed61b30b0e8d2cf",
  featureRegistryStart: Buffer.from(
    "shell_toolview_imagesecret_auth_storageunified_execshell_zsh_fork",
  ),
  featureRegistryEnd: Buffer.from(
    "responses_websockets_v2remote_compaction_v2compaction_image_budget"
      + "use_agent_identityworkspace_dependencies",
  ),
  toolsTomlRepresentation: Buffer.from(
    "ToolsTomlweb_searchexperimental_request_user_inputupdate_plan",
  ),
  toolsTomlRepresentationOccurrences: 3,
};
const PINNED_FEATURE_REGISTRY = [
  "shell_tool",
  "view_image",
  "secret_auth_storage",
  "unified_exec",
  "shell_zsh_fork",
  "unified_exec_zsh_fork",
  "shell_snapshot",
  "deferred_executor",
  "cwd_relative_turn_diffs",
  "js_repl",
  "executed_tool_call_metadata",
  "code_mode",
  "code_mode_buffered_exec",
  "code_mode_host",
  "code_mode_interrupt",
  "code_mode_only",
  "js_repl_tools_only",
  "terminal_resize_reflow",
  "web_search_request",
  "web_search_cached",
  "standalone_web_search",
  "search_tool",
  "runtime_metrics",
  "sqlite",
  "external_agent_memory_import",
  "local_thread_store_compression",
  "background_paginated_rollout_migration",
  "chronicle",
  "apply_patch_freeform",
  "apply_patch_streaming_events",
  "apply_patch_preserve_line_endings",
  "exec_permission_approvals",
  "hooks",
  "request_permissions_tool",
  "use_linux_sandbox_bwrap",
  "use_legacy_landlock",
  "request_rule",
  "experimental_windows_sandbox",
  "elevated_windows_sandbox",
  "remote_models",
  "enable_request_compression",
  "unbounded_connection_retries",
  "network_proxy",
  "respect_system_proxy",
  "multi_agent",
  "multi_agent_v2",
  "enable_fanout",
  "psp",
  "enable_mcp_apps",
  "mcp_2026_07_28",
  "apps_mcp_path_override",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "deferred_tool_world_state",
  "non_prefixed_mcp_tool_names",
  "unavailable_dummy_tools",
  "tool_suggest",
  "recommended_plugins",
  "plugins",
  "executor_capability_discovery",
  "plugin_hooks",
  "in_app_browser",
  "in_app_chat",
  "in_app_updates",
  "browser_use",
  "browser_use_full_cdp_access",
  "browser_use_external",
  "computer_use",
  "remote_plugin",
  "plugin_sharing",
  "external_migration",
  "image_resize_notice",
  "unified_image_budget",
  "resize_all_images",
  "concurrent_reasoning_summaries",
  "skill_mcp_dependency_install",
  "skill_search",
  "skill_env_var_dependency_prompt",
  "mentions_v2",
  "steer",
  "default_mode_request_user_input",
  "send_async_message",
  "terminal_visualization_instructions",
  "guardian_approval",
  "guardian_enhanced_node_repl_transcripts",
  "guardian_node_repl_transcript_images",
  "guardianv2",
  "goals",
  "token_budget",
  "rollout_budget",
  "current_time_reminder",
  "collaboration_modes",
  "tool_call_mcp_elicitation",
  "personality",
  "fast_mode",
  "realtime_conversation",
  "remote_control",
  "image_detail_original",
  "tui_app_server",
  "prevent_idle_sleep",
  "workspace_owner_usage_nudge",
  "responses_websockets",
  "responses_websockets_v2",
  "remote_compaction_v2",
  "compaction_image_budget",
  "use_agent_identity",
  "workspace_dependencies",
];
const DENIED_AGENT_FACING_FEATURES = [
  "apply_patch_freeform",
  "apps_mcp_path_override",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_buffered_exec",
  "code_mode_host",
  "code_mode_interrupt",
  "code_mode_only",
  "collaboration_modes",
  "computer_use",
  "default_mode_request_user_input",
  "deferred_executor",
  "deferred_tool_world_state",
  "enable_fanout",
  "enable_mcp_apps",
  "exec_permission_approvals",
  "executor_capability_discovery",
  "external_agent_memory_import",
  "external_migration",
  "goals",
  "hooks",
  "in_app_browser",
  "in_app_chat",
  "in_app_updates",
  "js_repl",
  "js_repl_tools_only",
  "mcp_2026_07_28",
  "mentions_v2",
  "multi_agent",
  "multi_agent_v2",
  "non_prefixed_mcp_tool_names",
  "plugins",
  "plugin_hooks",
  "plugin_sharing",
  "psp",
  "recommended_plugins",
  "realtime_conversation",
  "remote_control",
  "remote_plugin",
  "request_permissions_tool",
  "request_rule",
  "search_tool",
  "send_async_message",
  "shell_snapshot",
  "shell_tool",
  "shell_zsh_fork",
  "skill_env_var_dependency_prompt",
  "skill_mcp_dependency_install",
  "skill_search",
  "standalone_web_search",
  "terminal_visualization_instructions",
  "tool_call_mcp_elicitation",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "tool_suggest",
  "unavailable_dummy_tools",
  "unified_exec",
  "unified_exec_zsh_fork",
  "view_image",
  "web_search_cached",
  "web_search_request",
  "workspace_dependencies",
];
const REVIEWED_NON_AGENT_FEATURES = [
  "secret_auth_storage",
  "cwd_relative_turn_diffs",
  "executed_tool_call_metadata",
  "terminal_resize_reflow",
  "runtime_metrics",
  "sqlite",
  "local_thread_store_compression",
  "background_paginated_rollout_migration",
  "chronicle",
  "apply_patch_streaming_events",
  "apply_patch_preserve_line_endings",
  "use_linux_sandbox_bwrap",
  "use_legacy_landlock",
  "experimental_windows_sandbox",
  "elevated_windows_sandbox",
  "remote_models",
  "enable_request_compression",
  "unbounded_connection_retries",
  "network_proxy",
  "respect_system_proxy",
  "image_resize_notice",
  "unified_image_budget",
  "resize_all_images",
  "concurrent_reasoning_summaries",
  "steer",
  "guardian_approval",
  "guardian_enhanced_node_repl_transcripts",
  "guardian_node_repl_transcript_images",
  "guardianv2",
  "token_budget",
  "rollout_budget",
  "current_time_reminder",
  "personality",
  "fast_mode",
  "image_detail_original",
  "tui_app_server",
  "prevent_idle_sleep",
  "workspace_owner_usage_nudge",
  "responses_websockets",
  "responses_websockets_v2",
  "remote_compaction_v2",
  "compaction_image_budget",
  "use_agent_identity",
];
const TOOLS_TOML_FIELDS = [
  "web_search",
  "experimental_request_user_input",
  "update_plan",
];
const EMPTY_AGENT_EXTENSION_TABLES = [
  "hooks",
  "marketplaces",
  "mcp_servers",
  "plugins",
];
const PROXY_ENVIRONMENT_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];
const PROXY_URL_ENVIRONMENT_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]);
const require = createRequire(import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function countOccurrences(value, needle) {
  let count = 0;
  for (
    let offset = value.indexOf(needle);
    offset >= 0;
    offset = value.indexOf(needle, offset + 1)
  ) {
    count += 1;
  }
  return count;
}

function findPinnedFeatureRegistry(executable) {
  const matches = [];
  for (
    let start = executable.indexOf(PINNED_CODEX_INSTALLATION.featureRegistryStart);
    start >= 0;
    start = executable.indexOf(PINNED_CODEX_INSTALLATION.featureRegistryStart, start + 1)
  ) {
    const endMarker = executable.indexOf(
      PINNED_CODEX_INSTALLATION.featureRegistryEnd,
      start,
    );
    if (endMarker < 0) continue;
    const end = endMarker + PINNED_CODEX_INSTALLATION.featureRegistryEnd.length;
    const candidate = executable.subarray(start, end);
    if (
      candidate.length === PINNED_CODEX_INSTALLATION.featureRegistryLength
      && sha256(candidate) === PINNED_CODEX_INSTALLATION.featureRegistrySha256
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      "Codex capability registry is not reviewed: complete feature registry changed",
    );
  }
  return matches[0];
}

function assertCompleteFeatureInventory(featureRegistry) {
  if (new Set(PINNED_FEATURE_REGISTRY).size !== PINNED_FEATURE_REGISTRY.length) {
    throw new Error("Codex capability inventory contains duplicate feature names");
  }
  const classifiedFeatures = [
    ...DENIED_AGENT_FACING_FEATURES,
    ...REVIEWED_NON_AGENT_FEATURES,
  ];
  if (
    new Set(classifiedFeatures).size !== PINNED_FEATURE_REGISTRY.length
    || PINNED_FEATURE_REGISTRY.some((featureName) => (
      !classifiedFeatures.includes(featureName)
    ))
  ) {
    throw new Error(
      "Codex capability inventory does not classify the complete feature registry",
    );
  }
  let cursor = 0;
  for (const featureName of PINNED_FEATURE_REGISTRY) {
    const offset = featureRegistry.indexOf(Buffer.from(featureName), cursor);
    if (offset < 0) {
      throw new Error(
        `Codex capability registry is not reviewed: missing feature ${featureName}`,
      );
    }
    cursor = offset + featureName.length;
  }
}

function assertToolsTomlRepresentation(executable) {
  const occurrences = countOccurrences(
    executable,
    PINNED_CODEX_INSTALLATION.toolsTomlRepresentation,
  );
  if (occurrences !== PINNED_CODEX_INSTALLATION.toolsTomlRepresentationOccurrences) {
    throw new Error(
      "Codex capability registry is not reviewed: ToolsToml representation changed",
    );
  }
}

function assertEmptyObject(value, pathName) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 0
  ) {
    throw new Error(`Codex capability policy requires empty ${pathName}`);
  }
}

function auditAgentCapabilityPolicy(securityConfig) {
  if (
    securityConfig === null
    || typeof securityConfig !== "object"
    || securityConfig.features === null
    || typeof securityConfig.features !== "object"
    || Array.isArray(securityConfig.features)
  ) {
    throw new Error("Codex capability policy requires an explicit features table");
  }

  const missingDenials = DENIED_AGENT_FACING_FEATURES.filter((featureName) => (
    !Object.hasOwn(securityConfig.features, featureName)
  ));
  if (missingDenials.length > 0) {
    throw new Error(
      `Codex capability policy is missing explicit deny controls: ${missingDenials.join(", ")}`,
    );
  }
  const permissiveFeatures = DENIED_AGENT_FACING_FEATURES.filter((featureName) => (
    securityConfig.features[featureName] !== false
  ));
  if (permissiveFeatures.length > 0) {
    throw new Error(
      `Codex capability policy controls must be false: ${permissiveFeatures.join(", ")}`,
    );
  }
  const unknownFeatureControls = Object.keys(securityConfig.features).filter((featureName) => (
    !PINNED_FEATURE_REGISTRY.includes(featureName)
  ));
  if (unknownFeatureControls.length > 0) {
    throw new Error(
      `Codex capability policy contains unreviewed feature controls: ${unknownFeatureControls.join(", ")}`,
    );
  }

  for (const tableName of EMPTY_AGENT_EXTENSION_TABLES) {
    assertEmptyObject(securityConfig[tableName], tableName);
  }

  if (
    securityConfig.tools === null
    || typeof securityConfig.tools !== "object"
    || Array.isArray(securityConfig.tools)
  ) {
    throw new Error("Codex capability policy requires an explicit tools table");
  }
  const configuredToolFields = Object.keys(securityConfig.tools).sort();
  const reviewedToolFields = [...TOOLS_TOML_FIELDS].sort();
  if (
    configuredToolFields.length !== reviewedToolFields.length
    || configuredToolFields.some((field, index) => field !== reviewedToolFields[index])
  ) {
    throw new Error("Codex capability policy does not cover the complete ToolsToml registry");
  }
  const allowedAgentTools = TOOLS_TOML_FIELDS.filter((field) => (
    securityConfig.tools[field] === true
  ));
  if (
    securityConfig.tools.experimental_request_user_input !== false
    || securityConfig.tools.update_plan !== false
    || allowedAgentTools.length !== 1
    || allowedAgentTools[0] !== "web_search"
  ) {
    throw new Error(
      `Codex capability policy must allow only hosted web_search; enabled: ${allowedAgentTools.join(", ") || "none"}`,
    );
  }
  return allowedAgentTools;
}

export async function verifyPinnedCodexInstallation({
  codexExecutable = bundledCodexExecutable(),
  securityConfig = CODEX_SECURITY_CONFIG,
} = {}) {
  let approvedExecutable;
  let resolvedExecutable;
  try {
    [approvedExecutable, resolvedExecutable] = await Promise.all([
      realpath(bundledCodexExecutable()),
      realpath(codexExecutable),
    ]);
  } catch (error) {
    throw new Error("Codex installation is not reviewed: executable path is invalid", {
      cause: error,
    });
  }
  if (resolvedExecutable !== approvedExecutable) {
    throw new Error("Codex installation is not reviewed: unexpected executable path");
  }

  let executable;
  let packageMetadata;
  try {
    [executable, packageMetadata] = await Promise.all([
      readFile(resolvedExecutable),
      readFile(path.join(path.dirname(resolvedExecutable), "..", "codex-package.json"), "utf8"),
    ]);
  } catch (error) {
    throw new Error("Codex installation is not reviewed: package files are unreadable", {
      cause: error,
    });
  }

  let metadata;
  try {
    metadata = JSON.parse(packageMetadata);
  } catch (error) {
    throw new Error("Codex installation is not reviewed: package metadata is invalid", {
      cause: error,
    });
  }
  if (
    metadata.version !== PINNED_CODEX_INSTALLATION.version
    || metadata.target !== PINNED_CODEX_INSTALLATION.target
    || metadata.entrypoint !== "bin/codex"
    || metadata.layoutVersion !== 1
  ) {
    throw new Error("Codex installation is not reviewed: package identity changed");
  }
  if (sha256(executable) !== PINNED_CODEX_INSTALLATION.executableSha256) {
    throw new Error("Codex binary is not reviewed: executable digest changed");
  }
  const featureRegistry = findPinnedFeatureRegistry(executable);
  assertCompleteFeatureInventory(featureRegistry);
  assertToolsTomlRepresentation(executable);
  const allowedAgentTools = auditAgentCapabilityPolicy(securityConfig);

  return {
    version: metadata.version,
    target: metadata.target,
    allowedAgentTools,
  };
}

const ENTITY_REFERENCE_SCHEMAS = {
  battle: {
    type: "object",
    additionalProperties: false,
    required: ["type", "id"],
    properties: {
      type: { type: "string", enum: ["battle"] },
      id: { type: "string", pattern: "^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$" },
    },
  },
  commander: {
    type: "object",
    additionalProperties: false,
    required: ["type", "id"],
    properties: {
      type: { type: "string", enum: ["commander"] },
      id: { type: "string", pattern: "^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$" },
    },
  },
};

const EVIDENCE_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["citation", "url", "locator"],
    properties: {
      citation: { type: "string", minLength: 1 },
      url: { type: ["string", "null"], minLength: 1 },
      locator: { type: ["string", "null"], minLength: 1 },
    },
  },
};

const APPROVAL_MUTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "battle", "commanderRefs", "participants"],
  properties: {
    action: { type: "string", enum: ["approve_battle"] },
    battle: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "slug", "title", "startYear", "endYear", "outcome"],
      properties: {
        ref: ENTITY_REFERENCE_SCHEMAS.battle,
        slug: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        startYear: { type: ["integer", "null"] },
        endYear: { type: ["integer", "null"] },
        outcome: {
          anyOf: [
            {
              type: "string",
              enum: [
                "victory",
                "defeat",
                "draw",
                "inconclusive",
                "disputed",
                "unknown",
              ],
            },
            { type: "null" },
          ],
        },
      },
    },
    participants: {
      anyOf: [
        { type: "null" },
        { type: "array", minItems: 2, items: {
          type: "object", additionalProperties: false, required: ["ref", "side"],
          properties: { ref: ENTITY_REFERENCE_SCHEMAS.commander, side: { type: "string", minLength: 1 } },
        } },
      ],
    },
    commanderRefs: {
      type: "array",
      minItems: 1,
      items: ENTITY_REFERENCE_SCHEMAS.commander,
    },
  },
};

function identityMutationSchema(action) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "source", "target"],
    properties: {
      action: { type: "string", enum: [action] },
      source: ENTITY_REFERENCE_SCHEMAS.commander,
      target: ENTITY_REFERENCE_SCHEMAS.commander,
    },
  };
}

const AGENT_DECISION_SCHEMA = assertOpenAiStrictSchema({
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "evidence",
    "reason",
    "confidence",
    "canonicalMutation",
    "dataRevision",
    "promptVersion",
  ],
  properties: {
    action: {
      type: "string",
      enum: [
        "approve_battle",
        "reject_battle",
        "escalate",
        "merge_commanders",
        "separate_commanders",
      ],
    },
    evidence: EVIDENCE_SCHEMA,
    reason: { type: "string", minLength: 1 },
    confidence: { type: ["number", "null"] },
    canonicalMutation: {
      anyOf: [
        APPROVAL_MUTATION_SCHEMA,
        { type: "null" },
        identityMutationSchema("merge_commanders"),
        identityMutationSchema("separate_commanders"),
      ],
    },
    dataRevision: { type: "string", minLength: 1 },
    promptVersion: { type: "string", minLength: 1 },
  },
});

async function defaultCodexFactory(options) {
  const { Codex } = await import("@openai/codex-sdk");
  return new Codex(options);
}

function bundledCodexExecutable() {
  if (process.platform !== "linux") {
    throw new Error(`Codex curation isolation requires Linux, received ${process.platform}`);
  }
  const target = process.arch === "x64"
    ? ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"]
    : process.arch === "arm64"
      ? ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"]
      : null;
  if (!target) {
    throw new Error(`unsupported Linux architecture for Codex isolation: ${process.arch}`);
  }
  const packageJson = require.resolve(`${target[0]}/package.json`);
  return path.join(path.dirname(packageJson), "vendor", target[1], "bin", "codex");
}

function assertExternalCredentialDirectory(cwd, credentialDirectory) {
  if (typeof credentialDirectory !== "string" || !path.isAbsolute(credentialDirectory)) {
    throw new TypeError("credentialDirectory must be an absolute path");
  }
  const relative = path.relative(path.resolve(cwd), path.resolve(credentialDirectory));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new TypeError("credentialDirectory must be outside the repository checkout");
  }
}

function assertResolvedCredentialDirectory(cwd, credentialDirectory) {
  const relative = path.relative(cwd, credentialDirectory);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new TypeError(
      "credentialDirectory must resolve outside the repository checkout",
    );
  }
}

function isolatedEnvironment({
  sourceEnv,
  bwrapExecutable,
  codexExecutable,
  researchDirectory,
  credentialDirectory,
}) {
  const environment = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  };
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    if (typeof sourceEnv[key] === "string" && sourceEnv[key] !== "") {
      if (PROXY_URL_ENVIRONMENT_KEYS.has(key)) {
        let proxyUrl;
        try {
          proxyUrl = new URL(sourceEnv[key]);
        } catch {
          throw new TypeError(`${key} must be an absolute proxy URL without userinfo`);
        }
        if (proxyUrl.username !== "" || proxyUrl.password !== "") {
          throw new TypeError(`${key} must not contain userinfo`);
        }
      }
      environment[key] = sourceEnv[key];
    }
  }
  return {
    ...environment,
    CODEX_BWRAP_EXECUTABLE: bwrapExecutable,
    CODEX_REAL_EXECUTABLE: codexExecutable,
    CODEX_RESEARCH_DIRECTORY: researchDirectory,
    CODEX_CREDENTIAL_DIRECTORY: credentialDirectory,
  };
}

function parseFinalResponse(finalResponse) {
  if (typeof finalResponse !== "string") {
    throw new TypeError("Codex finalResponse must be a JSON string");
  }
  let value;
  try {
    value = JSON.parse(finalResponse);
  } catch (error) {
    throw new TypeError(`Codex finalResponse is not valid JSON: ${error.message}`);
  }
  return parseAgentDecision(value);
}

function assertAllowedTurnItems(items) {
  if (!Array.isArray(items)) {
    throw new TypeError("Codex turn items must be an array");
  }
  const allowedItemTypes = new Set(["agent_message", "reasoning", "web_search", "error"]);
  for (const item of items) {
    if (!item || !allowedItemTypes.has(item.type)) {
      throw new Error(`unapproved Codex tool item: ${item?.type ?? "unknown"}`);
    }
  }
}

export function createCodexRunner({
  cwd,
  model,
  reasoningEffort,
  codexFactory = defaultCodexFactory,
  launcherPath = DEFAULT_LAUNCHER_PATH,
  codexExecutable = bundledCodexExecutable(),
  credentialDirectory,
  bwrapExecutable = "/usr/bin/bwrap",
  sourceEnv = process.env,
  accessImpl = access,
  lstatImpl = lstat,
  realpathImpl = realpath,
  verifyCodexInstallationImpl = verifyPinnedCodexInstallation,
}) {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new TypeError("cwd is required");
  }
  if (typeof codexFactory !== "function") {
    throw new TypeError("codexFactory must be a function");
  }
  assertExternalCredentialDirectory(cwd, credentialDirectory);

  async function verifyIsolationPrerequisites() {
    const checks = [
      [bwrapExecutable, fsConstants.X_OK, "bubblewrap isolation unavailable"],
      [launcherPath, fsConstants.X_OK, "Codex isolation launcher unavailable"],
      [codexExecutable, fsConstants.X_OK, "Codex executable unavailable"],
      [
        credentialDirectory,
        fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
        "Codex credential directory unavailable",
      ],
    ];
    for (const [candidate, mode, message] of checks) {
      try {
        await accessImpl(candidate, mode);
      } catch (error) {
        throw new Error(`${message}: ${candidate}`, { cause: error });
      }
    }
    let credentialStats;
    try {
      credentialStats = await lstatImpl(credentialDirectory);
    } catch (error) {
      throw new Error("Codex credential directory metadata is unavailable", {
        cause: error,
      });
    }
    if (credentialStats.isSymbolicLink()) {
      throw new Error("credentialDirectory must not be a symbolic link");
    }
    if (!credentialStats.isDirectory()) {
      throw new Error("credentialDirectory must be a directory");
    }
    if (typeof process.getuid !== "function" || credentialStats.uid !== process.getuid()) {
      throw new Error("credentialDirectory must be owned by the worker");
    }
    if ((credentialStats.mode & 0o022) !== 0) {
      throw new Error("credentialDirectory must not be group- or other-writable");
    }
    let resolvedRepository;
    let resolvedCredentialDirectory;
    try {
      [resolvedRepository, resolvedCredentialDirectory] = await Promise.all([
        realpathImpl(cwd),
        realpathImpl(credentialDirectory),
      ]);
    } catch (error) {
      throw new Error("Codex isolation paths could not be resolved", { cause: error });
    }
    assertResolvedCredentialDirectory(
      resolvedRepository,
      resolvedCredentialDirectory,
    );
    await verifyCodexInstallationImpl({
      codexExecutable,
      securityConfig: CODEX_SECURITY_CONFIG,
    });
    return credentialDirectory;
  }

  async function runRole(role, caseContext) {
    const resolvedCredentialDirectory = await verifyIsolationPrerequisites();
    const instructions = await readFile(PROMPTS[role], "utf8");
    const contextJson = JSON.stringify(caseContext, null, 2);
    const checkoutName = path.basename(path.resolve(cwd)).replace(/[^A-Za-z0-9_-]/g, "-");
    const researchDirectory = await mkdtemp(
      path.join(tmpdir(), `bellumetrics-${checkoutName}-${role}-`),
    );

    try {
      await Promise.all([
        writeFile(path.join(researchDirectory, "instructions.md"), instructions, "utf8"),
        writeFile(path.join(researchDirectory, "case-context.json"), contextJson, "utf8"),
      ]);

      const codex = await codexFactory({
        codexPathOverride: launcherPath,
        config: CODEX_SECURITY_CONFIG,
        env: isolatedEnvironment({
          sourceEnv,
          bwrapExecutable,
          codexExecutable,
          researchDirectory,
          credentialDirectory: resolvedCredentialDirectory,
        }),
      });
      const threadOptions = {
        sandboxMode: "read-only",
        workingDirectory: researchDirectory,
        skipGitRepoCheck: true,
        networkAccessEnabled: true,
        webSearchMode: "live",
        approvalPolicy: "never",
      };
      if (model) threadOptions.model = model;
      if (reasoningEffort) threadOptions.modelReasoningEffort = reasoningEffort;

      const thread = codex.startThread(threadOptions);
      const result = await thread.run(
        `${instructions}\n\nRaw case context:\n${contextJson}`,
        { outputSchema: AGENT_DECISION_SCHEMA },
      );
      assertAllowedTurnItems(result.items);
      return parseFinalResponse(result.finalResponse);
    } finally {
      await rm(researchDirectory, { recursive: true, force: true });
    }
  }

  return {
    runProposer(caseContext) {
      return runRole("proposer", caseContext);
    },
    runReviewer(caseContext) {
      return runRole("reviewer", caseContext);
    },
  };
}
