import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  createOwnerPublicationRepository,
  createPublicationRepository,
} from "../lib/curation/publication-repository.mjs";
import { createCurationWorker } from "../worker/curation/orchestrator.mjs";

const foundationMigrationUrl = new URL(
  "../supabase/migrations/202608150001_wiki_data_foundation.sql",
  import.meta.url,
);
const curationMigrationUrl = new URL(
  "../supabase/migrations/20260829182707_ai_curation.sql",
  import.meta.url,
);
const publicationMigrationUrl = new URL(
  "../supabase/migrations/20260829182958_publication_and_ranking.sql",
  import.meta.url,
);
const ownerPublicationMigrationUrl = new URL(
  "../supabase/migrations/20260829183033_owner_canonical_publication.sql",
  import.meta.url,
);
const commanderBootstrapMigrationUrl = new URL(
  "../supabase/migrations/20260904175447_bootstrap_war_atlas_commanders.sql",
  import.meta.url,
);

const ownerId = "00000000-0000-0000-0000-000000000001";
const nonOwnerId = "00000000-0000-0000-0000-000000000002";

async function migratedDatabase() {
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
  `);
  await db.exec(await readFile(foundationMigrationUrl, "utf8"));
  await db.exec(await readFile(curationMigrationUrl, "utf8"));
  await db.exec(await readFile(publicationMigrationUrl, "utf8"));
  await db.exec(await readFile(ownerPublicationMigrationUrl, "utf8"));
  await db.exec(await readFile(commanderBootstrapMigrationUrl, "utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20260905120000_reviewed_participants.sql", import.meta.url), "utf8"));
  return db;
}

function approvalDecision(promptVersion) {
  return {
    action: "approve_battle",
    evidence: [{
      citation: "Chandler, The Campaigns of Napoleon, p. 1021",
      url: "https://example.test/chandler-waterloo",
      locator: "p. 1021",
    }],
    reason: "The cited source identifies the battle and both commanders.",
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
    dataRevision: "war-atlas-2026-08-24",
    promptVersion,
  };
}

function warAtlasApprovalDecision(promptVersion) {
  const decision = approvalDecision(promptVersion);
  decision.canonicalMutation.commanderRefs = [
    { type: "commander", id: "war-atlas:napoleon_bonaparte" },
    { type: "commander", id: "war-atlas:arthur_wellesley" },
  ];
  return decision;
}

function identityDecision(action, promptVersion) {
  return {
    action,
    evidence: [{
      citation: "Oxford Dictionary of National Biography, Arthur Wellesley",
      url: "https://example.test/wellesley",
    }],
    reason: action === "merge_commanders"
      ? "Both records identify the same commander."
      : "The records must remain distinct.",
    canonicalMutation: {
      action,
      source: { type: "commander", id: "war-atlas:arthur-wellesley" },
      target: { type: "commander", id: "wikidata:Q152245" },
    },
    dataRevision: "war-atlas-2026-08-24",
    promptVersion,
  };
}

async function insertLeasedCase(db, {
  caseKey,
  entityType,
  payload,
  workerId = "publication-worker",
}) {
  const { rows } = await db.query(
    `insert into public.curation_cases (
      case_key, entity_type, source_revision, payload, status,
      lease_owner, lease_expires_at
    ) values ($1, $2, 'war-atlas-2026-08-24', $3::jsonb, 'leased', $4,
      clock_timestamp() + interval '5 minutes')
    returning id`,
    [caseKey, entityType, JSON.stringify(payload), workerId],
  );
  return rows[0].id;
}

async function insertReviews(db, caseId, proposer, reviewer) {
  const { rows } = await db.query(
    `insert into public.ai_reviews (
      case_id, review_role, model, prompt_version, evidence, decision
    ) values
      ($1, 'proposer', 'gpt-5', 'proposer-v1', $2::jsonb, $3::jsonb),
      ($1, 'reviewer', 'gpt-5', 'reviewer-v1', $4::jsonb, $5::jsonb)
    returning id, review_role`,
    [
      caseId,
      JSON.stringify(proposer.evidence),
      JSON.stringify(proposer),
      JSON.stringify(reviewer.evidence),
      JSON.stringify(reviewer),
    ],
  );
  return {
    proposerReviewId: rows.find(({ review_role }) => review_role === "proposer").id,
    reviewerReviewId: rows.find(({ review_role }) => review_role === "reviewer").id,
  };
}

async function publish(db, caseId, workerId = "publication-worker", selectedReviews = null) {
  let reviewIds = selectedReviews;
  if (!reviewIds) {
    const { rows } = await db.query(
      `select id, review_role from public.ai_reviews
       where case_id = $1
       order by created_at desc, id desc`,
      [caseId],
    );
    reviewIds = {
      proposerReviewId: rows.find(({ review_role }) => review_role === "proposer")?.id,
      reviewerReviewId: rows.find(({ review_role }) => review_role === "reviewer")?.id,
    };
  }
  await db.exec("set role service_role");
  try {
    const { rows } = await db.query(
      "select * from public.publish_curation_decision($1, $2, $3, $4, $5)",
      [caseId, workerId, reviewIds.proposerReviewId, reviewIds.reviewerReviewId, "gpt-5"],
    );
    return rows[0];
  } finally {
    await db.exec("reset role");
  }
}

async function seedBattleCommanders(db) {
  await db.exec(`
    insert into public.commanders (slug, display_name, wikidata_qid, publication_status)
    values
      ('napoleon', 'Napoleon Bonaparte', 'Q517', 'published'),
      ('arthur-wellesley', 'Arthur Wellesley', 'Q152245', 'published');
  `);
}

test("an AI approval creates ordered War Atlas commanders with canonical slugs exactly once", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await insertLeasedCase(db, {
      caseKey: "publish-waterloo-with-imported-commanders",
      entityType: "battle",
      payload: {
        wikidata_qid: "Q48314",
        date_iso: "1815-06-18",
        commanders: [
          {
            slug: "napoleon_bonaparte",
            name: "Napoleon Bonaparte",
            side: "France",
            rank: "Emperor",
          },
          {
            slug: "arthur_wellesley",
            name: "Arthur Wellesley",
            side: "Coalition",
            rank: "Field Marshal",
          },
        ],
        source_slugs: ["chandler-waterloo"],
      },
    });
    const proposer = warAtlasApprovalDecision("proposer-v1");
    const reviewer = warAtlasApprovalDecision("reviewer-v1");
    await insertReviews(db, caseId, proposer, reviewer);

    const first = await publish(db, caseId);
    const repeated = await publish(db, caseId);

    assert.deepEqual(repeated, first);
    assert.deepEqual((await db.query(`
      select slug, display_name, publication_status
      from public.commanders
      order by slug
    `)).rows, [
      {
        slug: "arthur-wellesley",
        display_name: "Arthur Wellesley",
        publication_status: "published",
      },
      {
        slug: "napoleon-bonaparte",
        display_name: "Napoleon Bonaparte",
        publication_status: "published",
      },
    ]);
    assert.deepEqual((await db.query(`
      select side.position, commander.slug
      from public.engagement_sides side
      join public.participations participation
        on participation.engagement_side_id = side.id
      join public.commanders commander on commander.id = participation.commander_id
      order by side.position
    `)).rows, [
      { position: 1, slug: "napoleon-bonaparte" },
      { position: 2, slug: "arthur-wellesley" },
    ]);
    assert.deepEqual((await db.query(`
      select
        jsonb_array_length(before_state->'commanders') as before_commanders,
        jsonb_array_length(after_state->'commanders') as after_commanders
      from public.editorial_events
      where id = $1
    `, [first.event_id])).rows, [{ before_commanders: 0, after_commanders: 2 }]);
  } finally {
    await db.close();
  }
});

test("reversing a bootstrapped battle removes only its newly created commanders", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into public.commanders (slug, display_name, publication_status)
      values ('napoleon-bonaparte', 'Napoleon I (canonical)', 'published');
    `);
    await db.exec(`insert into public.curator_memberships (user_id, role) values ('${ownerId}', 'owner');`);
    const caseId = await insertLeasedCase(db, {
      caseKey: "reverse-waterloo-with-imported-commanders",
      entityType: "battle",
      payload: {
        date_iso: "1815-06-18",
        commanders: [
          { slug: "napoleon_bonaparte", name: "Napoleon Bonaparte", side: "France", rank: "Emperor" },
          { slug: "arthur_wellesley", name: "Arthur Wellesley", side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    await insertReviews(
      db,
      caseId,
      warAtlasApprovalDecision("proposer-v1"),
      warAtlasApprovalDecision("reviewer-v1"),
    );
    const published = await publish(db, caseId);

    await db.exec(`select set_config('request.jwt.claim.sub', '${ownerId}', false); set role authenticated;`);
    await db.query(
      "select * from public.revert_editorial_event($1, $2, $3)",
      [published.event_id, ownerId, "Remove the imported battle and its new commanders"],
    );
    await db.exec("reset role");

    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.engagements) as engagements,
        (select count(*)::integer from public.commanders) as commanders,
        (select count(*)::integer from public.editorial_events) as events
    `)).rows, [{ engagements: 0, commanders: 1, events: 2 }]);
    assert.deepEqual((await db.query(`
      select slug, display_name, publication_status from public.commanders
    `)).rows, [{
      slug: "napoleon-bonaparte",
      display_name: "Napoleon I (canonical)",
      publication_status: "published",
    }]);
  } finally {
    await db.close();
  }
});

test("approval never creates unresolved canonical or Wikidata commander references", async () => {
  for (const [namespace, commanderRefs] of [
    ["canonical", [
      { type: "commander", id: "canonical:999" },
      { type: "commander", id: "canonical:1000" },
    ]],
    ["wikidata", [
      { type: "commander", id: "wikidata:Q517" },
      { type: "commander", id: "wikidata:Q152245" },
    ]],
  ]) {
    const db = await migratedDatabase();
    try {
      const caseId = await insertLeasedCase(db, {
        caseKey: `reject-unresolved-${namespace}-commanders`,
        entityType: "battle",
        payload: {
          commanders: [
            { slug: "napoleon", name: "Napoleon Bonaparte", side: "France", rank: "Emperor" },
            { slug: "wellington", name: "Arthur Wellesley", side: "Coalition", rank: "Field Marshal" },
          ],
        },
      });
      const proposer = approvalDecision("proposer-v1");
      proposer.canonicalMutation.commanderRefs = commanderRefs;
      const reviewer = approvalDecision("reviewer-v1");
      reviewer.canonicalMutation.commanderRefs = commanderRefs;
      await insertReviews(db, caseId, proposer, reviewer);

      await assert.rejects(publish(db, caseId), /commander reference does not resolve/i);
      assert.deepEqual((await db.query(`
        select
          (select count(*)::integer from public.commanders) as commanders,
          (select count(*)::integer from public.engagements) as engagements,
          (select count(*)::integer from public.editorial_events) as events
      `)).rows, [{ commanders: 0, engagements: 0, events: 0 }]);
    } finally {
      await db.close();
    }
  }
});

test("War Atlas commander refs cannot create identities during merge or separation", async () => {
  for (const action of ["merge_commanders", "separate_commanders"]) {
    const db = await migratedDatabase();
    try {
      const caseId = await insertLeasedCase(db, {
        caseKey: `no-bootstrap-during-${action}`,
        entityType: "commander",
        payload: {
          slug: "arthur_wellesley",
          name: "Arthur Wellesley",
        },
      });
      await insertReviews(
        db,
        caseId,
        identityDecision(action, "proposer-v1"),
        identityDecision(action, "reviewer-v1"),
      );

      await assert.rejects(publish(db, caseId), /commander reference does not resolve/i);
      assert.deepEqual((await db.query(`
        select
          (select count(*)::integer from public.commanders) as commanders,
          (select count(*)::integer from public.editorial_events) as events
      `)).rows, [{ commanders: 0, events: 0 }]);
    } finally {
      await db.close();
    }
  }
});

test("War Atlas commander refs must match the ordered battle payload", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await insertLeasedCase(db, {
      caseKey: "reject-misaligned-war-atlas-commanders",
      entityType: "battle",
      payload: {
        commanders: [
          { slug: "arthur_wellesley", name: "Arthur Wellesley", side: "Coalition", rank: "Field Marshal" },
          { slug: "napoleon_bonaparte", name: "Napoleon Bonaparte", side: "France", rank: "Emperor" },
        ],
      },
    });
    await insertReviews(
      db,
      caseId,
      warAtlasApprovalDecision("proposer-v1"),
      warAtlasApprovalDecision("reviewer-v1"),
    );

    await assert.rejects(publish(db, caseId), /does not match the ordered payload/i);
    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.commanders) as commanders,
        (select count(*)::integer from public.engagements) as engagements,
        (select count(*)::integer from public.editorial_events) as events
    `)).rows, [{ commanders: 0, engagements: 0, events: 0 }]);
  } finally {
    await db.close();
  }
});

test("publishes an approved battle and its complete audit graph exactly once", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    const caseId = await insertLeasedCase(db, {
      caseKey: "publish-waterloo",
      entityType: "battle",
      payload: {
        wikidata_qid: "Q48314",
        date_iso: "1815-06-18",
        commanders: [
          { slug: "napoleon", name: "Napoleon Bonaparte", side: "France", rank: "Emperor" },
          { slug: "arthur-wellesley", name: "Arthur Wellesley", side: "Coalition", rank: "Field Marshal" },
        ],
        source_slugs: ["chandler-waterloo"],
      },
    });
    await insertReviews(
      db,
      caseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );

    const first = await publish(db, caseId);
    const repeated = await publish(db, caseId);

    assert.deepEqual(repeated, first);
    assert.ok(first.event_id > 0);
    assert.ok(first.ranking_job_id > 0);
    const engagement = (await db.query(
      `select slug, title, start_year, end_year, date_display, date_precision,
        elo_eligible, publication_status
       from public.engagements where slug = 'waterloo'`,
    )).rows;
    assert.deepEqual(engagement, [{
      slug: "waterloo",
      title: "Battle of Waterloo",
      start_year: 1815,
      end_year: 1815,
      date_display: "1815-06-18",
      date_precision: "exact",
      elo_eligible: true,
      publication_status: "published",
    }]);
    assert.deepEqual((await db.query(`
      select s.position, s.label, s.outcome, c.slug as commander_slug, p.role
      from public.engagement_sides s
      join public.participations p on p.engagement_side_id = s.id
      join public.commanders c on c.id = p.commander_id
      order by s.position, p.id
    `)).rows, [
      {
        position: 1,
        label: "France",
        outcome: "victory",
        commander_slug: "napoleon",
        role: "Emperor",
      },
      {
        position: 2,
        label: "Coalition",
        outcome: "defeat",
        commander_slug: "arthur-wellesley",
        role: "Field Marshal",
      },
    ]);
    assert.deepEqual((await db.query(`
      select c.claim_type, c.statement, s.title, s.url, cs.relation
      from public.engagement_claims ec
      join public.claims c on c.id = ec.claim_id
      join public.claim_sources cs on cs.claim_id = c.id
      join public.sources s on s.id = cs.source_id
    `)).rows, [{
      claim_type: "approve_battle",
      statement: "The cited source identifies the battle and both commanders.",
      title: "Chandler, The Campaigns of Napoleon, p. 1021",
      url: "https://example.test/chandler-waterloo",
      relation: "supports",
    }]);
    assert.deepEqual((await db.query(`
      select c.status, c.lease_owner, e.action,
        jsonb_array_length(e.before_state->'engagements') as before_engagements,
        jsonb_array_length(e.after_state->'engagements') as after_engagements,
        j.status as job_status, j.editorial_event_id
      from public.curation_cases c
      join public.editorial_events e on e.case_id = c.id
      join public.ranking_jobs j on j.editorial_event_id = e.id
      where c.id = $1
    `, [caseId])).rows, [{
      status: "published",
      lease_owner: null,
      action: "approve_battle",
      before_engagements: 0,
      after_engagements: 1,
      job_status: "pending",
      editorial_event_id: first.event_id,
    }]);
  } finally {
    await db.close();
  }
});

test("approval updates an existing engagement and snapshots its prior canonical rows", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    await db.exec(`
      insert into public.engagements (
        slug, title, start_year, end_year, date_display, date_precision,
        elo_eligible, publication_status
      ) values (
        'waterloo', 'Unreviewed Waterloo record', 1814, 1814, 'circa 1814',
        'circa', false, 'pending'
      );
      insert into public.engagement_sides (engagement_id, position, label, outcome)
      values (1, 1, 'Unreviewed French force', 'unknown');
    `);
    const caseId = await insertLeasedCase(db, {
      caseKey: "update-waterloo",
      entityType: "battle",
      payload: {
        wikidata_qid: "Q48314",
        date_iso: "1815-06-18",
        commanders: [
          { side: "France", rank: "Emperor" },
          { side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    await insertReviews(
      db,
      caseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );

    const result = await publish(db, caseId);

    assert.deepEqual((await db.query(`
      select title, wikidata_qid, start_year, end_year, date_display,
        date_precision, elo_eligible, publication_status
      from public.engagements where id = 1
    `)).rows, [{
      title: "Battle of Waterloo",
      wikidata_qid: "Q48314",
      start_year: 1815,
      end_year: 1815,
      date_display: "1815-06-18",
      date_precision: "exact",
      elo_eligible: true,
      publication_status: "published",
    }]);
    assert.deepEqual((await db.query(`
      select position, label, outcome
      from public.engagement_sides order by position
    `)).rows, [
      { position: 1, label: "France", outcome: "victory" },
      { position: 2, label: "Coalition", outcome: "defeat" },
    ]);
    assert.deepEqual((await db.query(`
      select
        jsonb_array_length(before_state->'engagements') as engagements,
        jsonb_array_length(before_state->'engagement_sides') as sides
      from public.editorial_events where id = $1
    `, [result.event_id])).rows, [{ engagements: 1, sides: 1 }]);
  } finally {
    await db.close();
  }
});

test("rejects incompatible reviews and stale ownership before canonical writes", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    const incompatibleId = await insertLeasedCase(db, {
      caseKey: "incompatible-waterloo",
      entityType: "battle",
      payload: { commanders: [] },
    });
    const changed = approvalDecision("reviewer-v1");
    changed.canonicalMutation.battle.outcome = "draw";
    await insertReviews(
      db,
      incompatibleId,
      approvalDecision("proposer-v1"),
      changed,
    );
    await assert.rejects(publish(db, incompatibleId), /compatible reviews/i);

    const foreignLeaseId = await insertLeasedCase(db, {
      caseKey: "foreign-lease-waterloo",
      entityType: "battle",
      payload: { commanders: [] },
    });
    await insertReviews(
      db,
      foreignLeaseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );
    await assert.rejects(publish(db, foreignLeaseId, "foreign-worker"), /active lease owner/i);

    const counts = (await db.query(`
      select
        (select count(*)::integer from public.engagements) as engagements,
        (select count(*)::integer from public.editorial_events) as events,
        (select count(*)::integer from public.ranking_jobs) as jobs
    `)).rows[0];
    assert.deepEqual(counts, { engagements: 0, events: 0, jobs: 0 });
  } finally {
    await db.close();
  }
});

test("identity publication rejects every case entity type except commander", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into public.commanders (slug, display_name, wikidata_qid, publication_status)
      values
        ('arthur-wellesley', 'Arthur Wellesley (import)', null, 'published'),
        ('duke-of-wellington', 'Arthur Wellesley', 'Q152245', 'published');
    `);
    const caseId = await insertLeasedCase(db, {
      caseKey: "invalid-identity-entity-type",
      entityType: "faction",
      payload: {},
    });
    await insertReviews(
      db,
      caseId,
      identityDecision("merge_commanders", "proposer-v1"),
      identityDecision("merge_commanders", "reviewer-v1"),
    );

    await assert.rejects(
      publish(db, caseId),
      /entity|normalized canonical mutation|case type/i,
    );
    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.editorial_events) as events,
        (select count(*)::integer from public.commander_identity_links) as identity_links,
        (select count(*)::integer from public.commanders
          where publication_status = 'retired') as retired_commanders
    `)).rows, [{ events: 0, identity_links: 0, retired_commanders: 0 }]);
  } finally {
    await db.close();
  }
});

test("publishes only the exact compatible review ids and rejects tampered metadata", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    const payload = {
      date_iso: "1815-06-18",
      commanders: [
        { side: "France", rank: "Emperor" },
        { side: "Coalition", rank: "Field Marshal" },
      ],
    };
    const selectedCaseId = await insertLeasedCase(db, {
      caseKey: "selected-review-ids",
      entityType: "battle",
      payload,
    });
    const selected = await insertReviews(
      db,
      selectedCaseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );
    await db.exec("set role service_role");
    const storedReviewIds = (await db.query(
      `select review_id, review_role
       from public.read_curation_reviews($1, 'publication-worker')
       order by review_id`,
      [selectedCaseId],
    )).rows;
    await db.exec("reset role");
    assert.deepEqual(storedReviewIds, [
      { review_id: selected.proposerReviewId, review_role: "proposer" },
      { review_id: selected.reviewerReviewId, review_role: "reviewer" },
    ]);
    const laterReview = approvalDecision("reviewer-v1");
    laterReview.canonicalMutation.battle.outcome = "draw";
    await db.query(
      `insert into public.ai_reviews (
        case_id, review_role, model, prompt_version, evidence, decision
      ) values ($1, 'reviewer', 'gpt-5', 'reviewer-v1', $2::jsonb, $3::jsonb)`,
      [selectedCaseId, JSON.stringify(laterReview.evidence), JSON.stringify(laterReview)],
    );

    await publish(db, selectedCaseId, "publication-worker", selected);

    const tamperedCaseId = await insertLeasedCase(db, {
      caseKey: "tampered-selected-reviews",
      entityType: "battle",
      payload,
    });
    const tampered = await insertReviews(
      db,
      tamperedCaseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );
    await db.query(
      "update public.ai_reviews set model = 'gpt-unconfigured' where id = $1",
      [tampered.reviewerReviewId],
    );
    await assert.rejects(
      publish(db, tamperedCaseId, "publication-worker", tampered),
      /compatible reviews|configured model/i,
    );
    await db.query(
      "update public.ai_reviews set model = 'gpt-5', prompt_version = 'proposer-v1' where id = $1",
      [tampered.reviewerReviewId],
    );
    await assert.rejects(
      publish(db, tamperedCaseId, "publication-worker", tampered),
      /compatible reviews|prompt/i,
    );
    await db.query(
      `update public.ai_reviews
       set prompt_version = 'reviewer-v1',
           decision = jsonb_set(decision, '{dataRevision}', '"war-atlas-stale"'::jsonb)
       where id = $1`,
      [tampered.reviewerReviewId],
    );
    await assert.rejects(
      publish(db, tamperedCaseId, "publication-worker", tampered),
      /revision|normalized canonical mutation/i,
    );
    await db.query(
      `update public.ai_reviews
       set decision = jsonb_set(decision, '{dataRevision}', '"war-atlas-2026-08-24"'::jsonb),
           evidence = '[]'::jsonb
       where id = $1`,
      [tampered.reviewerReviewId],
    );
    await assert.rejects(
      publish(db, tamperedCaseId, "publication-worker", tampered),
      /evidence|compatible reviews/i,
    );
    await db.query(
      `update public.ai_reviews
       set evidence = decision->'evidence',
           decision = jsonb_set(decision, '{canonicalMutation,unexpectedRating}', '2400'::jsonb)
       where id in ($1, $2)`,
      [tampered.proposerReviewId, tampered.reviewerReviewId],
    );
    await assert.rejects(
      publish(db, tamperedCaseId, "publication-worker", tampered),
      /normalized canonical mutation|validated canonical mutation/i,
    );

    const foreignCaseId = await insertLeasedCase(db, {
      caseKey: "foreign-selected-review",
      entityType: "battle",
      payload,
    });
    const foreign = await insertReviews(
      db,
      foreignCaseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );
    await assert.rejects(
      publish(db, foreignCaseId, "publication-worker", {
        proposerReviewId: selected.proposerReviewId,
        reviewerReviewId: foreign.reviewerReviewId,
      }),
      /exact review ids|compatible reviews/i,
    );
  } finally {
    await db.close();
  }
});

test("deduplicates evidence items that resolve to the same canonical source", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    const caseId = await insertLeasedCase(db, {
      caseKey: "duplicate-evidence-waterloo",
      entityType: "battle",
      payload: {
        commanders: [
          { side: "France", rank: "Emperor" },
          { side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    const proposer = approvalDecision("proposer-v1");
    const reviewer = approvalDecision("reviewer-v1");
    proposer.evidence.push({ ...proposer.evidence[0] });
    reviewer.evidence.push({ ...reviewer.evidence[0] });
    await insertReviews(db, caseId, proposer, reviewer);

    await publish(db, caseId);

    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.sources) as sources,
        (select count(*)::integer from public.claim_sources) as claim_sources
    `)).rows, [{ sources: 1, claim_sources: 1 }]);
  } finally {
    await db.close();
  }
});

test("rolls back every canonical mutation and audit row when the final enqueue fails", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await insertLeasedCase(db, {
      caseKey: "rollback-waterloo",
      entityType: "battle",
      payload: {
        date_iso: "1815-06-18",
        commanders: [
          { slug: "napoleon_bonaparte", name: "Napoleon Bonaparte", side: "France", rank: "Emperor" },
          { slug: "arthur_wellesley", name: "Arthur Wellesley", side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    await insertReviews(
      db,
      caseId,
      warAtlasApprovalDecision("proposer-v1"),
      warAtlasApprovalDecision("reviewer-v1"),
    );
    await db.exec(`
      create function public.reject_test_ranking_job() returns trigger
      language plpgsql as $$
      begin
        raise exception 'forced ranking enqueue failure';
      end;
      $$;
      create trigger reject_test_ranking_job
      before insert on public.ranking_jobs
      for each row execute function public.reject_test_ranking_job();
    `);

    await assert.rejects(publish(db, caseId), /forced ranking enqueue failure/i);

    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.engagements) as engagements,
        (select count(*)::integer from public.commanders) as commanders,
        (select count(*)::integer from public.engagement_sides) as sides,
        (select count(*)::integer from public.participations) as participations,
        (select count(*)::integer from public.claims) as claims,
        (select count(*)::integer from public.sources) as sources,
        (select count(*)::integer from public.editorial_events) as events,
        (select count(*)::integer from public.ranking_jobs) as jobs,
        (select status from public.curation_cases where id = $1) as case_status
    `, [caseId])).rows, [{
      engagements: 0,
      commanders: 0,
      sides: 0,
      participations: 0,
      claims: 0,
      sources: 0,
      events: 0,
      jobs: 0,
      case_status: "leased",
    }]);
  } finally {
    await db.close();
  }
});

test("reversing an approved battle restores its full before_state snapshot", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    await db.exec(`
      insert into public.curator_memberships (user_id, role)
      values ('${ownerId}', 'owner');
    `);
    const caseId = await insertLeasedCase(db, {
      caseKey: "reverse-waterloo",
      entityType: "battle",
      payload: {
        wikidata_qid: "Q48314",
        date_iso: "1815-06-18",
        commanders: [
          { side: "France", rank: "Emperor" },
          { side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    await insertReviews(
      db,
      caseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );
    const published = await publish(db, caseId);
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${ownerId}', false);
      set role authenticated;
    `);

    const reversed = (await db.query(
      "select * from public.revert_editorial_event($1, $2, $3)",
      [published.event_id, ownerId, "Remove unsupported publication"],
    )).rows[0];
    const repeated = (await db.query(
      "select * from public.revert_editorial_event($1, $2, $3)",
      [published.event_id, ownerId, "Remove unsupported publication"],
    )).rows[0];
    await db.exec("reset role");

    assert.deepEqual(repeated, reversed);
    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.engagements) as engagements,
        (select count(*)::integer from public.engagement_sides) as sides,
        (select count(*)::integer from public.participations) as participations,
        (select count(*)::integer from public.claims) as claims,
        (select count(*)::integer from public.sources) as sources,
        (select count(*)::integer from public.editorial_events) as events,
        (select count(*)::integer from public.ranking_jobs) as jobs
    `)).rows, [{
      engagements: 0,
      sides: 0,
      participations: 0,
      claims: 0,
      sources: 0,
      events: 2,
      jobs: 2,
    }]);
    assert.deepEqual((await db.query(`
      select action, reverts_event_id from public.editorial_events order by id
    `)).rows, [
      { action: "approve_battle", reverts_event_id: null },
      { action: "revert_approve_battle", reverts_event_id: published.event_id },
    ]);
  } finally {
    await db.close();
  }
});

test("reversal rejects post-publication dependencies across the complete engagement graph", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    await db.exec(`
      insert into public.curator_memberships (user_id, role)
      values ('${ownerId}', 'owner');
    `);
    const caseId = await insertLeasedCase(db, {
      caseKey: "reverse-waterloo-dependent-graph",
      entityType: "battle",
      payload: {
        commanders: [
          { side: "France", rank: "Emperor" },
          { side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    await insertReviews(
      db,
      caseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );
    const published = await publish(db, caseId);
    await db.exec(`
      with inserted as (
        insert into public.result_interpretations (
          engagement_id, label, summary, publication_status
        )
        select id, 'Later interpretation', 'Added after AI publication', 'published'
        from public.engagements where slug = 'waterloo'
        returning id
      )
      insert into public.result_interpretation_claims (result_interpretation_id, claim_id)
      select inserted.id, claims.id
      from inserted cross join public.claims claims;

      insert into public.commander_claims (commander_id, claim_id)
      select commanders.id, claims.id
      from public.commanders commanders cross join public.claims claims
      where commanders.slug = 'napoleon';

      select set_config('request.jwt.claim.sub', '${ownerId}', false);
      set role authenticated;
    `);

    await assert.rejects(
      db.query(
        "select * from public.revert_editorial_event($1, $2, $3)",
        [published.event_id, ownerId, "Unsafe cascade must be rejected"],
      ),
      /canonical engagement state changed/i,
    );
    await db.exec("reset role");

    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.engagements where slug = 'waterloo') as engagements,
        (select count(*)::integer from public.result_interpretations) as interpretations,
        (select count(*)::integer from public.result_interpretation_claims) as interpretation_claims,
        (select count(*)::integer from public.commander_claims) as commander_claims,
        (select count(*)::integer from public.editorial_events where reverts_event_id is not null) as reversals
    `)).rows, [{
      engagements: 1,
      interpretations: 1,
      interpretation_claims: 1,
      commander_claims: 1,
      reversals: 0,
    }]);
  } finally {
    await db.close();
  }
});

test("reversal preserves external container associations added to a published claim", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    await db.exec(`
      insert into public.curator_memberships (user_id, role)
      values ('${ownerId}', 'owner');
    `);
    const caseId = await insertLeasedCase(db, {
      caseKey: "reverse-waterloo-external-claim-associations",
      entityType: "battle",
      payload: {
        commanders: [
          { side: "France", rank: "Emperor" },
          { side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    await insertReviews(
      db,
      caseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );
    const published = await publish(db, caseId);
    await db.exec(`
      insert into public.engagements (slug, title, publication_status)
      values ('external-engagement', 'External engagement', 'published');
      insert into public.engagement_sides (engagement_id, position, label, outcome)
      select id, 1, 'External side', 'unknown'
      from public.engagements where slug = 'external-engagement';
      insert into public.participations (engagement_side_id, commander_id, role)
      select side.id, commander.id, 'External role'
      from public.engagement_sides side
      join public.engagements engagement on engagement.id = side.engagement_id
      cross join public.commanders commander
      where engagement.slug = 'external-engagement'
        and commander.slug = 'napoleon';
      insert into public.result_interpretations (
        engagement_id, label, summary, publication_status
      )
      select id, 'External interpretation', 'External claim container', 'published'
      from public.engagements where slug = 'external-engagement';

      insert into public.engagement_claims (engagement_id, claim_id)
      select engagement.id, claim.id
      from public.engagements engagement cross join public.claims claim
      where engagement.slug = 'external-engagement';
      insert into public.participation_claims (participation_id, claim_id)
      select participation.id, claim.id
      from public.participations participation
      join public.engagement_sides side on side.id = participation.engagement_side_id
      join public.engagements engagement on engagement.id = side.engagement_id
      cross join public.claims claim
      where engagement.slug = 'external-engagement';
      insert into public.result_interpretation_claims (result_interpretation_id, claim_id)
      select interpretation.id, claim.id
      from public.result_interpretations interpretation
      join public.engagements engagement on engagement.id = interpretation.engagement_id
      cross join public.claims claim
      where engagement.slug = 'external-engagement';

      select set_config('request.jwt.claim.sub', '${ownerId}', false);
      set role authenticated;
    `);

    await assert.rejects(
      db.query(
        "select * from public.revert_editorial_event($1, $2, $3)",
        [published.event_id, ownerId, "External claim associations must survive"],
      ),
      /canonical engagement state changed/i,
    );
    await db.exec("reset role");

    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.claims) as claims,
        (select count(*)::integer from public.engagement_claims ec
          join public.engagements e on e.id = ec.engagement_id
          where e.slug = 'external-engagement') as engagement_links,
        (select count(*)::integer from public.participation_claims pc
          join public.participations p on p.id = pc.participation_id
          join public.engagement_sides s on s.id = p.engagement_side_id
          join public.engagements e on e.id = s.engagement_id
          where e.slug = 'external-engagement') as participation_links,
        (select count(*)::integer from public.result_interpretation_claims ric
          join public.result_interpretations ri on ri.id = ric.result_interpretation_id
          join public.engagements e on e.id = ri.engagement_id
          where e.slug = 'external-engagement') as interpretation_links,
        (select count(*)::integer from public.editorial_events
          where reverts_event_id is not null) as reversals
    `)).rows, [{
      claims: 1,
      engagement_links: 1,
      participation_links: 1,
      interpretation_links: 1,
      reversals: 0,
    }]);
  } finally {
    await db.close();
  }
});

test("engagement graph locking has a deterministic contract for absent and populated slugs", async () => {
  const db = await migratedDatabase();
  try {
    await db.query(
      "select curation_private.lock_engagement_graph($1, $2::text[])",
      ["unseen-engagement", []],
    );
    await db.exec(`
      insert into public.engagements (slug, title) values ('existing-engagement', 'Existing');
      insert into public.result_interpretations (engagement_id, label, summary)
      select id, 'Initial', 'Existing result graph' from public.engagements
      where slug = 'existing-engagement';
    `);
    await db.query(
      "select curation_private.lock_engagement_graph($1, $2::text[])",
      ["existing-engagement", []],
    );
    const { rows } = await db.query(
      `select hashtextextended('bellumetrics:engagement:' || $1, 0)
         = hashtextextended('bellumetrics:engagement:' || $1, 0) as deterministic`,
      ["existing-engagement"],
    );
    assert.equal(rows[0].deterministic, true);
  } finally {
    await db.close();
  }
});

test("evidence source locks deduplicate shared absent slugs in stable order", async () => {
  const db = await migratedDatabase();
  try {
    const { rows } = await db.query(
      "select curation_private.lock_evidence_sources($1::text[]) as locked_slugs",
      [["curation-z", "curation-a", "curation-z"]],
    );
    assert.deepEqual(rows, [{ locked_slugs: ["curation-a", "curation-z"] }]);
    const namespaces = (await db.query(`
      select
        hashtextextended('bellumetrics:source:' || 'shared', 0)
          <> hashtextextended('bellumetrics:engagement:' || 'shared', 0) as isolated
    `)).rows[0];
    assert.equal(namespaces.isolated, true);
  } finally {
    await db.close();
  }
});

test("publication rechecks lease expiry after waiting for the engagement slug lock", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    const caseId = await insertLeasedCase(db, {
      caseKey: "lease-expiry-during-engagement-lock",
      entityType: "battle",
      payload: {
        commanders: [
          { side: "France", rank: "Emperor" },
          { side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    await insertReviews(
      db,
      caseId,
      approvalDecision("proposer-v1"),
      approvalDecision("reviewer-v1"),
    );
    await db.exec(`
      create or replace function curation_private.lock_engagement_graph(
        engagement_slug text, evidence_source_slugs text[]
      )
      returns void language plpgsql set search_path = '' as $$
      begin
        perform pg_catalog.pg_sleep(0.5);
      end;
      $$;
    `);
    await db.query(
      `update public.curation_cases
       set lease_expires_at = clock_timestamp() + interval '300 milliseconds'
       where id = $1`,
      [caseId],
    );

    await assert.rejects(
      publish(db, caseId),
      /active lease owner/i,
    );
    assert.deepEqual((await db.query(`
      select
        (select count(*)::integer from public.engagements) as engagements,
        (select count(*)::integer from public.editorial_events) as events
    `)).rows, [{ engagements: 0, events: 0 }]);
  } finally {
    await db.close();
  }
});

test("merge preserves relationships and an owner reversal restores the captured state", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into public.commanders (slug, display_name, wikidata_qid, publication_status)
      values
        ('arthur-wellesley', 'Arthur Wellesley (import)', null, 'published'),
        ('duke-of-wellington', 'Arthur Wellesley', 'Q152245', 'published');
      insert into public.engagements (slug, title, publication_status)
      values ('assaye', 'Battle of Assaye', 'published');
      insert into public.engagement_sides (engagement_id, position, label, outcome)
      values (1, 1, 'East India Company', 'victory');
      insert into public.participations (engagement_side_id, commander_id, role)
      values (1, 1, 'Major-General');
      insert into public.sources (source_type, title, url, external_slug, publication_status)
      values ('academic', 'Wellington biography', 'https://example.test/bio', 'wellington-bio', 'published');
      insert into public.claims (claim_type, statement, publication_status)
      values ('identity', 'Arthur Wellesley commanded at Assaye.', 'published');
      insert into public.claim_sources (claim_id, source_id) values (1, 1);
      insert into public.commander_claims (commander_id, claim_id) values (1, 1);
      insert into public.curator_memberships (user_id, role) values ('${ownerId}', 'owner');
    `);
    const caseId = await insertLeasedCase(db, {
      caseKey: "merge-wellesley",
      entityType: "commander",
      payload: {},
    });
    await insertReviews(
      db,
      caseId,
      identityDecision("merge_commanders", "proposer-v1"),
      identityDecision("merge_commanders", "reviewer-v1"),
    );

    const published = await publish(db, caseId);
    assert.deepEqual((await db.query(`
      select c.slug, c.publication_status,
        count(p.id)::integer as participations,
        count(cc.claim_id)::integer as claims
      from public.commanders c
      left join public.participations p on p.commander_id = c.id
      left join public.commander_claims cc on cc.commander_id = c.id
      group by c.id, c.slug, c.publication_status
      order by c.id
    `)).rows, [
      { slug: "arthur-wellesley", publication_status: "retired", participations: 0, claims: 0 },
      { slug: "duke-of-wellington", publication_status: "published", participations: 1, claims: 1 },
    ]);
    assert.deepEqual((await db.query(`
      select source_ref, target_ref, link_state
      from public.commander_identity_links order by id
    `)).rows, [{
      source_ref: "war-atlas:arthur-wellesley",
      target_ref: "wikidata:Q152245",
      link_state: "linked",
    }]);
    assert.deepEqual((await db.query(`
      select c.statement, s.title
      from public.commander_claims cc
      join public.claims c on c.id = cc.claim_id
      join public.claim_sources cs on cs.claim_id = c.id
      join public.sources s on s.id = cs.source_id
      where cc.commander_id = 2
    `)).rows, [{
      statement: "Arthur Wellesley commanded at Assaye.",
      title: "Wellington biography",
    }]);

    await db.exec(`
      select set_config('request.jwt.claim.sub', '${nonOwnerId}', false);
      set role authenticated;
    `);
    await assert.rejects(
      db.query(
        "select * from public.revert_editorial_event($1, $2, $3)",
        [published.event_id, ownerId, "Undo mistaken merge"],
      ),
      /owner membership/i,
    );
    await db.exec(`
      reset role;
      select set_config('request.jwt.claim.sub', '${ownerId}', false);
      set role authenticated;
    `);
    const reversed = (await db.query(
      "select * from public.revert_editorial_event($1, $2, $3)",
      [published.event_id, ownerId, "Undo mistaken merge"],
    )).rows[0];
    const repeated = (await db.query(
      "select * from public.revert_editorial_event($1, $2, $3)",
      [published.event_id, ownerId, "Undo mistaken merge"],
    )).rows[0];
    await db.exec("reset role");

    assert.deepEqual(repeated, reversed);
    assert.notEqual(reversed.event_id, published.event_id);
    assert.deepEqual((await db.query(`
      select c.slug, c.publication_status,
        count(p.id)::integer as participations,
        count(cc.claim_id)::integer as claims
      from public.commanders c
      left join public.participations p on p.commander_id = c.id
      left join public.commander_claims cc on cc.commander_id = c.id
      group by c.id, c.slug, c.publication_status
      order by c.id
    `)).rows, [
      { slug: "arthur-wellesley", publication_status: "published", participations: 1, claims: 1 },
      { slug: "duke-of-wellington", publication_status: "published", participations: 0, claims: 0 },
    ]);
    assert.deepEqual((await db.query(`
      select action, reverts_event_id from public.editorial_events order by id
    `)).rows, [
      { action: "merge_commanders", reverts_event_id: null },
      { action: "revert_merge_commanders", reverts_event_id: published.event_id },
    ]);
    assert.deepEqual((await db.query(`
      select link_state from public.commander_identity_links order by id
    `)).rows, [{ link_state: "linked" }, { link_state: "separated" }]);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.ranking_jobs",
    )).rows[0].count, 2);
    await assert.rejects(
      db.exec("update public.commander_identity_links set link_state = 'linked' where id = 2"),
      /append-only/i,
    );
    await assert.rejects(
      db.exec("delete from public.commander_identity_links where id = 1"),
      /append-only/i,
    );
  } finally {
    await db.close();
  }
});

test("separation restores the linked identity snapshot and is itself reversible", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into public.commanders (slug, display_name, wikidata_qid, publication_status)
      values
        ('arthur-wellesley', 'Arthur Wellesley (import)', null, 'published'),
        ('duke-of-wellington', 'Arthur Wellesley', 'Q152245', 'published');
      insert into public.engagements (slug, title, publication_status)
      values ('assaye', 'Battle of Assaye', 'published');
      insert into public.engagement_sides (engagement_id, position, label, outcome)
      values (1, 1, 'East India Company', 'victory');
      insert into public.participations (engagement_side_id, commander_id, role)
      values (1, 1, 'Major-General');
      insert into public.curator_memberships (user_id, role) values ('${ownerId}', 'owner');
    `);
    const mergeCaseId = await insertLeasedCase(db, {
      caseKey: "merge-before-separation",
      entityType: "commander",
      payload: {},
    });
    await insertReviews(
      db,
      mergeCaseId,
      identityDecision("merge_commanders", "proposer-v1"),
      identityDecision("merge_commanders", "reviewer-v1"),
    );
    await publish(db, mergeCaseId);

    const separateCaseId = await insertLeasedCase(db, {
      caseKey: "separate-wellesley",
      entityType: "commander",
      payload: {},
    });
    await insertReviews(
      db,
      separateCaseId,
      identityDecision("separate_commanders", "proposer-v1"),
      identityDecision("separate_commanders", "reviewer-v1"),
    );

    const separated = await publish(db, separateCaseId);

    assert.deepEqual((await db.query(`
      select c.slug, c.publication_status, count(p.id)::integer as participations
      from public.commanders c
      left join public.participations p on p.commander_id = c.id
      group by c.id, c.slug, c.publication_status
      order by c.id
    `)).rows, [
      { slug: "arthur-wellesley", publication_status: "published", participations: 1 },
      { slug: "duke-of-wellington", publication_status: "published", participations: 0 },
    ]);
    assert.deepEqual((await db.query(
      "select link_state from public.commander_identity_links order by id",
    )).rows, [{ link_state: "linked" }, { link_state: "separated" }]);

    await db.exec(`
      select set_config('request.jwt.claim.sub', '${ownerId}', false);
      set role authenticated;
    `);
    await db.query(
      "select * from public.revert_editorial_event($1, $2, $3)",
      [separated.event_id, ownerId, "Restore the merge"],
    );
    await db.exec("reset role");

    assert.deepEqual((await db.query(`
      select c.slug, c.publication_status, count(p.id)::integer as participations
      from public.commanders c
      left join public.participations p on p.commander_id = c.id
      group by c.id, c.slug, c.publication_status
      order by c.id
    `)).rows, [
      { slug: "arthur-wellesley", publication_status: "retired", participations: 0 },
      { slug: "duke-of-wellington", publication_status: "published", participations: 1 },
    ]);
    assert.deepEqual((await db.query(
      "select link_state from public.commander_identity_links order by id",
    )).rows, [
      { link_state: "linked" },
      { link_state: "separated" },
      { link_state: "linked" },
    ]);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.editorial_events",
    )).rows[0].count, 3);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.ranking_jobs",
    )).rows[0].count, 3);

    const repeatSeparateCaseId = await insertLeasedCase(db, {
      caseKey: "separate-wellesley-again",
      entityType: "commander",
      payload: {},
    });
    await insertReviews(
      db,
      repeatSeparateCaseId,
      identityDecision("separate_commanders", "proposer-v1"),
      identityDecision("separate_commanders", "reviewer-v1"),
    );
    await publish(db, repeatSeparateCaseId);
    assert.deepEqual((await db.query(
      "select link_state from public.commander_identity_links order by id",
    )).rows, [
      { link_state: "linked" },
      { link_state: "separated" },
      { link_state: "linked" },
      { link_state: "separated" },
    ]);
  } finally {
    await db.close();
  }
});

test("publication and reversal functions expose only their intended roles", async () => {
  const db = await migratedDatabase();
  try {
    const publishSignature = "public.publish_curation_decision(bigint,text,bigint,bigint,text)";
    const revertSignature = "public.revert_editorial_event(bigint,uuid,text)";
    const ownerActionSignature = "public.owner_curation_action(bigint,text,jsonb,text)";
    const ownerPublishSignature = "public.publish_owner_curation_decision(bigint,text,jsonb,text)";
    for (const role of ["anon", "authenticated", "service_role"]) {
      const publishAllowed = (await db.query(
        "select has_function_privilege($1, $2, 'EXECUTE') as allowed",
        [role, publishSignature],
      )).rows[0].allowed;
      const revertAllowed = (await db.query(
        "select has_function_privilege($1, $2, 'EXECUTE') as allowed",
        [role, revertSignature],
      )).rows[0].allowed;
      assert.equal(publishAllowed, role === "service_role");
      assert.equal(revertAllowed, role === "authenticated");
      assert.equal((await db.query("select has_function_privilege($1, $2, 'EXECUTE') as allowed", [role, ownerActionSignature])).rows[0].allowed, role === "authenticated");
      assert.equal((await db.query("select has_function_privilege($1, $2, 'EXECUTE') as allowed", [role, ownerPublishSignature])).rows[0].allowed, false);
    }
  } finally {
    await db.close();
  }
});

test("an owner approval uses the same War Atlas commander bootstrap", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`insert into public.curator_memberships (user_id, role) values ('${ownerId}', 'owner');`);
    const caseId = await insertLeasedCase(db, {
      caseKey: "owner-publish-waterloo-with-imported-commanders",
      entityType: "battle",
      payload: {
        date_iso: "1815-06-18",
        commanders: [
          {
            slug: "napoleon_bonaparte",
            name: "Napoleon Bonaparte",
            side: "France",
            rank: "Emperor",
          },
          {
            slug: "arthur_wellesley",
            name: "Arthur Wellesley",
            side: "Coalition",
            rank: "Field Marshal",
          },
        ],
      },
    });
    await insertReviews(db, caseId, approvalDecision("proposer-v1"), approvalDecision("reviewer-v1"));
    await db.query(
      "update public.curation_cases set status = 'awaiting_human', lease_owner = null, lease_expires_at = null where id = $1",
      [caseId],
    );
    const mutation = warAtlasApprovalDecision("human-v1").canonicalMutation;

    await db.exec(`select set_config('request.jwt.claim.sub', '${ownerId}', false); set role authenticated;`);
    await db.query(
      "select * from public.owner_curation_action($1, 'approve_corrected', $2::jsonb, $3)",
      [caseId, JSON.stringify({ mutation }), "La fuente confirma los comandantes importados."],
    );
    await db.exec("reset role");

    assert.deepEqual((await db.query(`
      select slug, display_name, publication_status
      from public.commanders
      order by slug
    `)).rows, [
      {
        slug: "arthur-wellesley",
        display_name: "Arthur Wellesley",
        publication_status: "published",
      },
      {
        slug: "napoleon-bonaparte",
        display_name: "Napoleon Bonaparte",
        publication_status: "published",
      },
    ]);
    assert.deepEqual((await db.query(`
      select actor_type,
        jsonb_array_length(before_state->'commanders') as before_commanders,
        jsonb_array_length(after_state->'commanders') as after_commanders
      from public.editorial_events
      where case_id = $1
    `, [caseId])).rows, [{
      actor_type: "human",
      before_commanders: 0,
      after_commanders: 2,
    }]);
  } finally {
    await db.close();
  }
});

test("an owner publishes a corrected battle canonically, once, and can reverse it", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    await db.exec(`insert into public.curator_memberships (user_id, role) values ('${ownerId}', 'owner');`);
    const caseId = await insertLeasedCase(db, {
      caseKey: "owner-publish-waterloo",
      entityType: "battle",
      payload: {
        date_iso: "1815-06-18",
        commanders: [
          { side: "France", rank: "Emperor" },
          { side: "Coalition", rank: "Field Marshal" },
        ],
      },
    });
    await insertReviews(db, caseId, approvalDecision("proposer-v1"), approvalDecision("reviewer-v1"));
    await db.query("update public.curation_cases set status = 'awaiting_human', lease_owner = null, lease_expires_at = null where id = $1", [caseId]);
    await db.exec(`select set_config('request.jwt.claim.sub', '${ownerId}', false); set role authenticated;`);
    const mutation = approvalDecision("human-v1").canonicalMutation;
    const first = (await db.query(
      "select * from public.owner_curation_action($1, 'approve_corrected', $2::jsonb, $3)",
      [caseId, JSON.stringify({ mutation }), "La evidencia registrada corrige la normalización."],
    )).rows[0];
    const repeated = (await db.query(
      "select * from public.owner_curation_action($1, 'approve_corrected', $2::jsonb, $3)",
      [caseId, JSON.stringify({ mutation }), "La evidencia registrada corrige la normalización."],
    )).rows[0];
    await db.exec("reset role");

    assert.equal(first.status, "published");
    assert.equal(repeated.status, "published");
    assert.deepEqual((await db.query(`
      select e.action, e.actor_type, jsonb_array_length(e.before_state->'engagements') as before_rows,
        jsonb_array_length(e.after_state->'engagements') as after_rows, j.status as ranking_status
      from public.editorial_events e join public.ranking_jobs j on j.editorial_event_id = e.id
      where e.case_id = $1 and e.actor_type = 'human'
    `, [caseId])).rows, [{
      action: "approve_battle", actor_type: "human", before_rows: 0, after_rows: 1, ranking_status: "pending",
    }]);
    assert.deepEqual((await db.query("select count(*)::integer as events from public.editorial_events where case_id = $1", [caseId])).rows, [{ events: 1 }]);
    const eventId = (await db.query("select id from public.editorial_events where case_id = $1", [caseId])).rows[0].id;
    await db.exec(`select set_config('request.jwt.claim.sub', '${ownerId}', false); set role authenticated;`);
    await db.query("select * from public.owner_curation_action($1, 'revert', $2::jsonb, $3)", [caseId, JSON.stringify({ eventId }), "Revertir corrección humana"]);
    await db.exec("reset role");
    assert.deepEqual((await db.query("select count(*)::integer as engagements from public.engagements")).rows, [{ engagements: 0 }]);
  } finally {
    await db.close();
  }
});

test("owner publication rejects a malformed mutation and a reversal from another case", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`insert into public.curator_memberships (user_id, role) values ('${ownerId}', 'owner');`);
    const firstCase = await insertLeasedCase(db, { caseKey: "owner-invalid-one", entityType: "battle", payload: { commanders: [] } });
    const secondCase = await insertLeasedCase(db, { caseKey: "owner-invalid-two", entityType: "battle", payload: { commanders: [] } });
    await db.query("update public.curation_cases set status = 'awaiting_human', lease_owner = null, lease_expires_at = null where id in ($1, $2)", [firstCase, secondCase]);
    await db.exec(`select set_config('request.jwt.claim.sub', '${ownerId}', false); set role authenticated;`);
    await assert.rejects(
      db.query("select * from public.owner_curation_action($1, 'approve_corrected', $2::jsonb, $3)", [firstCase, JSON.stringify({ mutation: { action: "approve_battle" } }), "Mutación incompleta"]),
      /invalid/i,
    );
    await db.exec("reset role");
    await db.exec(`insert into public.editorial_events (case_id, actor_type, action, before_state, after_state, reason) values (${firstCase}, 'human', 'approve_battle', '{}'::jsonb, '{}'::jsonb, 'evento simulado')`);
    const eventId = (await db.query("select id from public.editorial_events where case_id = $1", [firstCase])).rows[0].id;
    await db.exec(`select set_config('request.jwt.claim.sub', '${ownerId}', false); set role authenticated;`);
    await assert.rejects(
      db.query("select * from public.owner_curation_action($1, 'revert', $2::jsonb, $3)", [secondCase, JSON.stringify({ eventId }), "Caso equivocado"]),
      /not reversible for this curation case/i,
    );
    await db.exec("reset role");
    assert.deepEqual((await db.query("select count(*)::integer as engagements from public.engagements")).rows, [{ engagements: 0 }]);
  } finally {
    await db.close();
  }
});

test("publication repositories call only their scoped RPCs", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify([{ event_id: 7, ranking_job_id: 11 }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const publication = createPublicationRepository({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey: "service-secret",
    fetchImpl,
  });
  const owner = createOwnerPublicationRepository({
    supabaseUrl: "https://supabase.test",
    publishableKey: "project-publishable-key",
    accessToken: "owner-token",
    fetchImpl,
  });

  assert.deepEqual(await publication.publish({
    caseId: 3,
    workerId: "worker-a",
    proposerReviewId: 41,
    reviewerReviewId: 42,
    model: "gpt-5",
  }), {
    event_id: 7,
    ranking_job_id: 11,
  });
  assert.deepEqual(await owner.revert({
    eventId: 7,
    curatorUserId: ownerId,
    reason: "Correction",
  }), { event_id: 7, ranking_job_id: 11 });
  assert.equal(new URL(calls[0].url).pathname, "/rest/v1/rpc/publish_curation_decision");
  assert.equal(calls[0].options.headers.authorization, "Bearer service-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    case_id: 3,
    worker_id: "worker-a",
    proposer_review_id: 41,
    reviewer_review_id: 42,
    configured_model: "gpt-5",
  });
  assert.equal(new URL(calls[1].url).pathname, "/rest/v1/rpc/revert_editorial_event");
  assert.equal(calls[1].options.headers.apikey, "project-publishable-key");
  assert.equal(calls[1].options.headers.authorization, "Bearer owner-token");
  assert.notEqual(calls[1].options.headers.apikey, "owner-token");
});

test("owner reversal repository rejects reusing the user token as the project key", () => {
  assert.throws(
    () => createOwnerPublicationRepository({
      supabaseUrl: "https://supabase.test",
      publishableKey: "same-token",
      accessToken: "same-token",
      fetchImpl: async () => new Response(),
    }),
    /publishableKey and accessToken must be distinct/i,
  );
});

test("the worker treats transactional publication as the terminal execute transition", async () => {
  const releases = [];
  const recorded = [];
  const published = [];
  const proposal = approvalDecision("proposer-v1");
  const review = approvalDecision("reviewer-v1");
  const repository = {
    async lease() {
      return {
        id: 17,
        case_key: "worker-publication",
        entity_type: "battle",
        source_revision: "war-atlas-2026-08-24",
        payload: { title: "Battle of Waterloo" },
      };
    },
    async readReviews() { return []; },
    async recordReview(input) { recorded.push(input); return recorded.length; },
    async heartbeat() { return true; },
    async release(input) { releases.push(input); return true; },
  };
  const worker = createCurationWorker({
    repository,
    publicationRepository: {
      async publish(input) {
        published.push(input);
        return { event_id: 7, ranking_job_id: 11 };
      },
    },
    runner: {
      async runProposer() { return proposal; },
      async runReviewer() { return review; },
    },
    workerId: "worker-a",
    model: "gpt-5",
  });

  const result = await worker.runOnce();

  assert.equal(result.kind, "execute");
  assert.equal(recorded.length, 2);
  assert.deepEqual(published, [{
    caseId: 17,
    workerId: "worker-a",
    proposerReviewId: 1,
    reviewerReviewId: 2,
    model: "gpt-5",
  }]);
  assert.deepEqual(releases, []);
});

test("the worker fails closed before canonical execution when publication is unavailable", async () => {
  const releases = [];
  let executed = false;
  const repository = {
    async lease() {
      return {
        id: 18,
        case_key: "worker-publication-required",
        entity_type: "battle",
        source_revision: "war-atlas-2026-08-24",
        payload: { title: "Battle of Waterloo" },
      };
    },
    async readReviews() { return []; },
    async recordReview(input) { return input.reviewRole === "proposer" ? 51 : 52; },
    async heartbeat() { return true; },
    async release(input) { releases.push(input); return true; },
  };
  const worker = createCurationWorker({
    repository,
    runner: {
      async runProposer() { return approvalDecision("proposer-v1"); },
      async runReviewer() { return approvalDecision("reviewer-v1"); },
    },
    workerId: "worker-a",
    model: "gpt-5",
    async executeDecision() { executed = true; },
  });

  await assert.rejects(worker.runOnce(), /publication repository.*required/i);

  assert.equal(executed, false);
  assert.deepEqual(releases.map(({ outcome }) => outcome), ["technical_failure"]);
  assert.equal(releases.some(({ outcome }) => outcome === "approved"), false);
});

test("stored canonical consensus publishes the exact review ids that were evaluated", async () => {
  const proposal = approvalDecision("proposer-v1");
  const review = approvalDecision("reviewer-v1");
  const published = [];
  const repository = {
    async lease() {
      return {
        id: 19,
        case_key: "worker-stored-publication",
        entity_type: "battle",
        source_revision: "war-atlas-2026-08-24",
        payload: { title: "Battle of Waterloo" },
      };
    },
    async readReviews() {
      return [
        { review_id: 101, review_role: "proposer", model: "gpt-5", prompt_version: "proposer-v1", decision: proposal },
        { review_id: 102, review_role: "reviewer", model: "gpt-5", prompt_version: "reviewer-v1", decision: review },
      ];
    },
    async recordReview() { throw new Error("stored reviews must not be rerun"); },
    async heartbeat() { return true; },
    async release() { throw new Error("publication is the terminal transition"); },
  };
  const worker = createCurationWorker({
    repository,
    publicationRepository: {
      async publish(input) { published.push(input); return { event_id: 1, ranking_job_id: 2 }; },
    },
    runner: {
      async runProposer() { throw new Error("stored proposer must not be rerun"); },
      async runReviewer() { throw new Error("stored reviewer must not be rerun"); },
    },
    workerId: "worker-a",
    model: "gpt-5",
  });

  await worker.runOnce();

  assert.deepEqual(published, [{
    caseId: 19,
    workerId: "worker-a",
    proposerReviewId: 101,
    reviewerReviewId: 102,
    model: "gpt-5",
  }]);
});

test("reviewed participants publish without rewriting the original empty payload and can be reverted", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    const payload = { commanders: [], source_slugs: [] };
    const id = await insertLeasedCase(db, {caseKey:"enriched-empty",entityType:"battle",payload});
    const p = approvalDecision("proposer-v1"), r = approvalDecision("reviewer-v1");
    const participants = p.canonicalMutation.commanderRefs.map((ref,i)=>({ref,side:i?"Coalition":"France"}));
    p.canonicalMutation.participants = participants;
    r.canonicalMutation.participants = participants;
    await insertReviews(db,id,p,r);
    const result = await publish(db,id);
    assert.ok(result.event_id);
    assert.deepEqual((await db.query("select payload from public.curation_cases where id=$1",[id])).rows[0].payload,payload);
    assert.equal((await db.query("select count(*)::int n from public.participations")).rows[0].n,2);
    await db.query("insert into public.curator_memberships(user_id,role) values ($1,'owner')",[ownerId]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ownerId]);
    await db.query("select public.revert_editorial_event($1,$2,$3)",[result.event_id,ownerId,"revert enriched battle"]);
    assert.equal((await db.query("select count(*)::int n from public.participations")).rows[0].n,0);
  } finally { await db.close(); }
});

test("participant enrichment rejects unknown identities, overwritten originals and mismatching reviews atomically", async () => {
  const db = await migratedDatabase();
  try {
    await seedBattleCommanders(db);
    for (const scenario of ["unknown","overwrite","disagreement"]) {
      const payload = {commanders:scenario==="overwrite"?[{name:"Original",side:"France"}]:[]};
      const id=await insertLeasedCase(db,{caseKey:scenario,entityType:"battle",payload});
      const p=approvalDecision("proposer-v1"),r=approvalDecision("reviewer-v1");
      if(scenario==="unknown") p.canonicalMutation.commanderRefs[0]={type:"commander",id:"wikidata:Q999999999"};
      p.canonicalMutation.participants=p.canonicalMutation.commanderRefs.map((ref,i)=>({ref,side:i?"Coalition":"France"}));
      r.canonicalMutation=structuredClone(p.canonicalMutation);
      if(scenario==="disagreement") r.canonicalMutation.participants[0].side="Other";
      await insertReviews(db,id,p,r);
      await assert.rejects(publish(db,id));
      assert.equal((await db.query("select count(*)::int n from public.editorial_events")).rows[0].n,0);
      assert.deepEqual((await db.query("select payload from public.curation_cases where id=$1",[id])).rows[0].payload,payload);
    }
  } finally { await db.close(); }
});

test("enrichment bootstraps verified imported identities, preserving audit and denying stale leases", async () => {
  const db=await migratedDatabase();
  try {
    const run=(await db.query(`insert into public.import_runs(source_dataset,source_version,source_url,license_name,attribution,status) values ('the-war-atlas','war-atlas-2026-08-24','https://example.test','test','test','staged') returning id`)).rows[0].id;
    for(const [slug,name] of [["napoleon_bonaparte","Napoleon Bonaparte"],["arthur_wellesley","Arthur Wellesley"]]) {
      await db.query("insert into public.import_records(import_run_id,entity_type,external_id,checksum,payload) values ($1,'commander',$2,$3,$4)",[run,slug,"0".repeat(64),JSON.stringify({slug,name})]);
    }
    const id=await insertLeasedCase(db,{caseKey:"enriched-imports",entityType:"battle",payload:{commanders:[]}});
    const p=warAtlasApprovalDecision("proposer-v1"),r=warAtlasApprovalDecision("reviewer-v1");
    p.canonicalMutation.participants=p.canonicalMutation.commanderRefs.map((ref,i)=>({ref,side:i?"Coalition":"France"}));
    r.canonicalMutation=structuredClone(p.canonicalMutation);
    await insertReviews(db,id,p,r);
    await assert.rejects(publish(db,id,"wrong-worker"));
    assert.equal((await db.query("select count(*)::int n from public.commanders")).rows[0].n,0);
    const result=await publish(db,id);
    assert.equal((await db.query("select count(*)::int n from public.commanders")).rows[0].n,2);
    await db.query("insert into public.curator_memberships(user_id,role) values ($1,'owner')",[ownerId]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ownerId]);
    await db.query("select public.revert_editorial_event($1,$2,$3)",[result.event_id,ownerId,"undo"]);
    assert.equal((await db.query("select count(*)::int n from public.commanders")).rows[0].n,0);
  }finally{await db.close();}
});
