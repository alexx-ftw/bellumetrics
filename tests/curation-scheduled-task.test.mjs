import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const taskUrl = new URL("../deploy/codex/scheduled-task.json", import.meta.url);
const workflowsUrl = new URL("../.github/workflows/", import.meta.url);

test("scheduled curation uses one hourly ChatGPT task with connected GitHub and Supabase", async () => {
  const task = JSON.parse(await readFile(taskUrl, "utf8"));

  assert.deepEqual(task, {
    schemaVersion: 1,
    title: "Curar Bellumetrics",
    promptFile: "worker/curation/prompts/scheduled-task-v1.md",
    schedule: "BEGIN:VEVENT\nRRULE:FREQ=HOURLY\nEND:VEVENT",
    timingMode: "exact_schedule",
    defaultTimezone: "Atlantic/Canary",
    requiredConnectors: ["github", "supabase"],
    limits: { casesPerRun: 1 },
  });
});

test("scheduled curation fails closed and keeps the reviewer independent", async () => {
  const task = JSON.parse(await readFile(taskUrl, "utf8"));
  const prompt = await readFile(new URL(`../${task.promptFile}`, import.meta.url), "utf8");

  assert.match(prompt, /como m[aá]ximo un caso/i);
  assert.match(prompt, /no (?:muestres|reveles|compartas).*proponente.*revisor/is);
  assert.match(prompt, /lease_curation_case/);
  assert.match(prompt, /record_ai_review/);
  assert.match(prompt, /publish_curation_decision/);
  assert.match(prompt, /release_curation_case/);
  assert.match(prompt, /lease_ranking_job/);
  assert.match(prompt, /read_ranking_input/);
  assert.match(prompt, /complete_ranking_job/);
  assert.match(prompt, /sin hacer ninguna mutaci[oó]n/i);
  assert.doesNotMatch(prompt, /(?:OPENAI_API_KEY|auth\.json|service[_ -]?role[_ -]?key|eyJ[a-zA-Z0-9_-]{20,})/i);
});

test("GitHub Actions never stores or runs ChatGPT account authentication", async () => {
  const workflowNames = (await readdir(workflowsUrl)).filter((name) => /\.ya?ml$/i.test(name));
  const workflows = (
    await Promise.all(workflowNames.map((name) => readFile(new URL(name, workflowsUrl), "utf8")))
  ).join("\n");

  assert.doesNotMatch(workflows, /(?:auth\.json|CODEX_HOME|codex\s+login|OPENAI_API_KEY)/i);
});
