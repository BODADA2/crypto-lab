/**
 * SPRINT 2A — tests des familles K (divergence) et O (anomaly).
 * Données synthétiques uniquement : aucun accès réseau, aucune lecture de data/.
 */
import { describe, expect, it } from "vitest";
import type { TokenSnapshot } from "../../types.ts";
import { mismatchOf, labelsFrom } from "./features.ts";
import { robustZ, computeAnomaly } from "./anomaly.ts";
import type { DivergenceRow } from "./features.ts";

function snap(
  fetchedAt: string,
  priceUsd: number,
  liquidityUsd: number,
  extra: Record<string, unknown> = {},
): TokenSnapshot {
  return {
    mint: "TEST",
    chain: "solana",
    symbol: "T",
    name: "Test",
    createdAt: "2026-09-26T00:00:00.000Z",
    pairCreatedAt: null,
    pairAddress: null,
    dexId: "pumpswap",
    url: null,
    priceUsd,
    liquidityUsd,
    fdvUsd: null,
    marketCapUsd: liquidityUsd * 8,
    volume: { m5: 100, h1: 1000, h6: 1000, h24: 1000 },
    volume5m: 100,
    volume1h: 1000,
    volume24h: 1000,
    priceChange: { m5: 0, h1: 5, h6: 5, h24: 5 },
    txns: {
      m5: { buys: 10, sells: 8 },
      h1: { buys: 100, sells: 80 },
      h6: { buys: 100, sells: 80 },
      h24: { buys: 100, sells: 80 },
    },
    holders: null,
    top10Pct: 100,
    mintAuthority: "UNKNOWN",
    freezeAuthority: "UNKNOWN",
    boostsActive: 0,
    pairCount: 1,
    source: "dexscreener",
    fetchedAt,
    ...extra,
  } as unknown as TokenSnapshot;
}

/* ---------------- mismatchOf ---------------- */

describe("mismatchOf", () => {
  it("cohérent (+prix,+liq) → -1", () => {
    const a = snap("2026-09-26T00:00:00Z", 1, 100);
    const b = snap("2026-09-26T00:15:00Z", 1.5, 150);
    expect(mismatchOf(a, b)).toBe(-1);
  });
  it("incohérent (+prix,−liq) → +1", () => {
    const a = snap("2026-09-26T00:00:00Z", 1, 100);
    const b = snap("2026-09-26T00:15:00Z", 1.5, 50);
    expect(mismatchOf(a, b)).toBe(1);
  });
  it("prix inchangé → null", () => {
    const a = snap("2026-09-26T00:00:00Z", 1, 100);
    const b = snap("2026-09-26T00:15:00Z", 1, 50);
    expect(mismatchOf(a, b)).toBeNull();
  });
  it("prix nul → null", () => {
    const a = snap("2026-09-26T00:00:00Z", 0, 100);
    const b = snap("2026-09-26T00:15:00Z", 1, 50);
    expect(mismatchOf(a, b)).toBeNull();
  });
});

/* ---------------- labelsFrom (anti-chevauchement) ---------------- */

describe("labelsFrom", () => {
  const s = [
    snap("2026-09-26T00:00:00Z", 1, 30000), // t0
    snap("2026-09-26T00:15:00Z", 2, 40000), // tick d'observation K2 : exclu des labels
    snap("2026-09-26T01:20:00Z", 4, 50000), // >1h après obs → y1h = 4/2-1 = 1
    snap("2026-09-26T06:30:00Z", 1, 30000), // >6h → y6h = 1/2-1 = -0.5
  ];
  it("ignore les ticks ≤ fromMs (pas de chevauchement feature/label)", () => {
    const l = labelsFrom(s, Date.parse("2026-09-26T00:15:00Z"), 2);
    expect(l.y1h).toBeCloseTo(1, 10);
    expect(l.y6h).toBeCloseTo(-0.5, 10);
  });
  it("le prix d'observation n'entre pas dans le drawdown", () => {
    const l = labelsFrom(s, Date.parse("2026-09-26T00:15:00Z"), 2);
    // ticks post-obs : 4→+1, 1→−0.5 ; ≥3 ticks requis → sinon null ; ici 2 ticks → null
    expect(l.ddMax24h).toBeNull();
  });
  it("dd calculé sur ≥3 ticks post-observation", () => {
    const s2 = [
      ...s,
      snap("2026-09-26T02:00:00Z", 3, 50000),
      snap("2026-09-26T03:00:00Z", 0.5, 20000),
    ];
    const l = labelsFrom(s2, Date.parse("2026-09-26T00:15:00Z"), 2);
    expect(l.ddMax24h).toBeCloseTo(0.5 / 2 - 1, 10);
    expect(l.dd50_24h).toBe(true);
  });
});

/* ---------------- robustZ ---------------- */

describe("robustZ", () => {
  it("vaut 0 à la médiane", () => {
    expect(robustZ(5, [1, 3, 5, 7, 9])).toBeCloseTo(0, 10);
  });
  it("null si MAD = 0", () => {
    expect(robustZ(5, [5, 5, 5])).toBeNull();
  });
  it("symétrique et monotone", () => {
    const z1 = robustZ(9, [1, 3, 5, 7, 9])!;
    const z2 = robustZ(1, [1, 3, 5, 7, 9])!;
    expect(z1).toBeCloseTo(-z2, 10);
    expect(z1).toBeGreaterThan(0);
  });
});

/* ---------------- computeAnomaly ---------------- */

function divRow(mint: string, day: string, logLiq: number, logTurn: number | null, logVelo: number): DivergenceRow {
  return {
    mint,
    t0ms: Date.parse(`${day}T12:00:00Z`),
    t0day: day,
    dexId: "pumpswap",
    liqT0: Math.exp(logLiq),
    mcapT0: null,
    mismatchPre: null,
    mismatchPost: null,
    featMs: 0,
    featPrice: 1,
    lagMinPost: null,
    logMcapLiq: null,
    frictionH1: null,
    logVolPerTrade: null,
    logLiqT0: logLiq,
    logTurnoverH1: logTurn,
    logVelo,
  };
}

describe("computeAnomaly", () => {
  it("cohorte < 10 → régime indéterminé (null)", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      divRow(`m${i}`, "2026-09-26", 10 + i * 0.1, 0.5, 3),
    );
    const out = computeAnomaly(rows);
    expect(out.every((a) => a.anomaly == null)).toBe(true);
  });
  it("leave-one-out : l'outlier est détecté, pas le régime", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      divRow(`m${i}`, "2026-09-26", 10 + i * 0.01, 0.5 + (i % 3) * 0.01, 3 + (i % 2) * 0.01),
    );
    rows.push(divRow("outlier", "2026-09-26", 16, 0.5, 3)); // liq 6 log-points au-dessus
    const out = computeAnomaly(rows);
    const o = out.find((a) => a.mint === "outlier")!;
    const normal = out.find((a) => a.mint === "m0")!;
    expect(o.anomaly).not.toBeNull();
    expect(normal.anomaly).not.toBeNull();
    expect(o.anomaly!).toBeGreaterThan(normal.anomaly! * 3);
    expect(Math.abs(o.zLiq!)).toBeGreaterThan(10); // l'outlier explose le z
    expect(Math.abs(normal.zLiq!)).toBeLessThan(3); // le normal reste modeste
  });
  it("anomaly = moyenne des |z| disponibles", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      divRow(`m${i}`, "2026-09-26", 10, i === 0 ? null : 0.5, 3),
    );
    const out = computeAnomaly(rows);
    const r0 = out.find((a) => a.mint === "m0")!;
    expect(r0.zTurn).toBeNull();
    expect(r0.anomaly).toBeCloseTo(
      (Math.abs(r0.zLiq!) + Math.abs(r0.zVelo!)) / 2,
      10,
    );
  });
});
