import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/202608150001_wiki_data_foundation.sql",
  import.meta.url,
);

const canonicalTables = [
  "campaigns",
  "claim_sources",
  "claims",
  "commander_claims",
  "commanders",
  "engagement_claims",
  "engagement_sides",
  "engagements",
  "participation_claims",
  "participations",
  "result_interpretation_claims",
  "result_interpretations",
  "sources",
];

const identitySequences = [
  "campaigns_id_seq",
  "claims_id_seq",
  "commanders_id_seq",
  "engagement_sides_id_seq",
  "engagements_id_seq",
  "import_records_id_seq",
  "import_runs_id_seq",
  "participations_id_seq",
  "result_interpretations_id_seq",
  "sources_id_seq",
];

async function migratedDatabase({ permissiveDefaults = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    ${permissiveDefaults ? `
      alter default privileges in schema public
        grant all privileges on tables to anon, authenticated;
      alter default privileges in schema public
        grant all privileges on sequences to anon, authenticated;
    ` : ""}
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

test("normalizes permissive API defaults and explicitly enables staging imports", async () => {
  const db = await migratedDatabase({ permissiveDefaults: true });
  try {
    for (const role of ["anon", "authenticated"]) {
      for (const table of canonicalTables) {
        assert.equal(
          (await db.query(
            "select has_table_privilege($1, $2, $3) as allowed",
            [role, `public.${table}`, "SELECT"],
          )).rows[0].allowed,
          true,
          `${role} should read ${table}`,
        );
        for (const privilege of [
          "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN",
        ]) {
          assert.equal(
            (await db.query(
              "select has_table_privilege($1, $2, $3) as allowed",
              [role, `public.${table}`, privilege],
            )).rows[0].allowed,
            false,
            `${role} must not have ${privilege} on ${table}`,
          );
        }
      }

      for (const sequence of identitySequences) {
        for (const privilege of ["USAGE", "SELECT", "UPDATE"]) {
          assert.equal(
            (await db.query(
              "select has_sequence_privilege($1, $2, $3) as allowed",
              [role, `public.${sequence}`, privilege],
            )).rows[0].allowed,
            false,
            `${role} must not have ${privilege} on ${sequence}`,
          );
        }
      }
    }

    for (const table of ["import_runs", "import_records"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
        assert.equal(
          (await db.query(
            "select has_table_privilege('service_role', $1, $2) as allowed",
            [`public.${table}`, privilege],
          )).rows[0].allowed,
          true,
          `service_role should have ${privilege} on ${table}`,
        );
      }
    }

    for (const sequence of ["import_runs_id_seq", "import_records_id_seq"]) {
      for (const privilege of ["USAGE", "SELECT"]) {
        assert.equal(
          (await db.query(
            "select has_sequence_privilege('service_role', $1, $2) as allowed",
            [`public.${sequence}`, privilege],
          )).rows[0].allowed,
          true,
          `service_role should have ${privilege} on ${sequence}`,
        );
      }
    }
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

test("anonymous access hides relationship rows with any pending endpoint", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into public.campaigns (slug, title, publication_status) values
        ('published-campaign', 'Published Campaign', 'published'),
        ('pending-campaign', 'Pending Campaign', 'pending');
      insert into public.commanders (slug, display_name, publication_status) values
        ('published-commander', 'Published Commander', 'published'),
        ('pending-commander', 'Pending Commander', 'pending');
      insert into public.engagements (campaign_id, slug, title, publication_status) values
        ((select id from public.campaigns where slug = 'published-campaign'), 'published-engagement', 'Published Engagement', 'published'),
        ((select id from public.campaigns where slug = 'pending-campaign'), 'pending-campaign-engagement', 'Pending Campaign Engagement', 'published');
      insert into public.engagement_sides (engagement_id, position, label) values
        ((select id from public.engagements where slug = 'published-engagement'), 1, 'Published Side'),
        ((select id from public.engagements where slug = 'pending-campaign-engagement'), 1, 'Hidden Side');
      insert into public.participations (engagement_side_id, commander_id, role) values
        ((select id from public.engagement_sides where label = 'Published Side'), (select id from public.commanders where slug = 'published-commander'), 'visible'),
        ((select id from public.engagement_sides where label = 'Published Side'), (select id from public.commanders where slug = 'pending-commander'), 'hidden-commander');
      insert into public.result_interpretations (engagement_id, label, summary, publication_status) values
        ((select id from public.engagements where slug = 'published-engagement'), 'Visible Interpretation', 'Visible', 'published'),
        ((select id from public.engagements where slug = 'pending-campaign-engagement'), 'Hidden Interpretation', 'Hidden', 'published');
      insert into public.sources (source_type, title, publication_status) values
        ('academic', 'Published Source', 'published'),
        ('academic', 'Pending Source', 'pending');
      insert into public.claims (claim_type, statement, publication_status) values
        ('outcome', 'Published Claim', 'published'),
        ('outcome', 'Pending Claim', 'pending');
      insert into public.claim_sources (claim_id, source_id) values
        ((select id from public.claims where statement = 'Published Claim'), (select id from public.sources where title = 'Published Source')),
        ((select id from public.claims where statement = 'Published Claim'), (select id from public.sources where title = 'Pending Source'));
      insert into public.commander_claims (commander_id, claim_id) values
        ((select id from public.commanders where slug = 'published-commander'), (select id from public.claims where statement = 'Published Claim')),
        ((select id from public.commanders where slug = 'pending-commander'), (select id from public.claims where statement = 'Published Claim'));
      insert into public.engagement_claims (engagement_id, claim_id) values
        ((select id from public.engagements where slug = 'published-engagement'), (select id from public.claims where statement = 'Published Claim')),
        ((select id from public.engagements where slug = 'pending-campaign-engagement'), (select id from public.claims where statement = 'Published Claim'));
      insert into public.participation_claims (participation_id, claim_id) values
        ((select id from public.participations where role = 'visible'), (select id from public.claims where statement = 'Published Claim')),
        ((select id from public.participations where role = 'hidden-commander'), (select id from public.claims where statement = 'Published Claim'));
      insert into public.result_interpretation_claims (result_interpretation_id, claim_id) values
        ((select id from public.result_interpretations where label = 'Visible Interpretation'), (select id from public.claims where statement = 'Published Claim')),
        ((select id from public.result_interpretations where label = 'Hidden Interpretation'), (select id from public.claims where statement = 'Published Claim'));
      set role anon;
    `);

    for (const [table, identifyingColumn, expected] of [
      ["engagements", "slug", "published-engagement"],
      ["engagement_sides", "label", "Published Side"],
      ["participations", "role", "visible"],
      ["result_interpretations", "label", "Visible Interpretation"],
    ]) {
      const { rows } = await db.query(
        `select ${identifyingColumn} as value from public.${table} order by ${identifyingColumn}`,
      );
      assert.deepEqual(rows, [{ value: expected }], `${table} leaked a pending endpoint`);
    }

    for (const table of [
      "claim_sources",
      "commander_claims",
      "engagement_claims",
      "participation_claims",
      "result_interpretation_claims",
    ]) {
      const { rows } = await db.query(`select count(*)::int as count from public.${table}`);
      assert.deepEqual(rows, [{ count: 1 }], `${table} leaked a pending endpoint`);
    }
  } finally {
    await db.close();
  }
});
