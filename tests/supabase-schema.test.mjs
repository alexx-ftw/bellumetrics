import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/202608150001_wiki_data_foundation.sql",
  import.meta.url,
);

async function migratedDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
  `);
  await db.exec(await readFile(migrationUrl, "utf8"));
  return db;
}

test("creates the canonical and staging tables with RLS enabled", async () => {
  const db = await migratedDatabase();
  try {
    const { rows: tables } = await db.query(`
      select tablename
      from pg_tables
      where schemaname = 'public'
      order by tablename
    `);

    assert.deepEqual(
      tables.map(({ tablename }) => tablename),
      [
        "campaigns",
        "claim_sources",
        "claims",
        "commander_claims",
        "commanders",
        "engagement_claims",
        "engagement_sides",
        "engagements",
        "import_records",
        "import_runs",
        "participation_claims",
        "participations",
        "result_interpretation_claims",
        "result_interpretations",
        "sources",
      ],
    );

    const { rows: rlsTables } = await db.query(`
      select relname, relrowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace
        and relkind = 'r'
      order by relname
    `);
    assert.ok(rlsTables.every(({ relrowsecurity }) => relrowsecurity));
  } finally {
    await db.close();
  }
});

test("anonymous access sees published commanders but cannot write", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into public.commanders (slug, display_name, publication_status)
      values
        ('published-general', 'Published General', 'published'),
        ('pending-general', 'Pending General', 'pending');
      set role anon;
    `);

    const { rows } = await db.query(`
      select slug from public.commanders order by slug
    `);
    assert.deepEqual(rows, [{ slug: "published-general" }]);

    await assert.rejects(
      db.exec(`
        insert into public.commanders (slug, display_name)
        values ('blocked-general', 'Blocked General')
      `),
      /permission denied|row-level security/i,
    );
  } finally {
    await db.close();
  }
});

test("staging tables are unavailable to anonymous clients", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec("set role anon");
    await assert.rejects(
      db.query("select * from public.import_runs"),
      /permission denied/i,
    );
  } finally {
    await db.close();
  }
});
