export const ELO_V1 = Object.freeze({
  version: "elo-v1",
  initialRating: 1500,
  kFactor: 32,
  scores: Object.freeze({
    victory: 1,
    draw: 0.5,
    defeat: 0,
  }),
});

const ALGORITHMS = new Map([[ELO_V1.version, ELO_V1]]);

export function resolveRankingAlgorithm(algorithm) {
  const version = typeof algorithm === "string" ? algorithm : algorithm?.version;
  const resolved = ALGORITHMS.get(version);
  if (!resolved) {
    throw new TypeError(`unsupported ranking algorithm: ${String(version)}`);
  }
  return resolved;
}
