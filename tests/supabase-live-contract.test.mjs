import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("live contract checks schema, RLS, grants, and staging isolation", async () => {
  const sql = await readFile("supabase/tests/wiki_data_foundation_test.sql", "utf8");
  const executableSql = sql.replace(/--[^\n]*/g, "");
  assert.match(executableSql, /plan\(14\)/);

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
    "MAINTAIN",
  ]) {
    assert.match(executableSql, new RegExp(`'${privilege}'`));
  }

  assert.match(executableSql, /relrowsecurity/);
  assert.match(executableSql, /has_table_privilege/);
  assert.match(executableSql, /not has_table_privilege/);
  for (const policy of [
    "commanders_public_read",
    "participations_public_read",
    "claim_sources_public_read",
    "commander_claims_public_read",
    "engagement_claims_public_read",
    "participation_claims_public_read",
    "result_interpretation_claims_public_read",
  ]) {
    assert.match(executableSql, new RegExp(policy));
  }
  assert.match(executableSql, /has_sequence_privilege/);
  assert.match(executableSql, /service_role/);
  assert.match(executableSql, /source_dataset = 'the-war-atlas'/);
  assert.match(executableSql, /row_counts->'actual'/);
  assert.match(executableSql, /import_records/);
});
