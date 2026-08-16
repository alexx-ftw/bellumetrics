import { createHash } from "node:crypto";

const REQUIRED_ATTRIBUTION = "The War Atlas — thewaratlas.co";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Invalid The War Atlas dataset: ${message}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function checksum(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedQid(value, context) {
  const qid = normalizedText(value);
  if (!qid) return null;
  invariant(/^Q[1-9][0-9]*$/.test(qid), `invalid Wikidata QID ${qid} in ${context}`);
  return qid;
}

function stagingRecord({ entityType, externalId, wikidataQid = null, payload }) {
  return {
    entityType,
    externalId,
    wikidataQid,
    checksum: checksum({ entityType, externalId, payload }),
    payload,
  };
}

export function normalizeWarAtlasDataset({ manifest, battles }) {
  invariant(manifest && typeof manifest === "object", "manifest must be an object");
  invariant(Array.isArray(battles), "battles must be an array");

  const sourceVersion = normalizedText(manifest.version);
  const sourceUrl = normalizedText(manifest.dataset_page);
  const licenseName = normalizedText(manifest.license?.name);
  const attribution = normalizedText(manifest.license?.attribution);
  const manifestBattleCount = manifest.files?.["battles.json"]?.rows;

  invariant(sourceVersion, "manifest version is required");
  invariant(sourceUrl, "manifest dataset_page is required");
  invariant(licenseName === "CC BY 4.0", "license must be CC BY 4.0");
  invariant(
    attribution === REQUIRED_ATTRIBUTION,
    `attribution must be ${REQUIRED_ATTRIBUTION}`,
  );
  invariant(
    Number.isSafeInteger(manifestBattleCount) && manifestBattleCount >= 0,
    "manifest battles.json row count must be a non-negative integer",
  );
  const battlesBySlug = new Map();
  const commandersBySlug = new Map();

  for (const battle of battles) {
    invariant(battle && typeof battle === "object", "every battle must be an object");
    const battleSlug = normalizedText(battle.slug);
    invariant(battleSlug, "battle slug is required");
    invariant(normalizedText(battle.title), `battle title is required for ${battleSlug}`);
    invariant(Array.isArray(battle.commanders), `commanders must be an array in ${battleSlug}`);

    const serializedBattle = stableJson(battle);
    if (battlesBySlug.has(battleSlug)) {
      invariant(
        battlesBySlug.get(battleSlug).serialized === serializedBattle,
        `duplicate battle slug ${battleSlug} has conflicting payloads`,
      );
      continue;
    }
    battlesBySlug.set(battleSlug, { payload: battle, serialized: serializedBattle });

    for (const commander of battle.commanders) {
      invariant(commander && typeof commander === "object", `commander object is required in ${battleSlug}`);
      const commanderSlug = normalizedText(commander.slug);
      const commanderName = normalizedText(commander.name);
      invariant(commanderSlug, `commander slug is required in ${battleSlug}`);
      invariant(commanderName, `commander name is required for ${commanderSlug}`);

      const existing = commandersBySlug.get(commanderSlug);
      if (existing) {
        invariant(
          existing.name === commanderName,
          `conflicting commander name for slug ${commanderSlug}`,
        );
      } else {
        commandersBySlug.set(commanderSlug, {
          slug: commanderSlug,
          name: commanderName,
          appearances: [],
        });
      }

      commandersBySlug.get(commanderSlug).appearances.push({
        battleSlug,
        rank: normalizedText(commander.rank),
        side: normalizedText(commander.side),
      });
    }
  }

  invariant(
    manifestBattleCount === battles.length,
    `manifest battle count ${manifestBattleCount} does not match ${battles.length} fetched battles`,
  );

  const battleRecords = [...battlesBySlug.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([externalId, { payload }]) => stagingRecord({
      entityType: "battle",
      externalId,
      wikidataQid: normalizedQid(payload.wikidata_qid, `battle ${externalId}`),
      payload,
    }));

  const commanderRecords = [...commandersBySlug.values()]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((payload) => {
      payload.appearances.sort((left, right) =>
        left.battleSlug.localeCompare(right.battleSlug)
        || left.side.localeCompare(right.side)
        || left.rank.localeCompare(right.rank));
      return stagingRecord({
        entityType: "commander",
        externalId: payload.slug,
        payload,
      });
    });

  return {
    run: {
      sourceDataset: "the-war-atlas",
      sourceVersion,
      sourceUrl,
      licenseName,
      attribution,
      rowCounts: {
        manifest: { battle: manifestBattleCount },
        actual: {
          battle: battleRecords.length,
          commander: commanderRecords.length,
        },
      },
    },
    records: [...battleRecords, ...commanderRecords],
  };
}

export function chunkRecords(records, size = 500) {
  invariant(Array.isArray(records), "records must be an array");
  invariant(Number.isInteger(size) && size > 0, "chunk size must be a positive integer");

  const chunks = [];
  for (let offset = 0; offset < records.length; offset += size) {
    chunks.push(records.slice(offset, offset + size));
  }
  return chunks;
}
