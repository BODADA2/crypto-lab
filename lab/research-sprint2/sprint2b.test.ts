/**
 * SPRINT 2B — tests des familles L (wait) et N (changepoint).
 * Données synthétiques uniquement : aucun accès réseau, aucune lecture de data/.
 */
import { describe, expect, it } from "vitest";
import type { TokenSnapshot } from "../types.ts";
import {
  cleanSeries,
  waitFeatures,
  waitRow,
  returnFrom,
  survivalFrom,
  ddMaxFrom,
  firstValidAtOrAfter,
  waitDeltaStats,
} from "./wait/wait.ts";
import { detectMeanShift, changePointRow } from "./changepoint/changepoint.ts";
import { permutationP2Groups, bootstrapMedianDiffCI } from "./s2b-stats.ts";

function snap(
  mint: string,
  fetchedAt: string,
  priceUsd: number,
  liquidityUsd: number,
): TokenSnapshot {
  return {
    mint,
    chain: "solana",
    symbol: "T",
    name: "Test",
    createdAt: fetchedAt,
    pairCreatedAt: Date.parse(fetchedAt),
    pairAddress: null,
    dexId: "pumpswap",
    url: null,
    priceUsd,
    liquidityUsd,
    fdvUsd: null,
    marketCapUsd: null,
    volume: undefined,
    priceChange: undefined,
    txns: undefined,
    holders: null,
    top10Pct: 100,
    mintAuthority: "UNKNOWN",
    freezeAuthority: "UNKNOWN",
    fetchedAt,
    source: "fixture",
  } as unknown as TokenSnapshot;
}

const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Série : t0 à T0 (prix 1, liq 30000), puis ticks réguliers. */
function series(prices: [number, number][]): TokenSnapshot[] {
  // [offsetMin, price]
  return prices.map(([offMin, p]) =>
    snap("MINT", iso(T0 + offMin * 60_000), p, 30_000),
  );
}

/* ---------------- cleanSeries / waitFeatures ---------------- */

describe("cleanSeries", () => {
  it("trouve t0 au premier snapshot liq>=20000 et prix>0", () => {
    const s = series([
      [-60, 0.5],
      [0, 1],
      [15, 1.2],
    ]);
    // premier tick : liq 30000 >= 20000 → t0 = index 0 ! (liq 30000 partout)
    const cs = cleanSeries(s)!;
    expect(cs.t0).toBe(0);
    expect(cs.t0price).toBe(0.5);
  });

  it("retourne null sans t0", () => {
    const s = [snap("M", iso(T0), 0, 0)];
    expect(cleanSeries(s)).toBeNull();
  });
});

describe("waitFeatures", () => {
  it("dirPrice = log(p_dernier_≤D / p_t0), entrée = premier tick ≥ D", () => {
    const s = series([
      [0, 1],
      [10, 1.1],
      [20, 1.21],
      [40, 0.9],
    ]);
    const cs = cleanSeries(s)!;
    const wf = waitFeatures("MINT", cs, 30 * 60_000);
    expect(wf.nTicksWindow).toBe(2);
    expect(wf.dirPrice).toBeCloseTo(Math.log(1.21 / 1), 10);
    expect(wf.entryMs).toBe(T0 + 40 * 60_000);
    expect(wf.entryPrice).toBe(0.9);
  });

  it("dirPrice null sans tick dans la fenêtre", () => {
    const s = series([
      [0, 1],
      [40, 0.9],
    ]);
    const cs = cleanSeries(s)!;
    const wf = waitFeatures("MINT", cs, 30 * 60_000);
    expect(wf.nTicksWindow).toBe(0);
    expect(wf.dirPrice).toBeNull();
    expect(wf.entryMs).toBe(T0 + 40 * 60_000);
  });

  it("entrée null si aucun tick ≥ D", () => {
    const s = series([[0, 1]]);
    const cs = cleanSeries(s)!;
    const wf = waitFeatures("MINT", cs, 30 * 60_000);
    expect(wf.entryMs).toBeNull();
  });
});

/* ---------------- returnFrom / survivalFrom / ddMaxFrom ---------------- */

describe("returnFrom", () => {
  it("rendement entrée→sortie exact", () => {
    const s = series([
      [0, 1],
      [30, 2],
      [90, 3],
    ]);
    const cs = cleanSeries(s)!;
    const r = returnFrom(cs, T0 + 30 * 60_000, 3_600_000)!;
    expect(r.ret).toBeCloseTo(0.5, 10); // 3/2 − 1
    expect(r.entryPrice).toBe(2);
  });

  it("null si horizon non couvert", () => {
    const s = series([
      [0, 1],
      [30, 2],
    ]);
    const cs = cleanSeries(s)!;
    expect(returnFrom(cs, T0 + 30 * 60_000, 3_600_000)).toBeNull();
  });
});

describe("survivalFrom", () => {
  it("événement au premier passage sous −50 %", () => {
    const s = series([
      [0, 1],
      [30, 1],
      [60, 0.4],
      [120, 0.3],
    ]);
    const cs = cleanSeries(s)!;
    const sv = survivalFrom(cs, T0 + 30 * 60_000)!;
    expect(sv.event).toBe(true);
    expect(sv.durationH).toBeCloseTo(0.5, 10);
  });

  it("censure si jamais sous −50 %", () => {
    const s = series([
      [0, 1],
      [30, 1],
      [60, 0.9],
      [120, 0.8],
      [180, 0.85],
    ]);
    const cs = cleanSeries(s)!;
    const sv = survivalFrom(cs, T0 + 30 * 60_000)!;
    expect(sv.event).toBe(false);
  });

  it("null si < 3 ticks post-entrée", () => {
    const s = series([
      [0, 1],
      [30, 1],
      [60, 0.9],
    ]);
    const cs = cleanSeries(s)!;
    expect(survivalFrom(cs, T0 + 30 * 60_000)).toBeNull();
  });
});

describe("ddMaxFrom", () => {
  it("drawdown max exact", () => {
    const s = series([
      [0, 1],
      [30, 1],
      [60, 0.7],
      [120, 0.9],
      [180, 0.95],
    ]);
    const cs = cleanSeries(s)!;
    expect(ddMaxFrom(cs, T0 + 30 * 60_000)).toBeCloseTo(-0.3, 10);
  });
});

describe("firstValidAtOrAfter", () => {
  it("saute les ticks aberrants", () => {
    // tick aberrant : prix 100x les voisins
    const s = series([
      [0, 1],
      [30, 1],
      [35, 500],
      [40, 1.05],
    ]);
    const cs = cleanSeries(s)!;
    // Le tick à +30min est valide et exactement à atMs → on interroge après.
    const f = firstValidAtOrAfter(cs, T0 + 31 * 60_000)!;
    expect(f.price).toBe(1.05);
  });
});

/* ---------------- waitRow : coût du délai ---------------- */

describe("waitRow", () => {
  it("cost1h = ret(t0→1h) − ret(entrée→entrée+1h)", () => {
    // t0 prix 1 ; à +30min prix 2 (entrée) ; à +60min prix 3 ; à +90min prix 4
    const s = series([
      [0, 1],
      [30, 2],
      [60, 3],
      [90, 4],
    ]);
    const row = waitRow("MINT", s, 30 * 60_000)!;
    // ret(t0→t0+1h) : entrée 1, sortie premier tick ≥ +60min = 3 → 2.0
    // ret(entrée→entrée+1h) : entrée 2, sortie premier tick ≥ +90min = 4 → 1.0
    expect(row.cost1h).toBeCloseTo(1.0, 10);
    expect(row.dirPrice).toBeCloseTo(Math.log(2 / 1), 10);
    expect(row.y1hEntry).toBeCloseTo(1.0, 10);
  });

  it("null si pas de tick dans la fenêtre d'attente", () => {
    const s = series([
      [0, 1],
      [90, 4],
    ]);
    expect(waitRow("MINT", s, 30 * 60_000)).toBeNull();
  });
});

/* ---------------- waitDeltaStats ---------------- */

describe("waitDeltaStats", () => {
  it("n<30 → spreads null (non conclusif)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      mint: `m${i}`,
      dexId: "pumpswap",
      t0day: "2026-09-27",
      dirPrice: i * 0.01,
      dLiq: null,
      entryMs: T0,
      y1hEntry: 0.01 * i,
      y6hEntry: null,
      survEvent: null,
      ddMaxEntry: null,
      cost1h: 0.001 * i,
      cost6h: null,
    }));
    const st = waitDeltaStats(rows, 900_000);
    expect(st.spreadY1.spread).toBeNull();
    expect(st.spreadY1.pPerm).toBeNull();
  });
});

/* ---------------- detectMeanShift ---------------- */

describe("detectMeanShift", () => {
  it("détecte une rupture franche", () => {
    const x = [0, 0.01, -0.01, 0.02, 0.5, 0.52, 0.49, 0.51];
    const r = detectMeanShift(x, 2, 0.35);
    expect(r.event).toBe(true);
    expect(r.kStar).toBe(4);
    expect(r.magnitude).toBeCloseTo(0.5, 1);
  });

  it("pas d'événement sur série plate", () => {
    const x = [0, 0.01, -0.01, 0.02, -0.02, 0.01];
    const r = detectMeanShift(x, 2, 0.35);
    expect(r.event).toBe(false);
  });

  it("seuil : juste sous le seuil → pas d'événement", () => {
    const x = [0, 0, 0, 0.34, 0.34, 0.34];
    expect(detectMeanShift(x, 2, 0.35).event).toBe(false);
    expect(detectMeanShift(x, 2, 0.3).event).toBe(true);
  });

  it("non testable si m < 2*minSeg", () => {
    const r = detectMeanShift([0, 0.5, 0.6], 2, 0.35);
    expect(r.event).toBe(false);
    expect(r.kStar).toBeNull();
  });
});

describe("changePointRow", () => {
  it("null si < 5 ticks dans la fenêtre", () => {
    const s = series([
      [0, 1],
      [30, 1.1],
      [60, 1.2],
    ]);
    expect(changePointRow("M", s, 2 * 3_600_000, 0.35)).toBeNull();
  });

  it("détecte la rupture et mesure les labels depuis D", () => {
    const prices: [number, number][] = [[0, 1]];
    for (let k = 1; k <= 6; k++) prices.push([k * 15, 1 + k * 0.01]);
    for (let k = 7; k <= 12; k++) prices.push([k * 15, 2 + k * 0.01]);
    prices.push([8 * 60, 2.5]); // tick pour Y@6h depuis D=2h
    const s = series(prices);
    const row = changePointRow("M", s, 2 * 3_600_000, 0.35)!;
    expect(row.event).toBe(true);
    expect(row.magnitude).toBeGreaterThan(0.35);
    expect(row.m).toBe(8); // ticks à 15..120 min (≤ D = t0+2h)
  });
});

/* ---------------- s2b-stats ---------------- */

describe("permutationP2Groups", () => {
  it("p petite pour des groupes très séparés", () => {
    const a = Array.from({ length: 40 }, (_, i) => 10 + i * 0.01);
    const b = Array.from({ length: 40 }, (_, i) => i * 0.01);
    const { p, statObs } = permutationP2Groups(a, b, (x, y) => {
      const m = (z: number[]) => z.reduce((p2, q) => p2 + q, 0) / z.length;
      return m(x) - m(y);
    });
    expect(statObs).toBeCloseTo(10, 0);
    expect(p!).toBeLessThan(0.01);
  });

  it("p grande pour des groupes identiques", () => {
    const a = Array.from({ length: 40 }, (_, i) => i * 0.01);
    const b = Array.from({ length: 40 }, (_, i) => i * 0.01 + 0.001);
    const { p } = permutationP2Groups(a, b, (x, y) => {
      const m = (z: number[]) => z.reduce((p2, q) => p2 + q, 0) / z.length;
      return m(x) - m(y);
    });
    expect(p!).toBeGreaterThan(0.1);
  });
});

describe("bootstrapMedianDiffCI", () => {
  it("IC exclut 0 pour des groupes séparés", () => {
    const a = Array.from({ length: 50 }, () => 5);
    const b = Array.from({ length: 50 }, () => 1);
    const ci = bootstrapMedianDiffCI(a, b)!;
    expect(ci[0]).toBeGreaterThan(0);
  });

  it("null si n < 10", () => {
    expect(bootstrapMedianDiffCI([1, 2], [3, 4])).toBeNull();
  });
});
