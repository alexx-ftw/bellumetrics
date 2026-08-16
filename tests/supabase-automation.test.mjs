import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { reportSupabaseSync } from "../.github/scripts/report-supabase-sync.mjs";

const workflowUrl = new URL("../.github/workflows/supabase-sync.yml", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);

function stepBlock(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `missing ${name} step`);
  const end = workflow.indexOf("      - name:", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test("automates the linked Supabase schema and staging sync in dependency order", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /cron:\s*["']0 4 \* \* 1["']/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(workflow, /supabase@2\.101\.0 link --project-ref dggbwsgoddbrxvojjojy/);
  assert.match(workflow, /supabase@2\.101\.0 db push --linked/);
  assert.match(workflow, /npm run import:war-atlas/);
  assert.match(workflow, /supabase test db supabase\/tests\/wiki_data_foundation_test\.sql --linked/);
  assert.match(workflow, /SUPABASE_ACCESS_TOKEN:\s*\$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/);
  assert.match(workflow, /SUPABASE_DB_PASSWORD:\s*\$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/);
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);

  const pushPosition = workflow.indexOf("supabase@2.101.0 db push --linked");
  const importPosition = workflow.indexOf("npm run import:war-atlas");
  const contractPosition = workflow.indexOf(
    "supabase test db supabase/tests/wiki_data_foundation_test.sql --linked",
  );
  assert.ok(pushPosition < importPosition, "db push must precede the staging import");
  assert.ok(importPosition < contractPosition, "staging import must precede pgTAP verification");
});

test("scopes Supabase credentials to only the CLI and importer steps that need them", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const syncJob = workflow.slice(workflow.indexOf("  sync:"), workflow.indexOf("  report:"));
  const syncJobHeader = syncJob.slice(0, syncJob.indexOf("    steps:"));
  const cliSteps = [
    "Link the Supabase project",
    "Push schema migrations",
    "Lint the linked Supabase schema",
    "Run supabase test db supabase/tests/wiki_data_foundation_test.sql --linked",
  ];

  assert.doesNotMatch(syncJobHeader, /SUPABASE_(ACCESS_TOKEN|DB_PASSWORD)/);
  for (const name of cliSteps) {
    const step = stepBlock(workflow, name);
    assert.match(step, /SUPABASE_ACCESS_TOKEN:\s*\$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/);
    assert.match(step, /SUPABASE_DB_PASSWORD:\s*\$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/);
  }
  assert.equal(
    [...workflow.matchAll(/SUPABASE_ACCESS_TOKEN:\s*\$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/g)].length,
    cliSteps.length,
    "the access token must be available only to Supabase CLI steps",
  );
  assert.equal(
    [...workflow.matchAll(/SUPABASE_DB_PASSWORD:\s*\$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/g)].length,
    cliSteps.length,
    "the database password must be available only to Supabase CLI steps",
  );

  const importer = stepBlock(workflow, "Stage The War Atlas import");
  assert.match(importer, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.equal(
    [...workflow.matchAll(/SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/g)].length,
    1,
    "the service-role key must remain importer-only",
  );
});

test("workflow delegates incident reporting to the executable helper", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const reportJob = workflow.slice(workflow.indexOf("  report:"));

  assert.match(reportJob, /actions\/checkout@v4/);
  assert.match(reportJob, /\.github\/scripts\/report-supabase-sync\.mjs/);
  assert.match(reportJob, /reportSupabaseSync\(\{ github, context, syncResult: process\.env\.SYNC_RESULT \}\)/);
});

test("comments on recovery before closing the stable incident issue", async () => {
  const calls = [];
  const github = {
    paginate: async (method, options) => {
      calls.push(["paginate", method, options]);
      return [
        { number: 9, title: "Unrelated issue" },
        { number: 12, title: "Supabase automation failure", pull_request: { url: "pr" } },
        { number: 42, title: "Supabase automation failure" },
      ];
    },
    rest: {
      issues: {
        listForRepo: "listForRepo",
        createComment: async (options) => calls.push(["createComment", options]),
        update: async (options) => calls.push(["update", options]),
      },
    },
  };
  const context = {
    serverUrl: "https://github.example",
    runId: 1234,
    repo: { owner: "bellumetrics", repo: "website" },
  };

  await reportSupabaseSync({ github, context, syncResult: "success" });

  assert.deepEqual(calls.map(([name]) => name), ["paginate", "createComment", "update"]);
  assert.deepEqual(calls[0].slice(1), [
    "listForRepo",
    {
      owner: "bellumetrics",
      repo: "website",
      state: "open",
      labels: "automation",
      per_page: 100,
    },
  ]);
  assert.deepEqual(calls[1][1], {
    owner: "bellumetrics",
    repo: "website",
    issue_number: 42,
    body: "Supabase synchronization recovered in [workflow run 1234](https://github.example/bellumetrics/website/actions/runs/1234).",
  });
  assert.deepEqual(calls[2][1], {
    owner: "bellumetrics",
    repo: "website",
    issue_number: 42,
    state: "closed",
  });
});

test("documents Supabase automation setup and staging boundaries", async () => {
  const readme = await readFile(readmeUrl, "utf8");

  assert.match(readme, /\.github\/workflows\/supabase-sync\.yml/);
  assert.match(readme, /SUPABASE_ACCESS_TOKEN/);
  assert.match(readme, /SUPABASE_DB_PASSWORD/);
  assert.match(readme, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(
    readme,
    /SUPABASE_SERVICE_ROLE_KEY\s*=\s*["'][^"'`]+["']/,
    "README must not include a service-role credential-like example",
  );
  assert.match(readme, /Monday at 04:00 UTC/i);
  assert.match(readme, /staging[^\n]*pending review/i);
  assert.match(readme, /ejecución manual desde la pestaña \*\*Actions\*\*/i);
  assert.match(readme, /fallos actualizan una única incidencia estable/i);
  assert.match(readme, /incidencia se cierra cuando la ejecución se recupera/i);
});
