import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkRecords,
  normalizeWarAtlasDataset,
} from "../lib/import/war-atlas.mjs";

const manifest = {
  name: "The War Atlas — Open Dataset",
  version: "2026-07-03",
  generated_at: "2026-07-03T02:24:58.862887+00:00",
  dataset_page: "https://thewaratlas.co/data",
  license: {
    name: "CC BY 4.0",
    attribution: "The War Atlas — thewaratlas.co",
    attribution_url: "https://thewaratlas.co",
  },
  files: {
    "battles.json": { rows: 2 },
  },
};

const battles = [
  {
    slug: "battle-one",
    title: "Battle One",
    war_slug: "example-war",
    campaign_slug: "example-campaign",
    year: 1800,
    date_iso: "1800-01-01",
    result: "",
    wikidata_qid: "Q100",
    forces: [
      { side: "France", strength_low: 1000, strength_high: 1200, confidence: "medium" },
      { side: "Coalition", strength_low: 900, strength_high: 1100, confidence: "low" },
    ],
    casualties: [],
    commanders: [
      { slug: "napoleon", name: "Napoléon Bonaparte", side: "France", rank: "General" },
      { slug: "opponent-one", name: "Opponent One", side: "Coalition", rank: "General" },
    ],
    source_slugs: ["source-a"],
  },
  {
    slug: "battle-two",
    title: "Battle Two",
    war_slug: "example-war",
    campaign_slug: "",
    year: 1801,
    date_iso: "1801-02-03",
    result: "",
    wikidata_qid: null,
    forces: [],
    casualties: [],
    commanders: [
      { slug: "napoleon", name: "Napoléon Bonaparte", side: "France", rank: "First Consul" },
      { slug: "opponent-two", name: "Opponent Two", side: "Coalition", rank: "Field Marshal" },
    ],
    source_slugs: ["source-b", "source-c"],
  },
];

test("normalizes battles and deduplicates embedded commanders", () => {
  const result = normalizeWarAtlasDataset({ manifest, battles });

  assert.equal(result.run.sourceDataset, "the-war-atlas");
  assert.equal(result.run.sourceVersion, "2026-07-03");
  assert.equal(result.run.licenseName, "CC BY 4.0");
  assert.equal(result.run.attribution, "The War Atlas — thewaratlas.co");
  assert.deepEqual(result.run.rowCounts, {
    manifest: { battle: 2 },
    actual: { battle: 2, commander: 3 },
  });
  assert.equal(result.records.filter((row) => row.entityType === "battle").length, 2);
  assert.equal(result.records.filter((row) => row.entityType === "commander").length, 3);
  assert.ok(result.records.every((row) => row.checksum.length === 64));

  const napoleon = result.records.find(
    (row) => row.entityType === "commander" && row.externalId === "napoleon",
  );
  assert.deepEqual(napoleon.payload, {
    appearances: [
      { battleSlug: "battle-one", rank: "General", side: "France" },
      { battleSlug: "battle-two", rank: "First Consul", side: "France" },
    ],
    name: "Napoléon Bonaparte",
    slug: "napoleon",
  });

  const battle = result.records.find(
    (row) => row.entityType === "battle" && row.externalId === "battle-one",
  );
  assert.equal(battle.wikidataQid, "Q100");
  assert.deepEqual(battle.payload.source_slugs, ["source-a"]);
});

test("chunks staging records into bounded batches", () => {
  assert.deepEqual(chunkRecords([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => chunkRecords([1], 0), /positive integer/i);
});

test("rejects a dataset without the required reusable license", () => {
  assert.throws(
    () => normalizeWarAtlasDataset({
      manifest: { ...manifest, license: { ...manifest.license, name: "All rights reserved" } },
      battles,
    }),
    /CC BY 4\.0/i,
  );
});

test("rejects noncanonical attribution text", () => {
  assert.throws(
    () => normalizeWarAtlasDataset({
      manifest: {
        ...manifest,
        license: { ...manifest.license, attribution: "The War Atlas" },
      },
      battles,
    }),
    /attribution must be The War Atlas — thewaratlas\.co/i,
  );
});

test("rejects a manifest battle count that differs from the fetched dataset", () => {
  assert.throws(
    () => normalizeWarAtlasDataset({
      manifest: {
        ...manifest,
        files: { "battles.json": { rows: 1 } },
      },
      battles,
    }),
    /manifest battle count 1 does not match 2 fetched battles/i,
  );
});

test("rejects conflicting duplicate battle slugs", () => {
  assert.throws(
    () => normalizeWarAtlasDataset({
      manifest,
      battles: [...battles, { ...battles[0], title: "Conflicting title" }],
    }),
    /duplicate battle slug.*battle-one/i,
  );
});

test("rejects embedded commanders without stable slugs", () => {
  const invalidBattle = {
    ...battles[0],
    commanders: [{ slug: "", name: "Unnamed", side: "France", rank: "" }],
  };

  assert.throws(
    () => normalizeWarAtlasDataset({ manifest, battles: [invalidBattle] }),
    /commander slug.*battle-one/i,
  );
});

test("rejects conflicting names for the same commander slug", () => {
  const conflictingBattle = {
    ...battles[1],
    commanders: [
      { slug: "napoleon", name: "Different Person", side: "France", rank: "General" },
    ],
  };

  assert.throws(
    () => normalizeWarAtlasDataset({ manifest, battles: [battles[0], conflictingBattle] }),
    /conflicting commander.*napoleon/i,
  );
});
