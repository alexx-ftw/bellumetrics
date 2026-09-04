# Curation worker isolation prerequisites

> Legacy fallback only. The active deployment uses the native ChatGPT/Codex
> scheduled task described in `docs/operations/ai-curation.md` and does not
> export ChatGPT account credentials to a local worker or GitHub Actions.

The production curation worker refuses to start a real Codex run unless its
Linux filesystem namespace can be created. Task 10 deployment work must:

1. Install `bubblewrap` with `--bind-fd` support and expose it at
   `/usr/bin/bwrap`.
2. Create a dedicated credential directory outside the application repository,
   owned by the worker account, with no group or other write bits (normally
   mode `0700`), and set its absolute path as `CURATION_CODEX_HOME`. The path
   itself must not be a symlink.
3. Authenticate Codex interactively with that directory as `CODEX_HOME`, using
   ChatGPT subscription login. The resulting `auth.json` is a password: do not
   read, print, copy, include it in an image, or add it to application secrets.
   Keep this directory authentication-only. It must contain exactly one
   worker-owned, writable, non-symlink `auth.json`, with no group or other
   permissions (normally mode `0600`) and no hard links. The launcher rejects
   every other file or directory, including `AGENTS.override.md`, hooks, rules,
   skills, plugins, or arbitrary runtime state, without inspecting the
   credential file's contents.
4. Keep the shipped `worker/curation/codex-isolation-launcher.sh` executable.
5. Verify the packaged native Codex executable remains self-contained. The
   namespace deliberately provides no system executable or dynamic-library
   tree, so a future dynamically linked package fails closed until its exact
   public runtime files are reviewed and allowlisted.
6. Deploy on x86_64 Linux with the exact `@openai/codex-sdk`/native CLI 0.149.1
   lockfile artifact. The worker verifies the native executable digest, package
   identity, and the complete compiled feature-registry representation before
   constructing a real client. Any CLI update or different architecture is
   intentionally refused until its registry and digest are reviewed and the
   pin is updated.

The worker passes the SDK an explicit environment allowlist and the launcher as
`codexPathOverride`. The launcher creates a fail-closed bubblewrap namespace
containing only the per-run research directory, the SDK output-schema file,
the native Codex executable, explicit DNS files, one public CA bundle, and the
dedicated credential directory. It does not mount `/usr`, `/bin`, `/lib`, an
`/etc/ssl` tree, or the repository. The namespace has a private `/tmp` and
`/home`; the credential directory is mounted at `/codex-home` and supplied as
`CODEX_HOME` only to the trusted Codex harness. The runner checks the original
path with `lstat` before canonicalization. The launcher then opens and validates
the directory by descriptor, compares the pathname and descriptor identities,
and gives bubblewrap that stable descriptor with `--bind-fd`. Replacing the
pathname or an ancestor after validation therefore cannot retarget the mount.

Agent capabilities use a closed policy for the reviewed CLI. The verifier
hashes the complete 2,330-byte compiled feature registry, checks its ordered
107-feature inventory, classifies every entry as agent-facing or operational,
and checks the complete three-field `ToolsToml` representation. Every
agent-facing feature is explicitly false, including bare `code_mode`,
`code_mode_host`, `multi_agent_v2`, `hooks`, `plugins`, `tool_suggest`,
`deferred_executor`, and `in_app_browser`. Extension tables are explicitly
empty. The verifier derives enabled tools from the actual policy and refuses
construction unless the result is exactly hosted `web_search`; it does not
return a self-declared allowlist. Transcript state is in-memory; SQLite and
logs use the namespace's private `/tmp`, leaving the persistent directory for
`auth.json` refresh only. Completed SDK turns are also rejected if they contain
a tool item other than hosted web search.

The outer namespace independently contains no shell or other runtime
executable (its inner `PATH` and `SHELL` point to `/nonexistent`), and
subprocess environment inheritance is `none`. This is the credential boundary:
the trusted harness can authenticate and refresh its cache, while the model has
no local/plugin/app/MCP capability that can read or exfiltrate that cache. Any
future tool requirement must use a separate credential-free executor; do not
enable it in this namespace.

Only standard proxy variables are forwarded, and proxy URLs containing userinfo
are rejected before a Codex client is constructed. Supabase keys, database URLs,
OpenAI API keys, and other application environment values are intentionally not
available to the agent. If bubblewrap, the launcher, the native Codex binary,
or the external credential directory is unavailable, the real run stops before
constructing a Codex client; there is no non-isolated fallback.
