import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("live contract checks schema, RLS, grants, and staging isolation", async () => {
  const sql = await readFile("supabase/tests/wiki_data_foundation_test.sql", "utf8");
  const executableSql = sql.replace(/--[^\n]*/g, "");
  assert.match(executableSql, /plan\(10\)/);

  for (const table of [
    "commanders",
    "campaigns",
    "engagements",
    "engagement_sides",
    "participations",
    "result_interpretations",
    "sources",
    "claims",
    "claim_sources",
    "commander_claims",
    "engagement_claims",
    "participation_claims",
    "result_interpretation_claims",
  ]) {
    assert.match(executableSql, new RegExp(`'${table}'`));
  }

  for (const table of ["import_runs", "import_records"]) {
    assert.match(executableSql, new RegExp(`'${table}'`));
  }

  for (const privilege of [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
  ]) {
    assert.match(executableSql, new RegExp(`'${privilege}'`));
  }

  assert.match(executableSql, /relrowsecurity/);
  assert.match(executableSql, /has_table_privilege/);
  assert.match(executableSql, /not has_table_privilege/);
  assert.match(executableSql, /commanders_public_read/);
  assert.match(executableSql, /status = 'staged'/);
});
