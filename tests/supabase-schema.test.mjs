import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/202608150001_wiki_data_foundation.sql",
  import.meta.url,
);

const curationMigrationUrl = new URL(
  "../supabase/migrations/20260829182707_ai_curation.sql",
  import.meta.url,
);

const rpcPrivilegeMigrationUrl = new URL(
  "../supabase/migrations/20260829183417_restrict_worker_rpc_execution.sql",
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

const curationTableColumns = {
  curator_memberships: [
    ["user_id", "uuid"],
    ["role", "text"],
    ["created_at", "timestamp with time zone"],
  ],
  curation_cases: [
    ["id", "bigint"],
    ["case_key", "text"],
    ["entity_type", "text"],
    ["source_revision", "text"],
    ["payload", "jsonb"],
    ["status", "text"],
    ["priority", "integer"],
    ["lease_owner", "text"],
    ["lease_expires_at", "timestamp with time zone"],
    ["attempt_count", "integer"],
    ["last_error", "text"],
    ["created_at", "timestamp with time zone"],
    ["updated_at", "timestamp with time zone"],
  ],
  ai_reviews: [
    ["id", "bigint"],
    ["case_id", "bigint"],
    ["review_role", "text"],
    ["model", "text"],
    ["prompt_version", "text"],
    ["evidence", "jsonb"],
    ["decision", "jsonb"],
    ["created_at", "timestamp with time zone"],
  ],
  editorial_events: [
    ["id", "bigint"],
    ["case_id", "bigint"],
    ["actor_type", "text"],
    ["actor_id", "text"],
    ["action", "text"],
    ["before_state", "jsonb"],
    ["after_state", "jsonb"],
    ["reason", "text"],
    ["created_at", "timestamp with time zone"],
  ],
  ranking_jobs: [
    ["id", "bigint"],
    ["data_revision", "text"],
    ["algorithm_version", "text"],
    ["status", "text"],
    ["lease_owner", "text"],
    ["lease_expires_at", "timestamp with time zone"],
    ["attempt_count", "integer"],
    ["last_error", "text"],
    ["created_at", "timestamp with time zone"],
    ["completed_at", "timestamp with time zone"],
  ],
  ranking_snapshots: [
    ["id", "bigint"],
    ["data_revision", "text"],
    ["algorithm_version", "text"],
    ["results", "jsonb"],
    ["created_at", "timestamp with time zone"],
  ],
};

const curationPrimaryKeys = [
  ["ai_reviews", "id"],
  ["curation_cases", "id"],
  ["curator_memberships", "user_id"],
  ["editorial_events", "id"],
  ["ranking_jobs", "id"],
  ["ranking_snapshots", "id"],
];

const curationIdentitySequences = [
  "ai_reviews_id_seq",
  "curation_cases_id_seq",
  "editorial_events_id_seq",
  "ranking_jobs_id_seq",
  "ranking_snapshots_id_seq",
];

const tablePrivileges = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN",
];

const sequencePrivileges = ["USAGE", "SELECT", "UPDATE"];

async function migratedDatabase({ permissiveDefaults = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid
      language sql stable
      as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
    grant usage on schema auth to authenticated;
    ${permissiveDefaults ? `
      alter default privileges in schema public
        grant all privileges on tables to anon, authenticated;
      alter default privileges in schema public
        grant all privileges on sequences to anon, authenticated;
      alter default privileges in schema public
        grant execute on functions to anon, authenticated;
    ` : ""}
  `);
  await db.exec(await readFile(migrationUrl, "utf8"));
  await db.exec(await readFile(curationMigrationUrl, "utf8"));
  await db.exec(await readFile(rpcPrivilegeMigrationUrl, "utf8"));
  return db;
}

test("creates the curation tables with their required columns", async () => {
  const db = await migratedDatabase();
  try {
    for (const [table, expectedColumns] of Object.entries(curationTableColumns)) {
      const { rows } = await db.query(`
        select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as column_type
        from pg_attribute a
        where a.attrelid = $1::regclass
          and a.attnum > 0
          and not a.attisdropped
        order by a.attnum
      `, [`public.${table}`]);

      assert.deepEqual(
        rows.map(({ column_name, column_type }) => [column_name, column_type]),
        expectedColumns,
        `${table} does not have the required curation contract`,
      );
    }
  } finally {
    await db.close();
  }
});

test("enforces curation primary keys, case references, and unique identifiers", async () => {
  const db = await migratedDatabase();
  try {
    const { rows: primaryKeys } = await db.query(`
      select c.relname as table_name, a.attname as column_name
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join unnest(con.conkey) with ordinality key_column(attnum, position) on true
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = key_column.attnum
      where con.contype = 'p'
        and c.relnamespace = 'public'::regnamespace
        and c.relname in ('ai_reviews', 'curation_cases', 'curator_memberships',
          'editorial_events', 'ranking_jobs', 'ranking_snapshots')
      order by c.relname, key_column.position
    `);
    assert.deepEqual(
      primaryKeys.map(({ table_name, column_name }) => [table_name, column_name]),
      curationPrimaryKeys,
      "every curation table must retain its required primary key",
    );

    const { rows: cases } = await db.query(`
      insert into public.curation_cases (case_key, entity_type, source_revision, payload)
      values ('constraint-case', 'battle', 'source-v1', '{}'::jsonb)
      returning id
    `);
    const caseId = cases[0].id;

    await assert.rejects(
      db.exec(`
        insert into public.curation_cases (case_key, entity_type, source_revision, payload)
        values ('constraint-case', 'battle', 'source-v1', '{}'::jsonb)
      `),
      /duplicate key|unique constraint/i,
      "case_key must remain unique",
    );
    for (const table of ["ai_reviews", "editorial_events"]) {
      const insert = table === "ai_reviews"
        ? `insert into public.ai_reviews (case_id, review_role, model, prompt_version, evidence, decision)
          values (${caseId + 1}, 'proposer', 'test-model', 'v1', '[]'::jsonb, '{}'::jsonb)`
        : `insert into public.editorial_events (case_id, actor_type, action)
          values (${caseId + 1}, 'system', 'created')`;
      await assert.rejects(
        db.exec(insert),
        /foreign key/i,
        `${table}.case_id must reference curation_cases.id`,
      );
    }

    await db.exec(`
      insert into public.ranking_snapshots (data_revision, algorithm_version, results)
      values ('data-v1', 'elo-v1', '[]'::jsonb)
    `);
    await assert.rejects(
      db.exec(`
        insert into public.ranking_snapshots (data_revision, algorithm_version, results)
        values ('data-v1', 'elo-v1', '[]'::jsonb)
      `),
      /duplicate key|unique constraint/i,
      "ranking snapshots must be unique per data and algorithm version",
    );
  } finally {
    await db.close();
  }
});

test("protects every curation table and sequence with least-privilege boundaries", async () => {
  const db = await migratedDatabase({ permissiveDefaults: true });
  try {
    for (const table of Object.keys(curationTableColumns)) {
      const { rows: rls } = await db.query(
        "select relrowsecurity from pg_class where oid = $1::regclass",
        [`public.${table}`],
      );
      assert.equal(rls[0].relrowsecurity, true, `${table} must enable RLS`);

      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const privilege of tablePrivileges) {
          const allowed = (await db.query(
            "select has_table_privilege($1, $2, $3) as allowed",
            [role, `public.${table}`, privilege],
          )).rows[0].allowed;
          assert.equal(
            allowed,
            role === "authenticated" && privilege === "SELECT",
            `${role} has an unexpected ${privilege} privilege on ${table}`,
          );
        }
      }
    }

    for (const sequence of curationIdentitySequences) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const privilege of sequencePrivileges) {
          const allowed = (await db.query(
            "select has_sequence_privilege($1, $2, $3) as allowed",
            [role, `public.${sequence}`, privilege],
          )).rows[0].allowed;
          assert.equal(
            allowed,
            false,
            `${role} has an unexpected ${privilege} privilege on ${sequence}`,
          );
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("worker RPCs remain service-role-only under permissive Supabase defaults", async () => {
  const db = await migratedDatabase({ permissiveDefaults: true });
  const workerFunctions = [
    "public.enqueue_curation_case(text,text,text,jsonb)",
    "public.heartbeat_curation_case(bigint,text,integer)",
    "public.lease_curation_case(text,integer)",
    "public.read_curation_reviews(bigint,text)",
    "public.record_ai_review(bigint,text,text,text,text,jsonb,jsonb)",
    "public.release_curation_case(bigint,text,text,text)",
  ];

  try {
    for (const functionName of workerFunctions) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const { rows } = await db.query(
          "select has_function_privilege($1, $2, 'EXECUTE') as allowed",
          [role, functionName],
        );
        assert.equal(
          rows[0].allowed,
          role === "service_role",
          `${role} has an unexpected EXECUTE privilege on ${functionName}`,
        );
      }
    }
  } finally {
    await db.close();
  }
});

test("only an owner membership can read curation records", async () => {
  const db = await migratedDatabase();
  const ownerId = "00000000-0000-0000-0000-000000000001";
  const nonOwnerId = "00000000-0000-0000-0000-000000000002";
  try {
    await db.exec(`
      insert into public.curator_memberships (user_id, role)
      values ('${ownerId}', 'owner');
      insert into public.curation_cases (case_key, entity_type, source_revision, payload)
      values ('case-owner-read', 'battle', 'source-v1', '{}'::jsonb);
      insert into public.ai_reviews (case_id, review_role, model, prompt_version, evidence, decision)
      values (1, 'proposer', 'test-model', 'v1', '[]'::jsonb, '{}'::jsonb);
      insert into public.editorial_events (case_id, actor_type, action)
      values (1, 'system', 'created');
      insert into public.ranking_jobs (data_revision, algorithm_version)
      values ('data-v1', 'elo-v1');
      insert into public.ranking_snapshots (data_revision, algorithm_version, results)
      values ('data-v1', 'elo-v1', '[]'::jsonb);
      select set_config('request.jwt.claim.sub', '${ownerId}', false);
      set role authenticated;
    `);

    for (const table of Object.keys(curationTableColumns)) {
      const { rows } = await db.query(`select count(*)::int as count from public.${table}`);
      assert.deepEqual(rows, [{ count: 1 }], `owner could not read ${table}`);
    }

    await assert.rejects(
      db.exec(`
        insert into public.curation_cases (case_key, entity_type, source_revision, payload)
        values ('browser-write', 'battle', 'source-v1', '{}'::jsonb)
      `),
      /permission denied|row-level security/i,
    );

    await db.exec(`
      reset role;
      select set_config('request.jwt.claim.sub', '${nonOwnerId}', false);
      set role authenticated;
    `);
    for (const table of Object.keys(curationTableColumns)) {
      const { rows } = await db.query(`select count(*)::int as count from public.${table}`);
      assert.deepEqual(rows, [{ count: 0 }], `non-owner could read ${table}`);
    }
  } finally {
    await db.close();
  }
});

test("creates the canonical, staging, and curation tables with RLS enabled", async () => {
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
        "ai_reviews",
        "campaigns",
        "claim_sources",
        "claims",
        "commander_claims",
        "commanders",
        "curation_cases",
        "curator_memberships",
        "editorial_events",
        "engagement_claims",
        "engagement_sides",
        "engagements",
        "import_records",
        "import_runs",
        "participation_claims",
        "participations",
        "ranking_jobs",
        "ranking_snapshots",
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
