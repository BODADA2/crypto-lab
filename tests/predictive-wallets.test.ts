/**
 * Domaine 1/5 — wallets/early buyers : tests du pipeline de découverte.
 * Hermétiques (fixtures inline) + un contrôle d'intégration en lecture seule
 * sur un vrai fichier data/earlybuyers (vérifie top5_share/gini recomputés).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TokenSnapshot } from "../lab/types.ts";
import {
  buildOverlapMap,
  computeFeatures,
  giniOf,
  readEarlyBuyersFile,
  topNAmountShare,
} from "../lab/predictive/wallets/features.ts";
import {
  computeOutcome,
  snapshotAtHorizon,
} from "../lab/predictive/wallets/outcomes.ts";
import {
  cohortStability,
  decileTopBottom,
  groupStats,
  safeSpearman,
  spearmanByHorizon,
  temporalStability,
  xValue,
  xyPairs,
} from "../lab/predictive/wallets/analysis.ts";
import { aberrantMask, findT0 } from "../lab/predictive/universe.ts";
import type {
  DiscoveryRow,
  EarlyBuyersFile,
  HorizonLabel,
} from "../lab/predictive/wallets/types.ts";

// ---------- fixtures ----------

function snap(priceUsd: number, liquidityUsd: number, fetchedAt: string): TokenSnapshot {
  return {
    mint: "m",
    chain: "solana",
    symbol: "T",
    name: "T",
    createdAt: fetchedAt,
    pairCreatedAt: null,
    pairAddress: null,
    dexId: "pumpswap",
    url: "",
    priceUsd,
    liquidityUsd,
    fdvUsd: null,
    marketCapUsd: null,
    volume: {},
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    priceChange: {},
    txns: {},
    holders: null,
    top10Pct: 100,
    mintAuthority: "UNKNOWN",
    freezeAuthority: "UNKNOWN",
    boostsActive: 0,
    pairCount: 1,
    source: "dexscreener",
    fetchedAt,
  } as unknown as TokenSnapshot;
}

/** Série de 5 snapshots espacés de 30 min, t0 au 1er (liq 30k). */
function series30m(prices: number[], liqs?: number[]): TokenSnapshot[] {
  const base = Date.parse("2026-09-28T00:00:00.000Z");
  return prices.map((p, i) =>
    snap(p, liqs?.[i] ?? 30_000, new Date(base + i * 30 * 60_000).toISOString()),
  );
}

function buyerFile(buyers: { wallet: string; rank: number; blockTime: number | null; amountRaw: string }[]): EarlyBuyersFile {
  return {
    mint: "mintX",
    buyers: buyers.map((b) => ({
      wallet: b.wallet,
      blockTime: b.blockTime,
      slot: null,
      rank: b.rank,
      amountRaw: BigInt(b.amountRaw),
    })),
    metrics: null,
    sells: null,
    truncated: false,
  };
}

function row(
  mint: string,
  features: Partial<DiscoveryRow["features"]>,
  y: Partial<Record<HorizonLabel, number | null>>,
  survival: Partial<Record<HorizonLabel, boolean | null>>,
  t0Time = "2026-09-28T00:00:00.000Z",
  universe: DiscoveryRow["universe"] = "discovery",
): DiscoveryRow {
  return {
    mint,
    universe,
    features: {
      mint,
      buyerCount: 10,
      top5Share: null,
      gini: null,
      sameSlotMax: null,
      arrivalSpanSec: null,
      medianInterArrivalSec: null,
      top1AmountShare: null,
      overlapFrac: null,
      sellersOver50: null,
      medianSoldFrac: null,
      devHistory: null,
      truncated: false,
      ...features,
    },
    outcome: {
      mint,
      universe,
      t0Index: 0,
      t0Time,
      nTicks: 5,
      aberrantTicks: 0,
      y: { "1h": null, "6h": null, "24h": null, ...y },
      survival: { "1h": null, "6h": null, "24h": null, ...survival },
    },
  };
}

// ---------- features ----------

describe("giniOf", () => {
  it("égalité parfaite => 0", () => {
    expect(giniOf([10n, 10n, 10n, 10n])).toBeCloseTo(0, 10);
  });
  it("un seul preneur => (n-1)/n", () => {
    expect(giniOf([100n, 0n, 0n, 0n])).toBeCloseTo(0.75, 10);
  });
  it("null si moins de 2 montants", () => {
    expect(giniOf([5n])).toBeNull();
    expect(giniOf([])).toBeNull();
  });
});

describe("topNAmountShare", () => {
  it("top1 sur montants connus", () => {
    expect(topNAmountShare([50n, 30n, 20n], 1)).toBeCloseTo(0.5, 10);
    expect(topNAmountShare([50n, 30n, 20n], 2)).toBeCloseTo(0.8, 10);
  });
  it("null si total nul", () => {
    expect(topNAmountShare([0n, 0n], 1)).toBeNull();
  });
});

describe("readEarlyBuyersFile", () => {
  it("null si metrics absentes / buyers < 2 (backfill incomplet)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-"));
    const p1 = path.join(dir, "incomplet.json");
    fs.writeFileSync(p1, JSON.stringify({ mint: "abc", buyers: [{ wallet: "w" }] }));
    expect(readEarlyBuyersFile(p1)).toBeNull();
    const p2 = path.join(dir, "nonsense.json");
    fs.writeFileSync(p2, "pas du json");
    expect(readEarlyBuyersFile(p2)).toBeNull();
    expect(readEarlyBuyersFile(path.join(dir, "absent.json"))).toBeNull();
  });
  it("lit un fichier complet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-"));
    const p = path.join(dir, "ok.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        mint: "abc",
        buyers: [
          { wallet: "w1", blockTime: 100, slot: 1, rank: 0, amountRaw: "60" },
          { wallet: "w2", blockTime: 105, slot: 2, rank: 1, amountRaw: "40" },
        ],
        metrics: { buyerCount: 2, top5_share: 1, gini: 0.1, same_slot_max: 0, totalRaw: "100", truncated: false },
        sells: { windowSec: 300, walletsChecked: 2, walletsCovered: 1, sellersOver50: 0, details: [{ wallet: "w1", soldFrac: 0.2, covered: true }] },
      }),
    );
    const f = readEarlyBuyersFile(p);
    expect(f?.mint).toBe("abc");
    expect(f?.buyers).toHaveLength(2);
    expect(f?.buyers[0]!.amountRaw).toBe(60n);
    expect(f?.sells?.details[0]!.soldFrac).toBe(0.2);
  });
});

describe("computeFeatures", () => {
  it("vitesse d'arrivée et concentration", () => {
    const f = buyerFile([
      { wallet: "w0", rank: 0, blockTime: 1000, amountRaw: "500" },
      { wallet: "w1", rank: 1, blockTime: 1002, amountRaw: "300" },
      { wallet: "w2", rank: 2, blockTime: 1006, amountRaw: "200" },
    ]);
    const feat = computeFeatures(f, null);
    expect(feat.buyerCount).toBe(3);
    expect(feat.arrivalSpanSec).toBe(6);
    expect(feat.medianInterArrivalSec).toBe(4); // gaps 2,4 -> médiane sup
    expect(feat.top1AmountShare).toBeCloseTo(0.5, 10);
    expect(feat.top5Share).toBeNull(); // pas de metrics => garde-fou
    expect(feat.overlapFrac).toBeNull(); // pas de map
    expect(feat.devHistory).toBeNull(); // jamais disponible pour l'instant
  });
  it("overlap inter-tokens", () => {
    const f1 = buyerFile([
      { wallet: "wA", rank: 0, blockTime: 1, amountRaw: "10" },
      { wallet: "wB", rank: 1, blockTime: 2, amountRaw: "10" },
    ]);
    const f2 = buyerFile([
      { wallet: "wA", rank: 0, blockTime: 1, amountRaw: "10" },
      { wallet: "wC", rank: 1, blockTime: 2, amountRaw: "10" },
    ]);
    const map = buildOverlapMap([f1, f2]);
    expect(map.get("wA")).toBe(2);
    expect(map.get("wB")).toBe(1);
    const feat = computeFeatures(f1, map);
    expect(feat.overlapFrac).toBeCloseTo(0.5, 10); // wA sur 2 tokens, wB sur 1
  });
  it("rétention sells : médian des couverts uniquement", () => {
    const f = buyerFile([
      { wallet: "w0", rank: 0, blockTime: 1, amountRaw: "10" },
      { wallet: "w1", rank: 1, blockTime: 2, amountRaw: "10" },
    ]);
    f.sells = {
      windowSec: 300, walletsChecked: 2, walletsCovered: 1, sellersOver50: 1,
      details: [
        { wallet: "w0", soldFrac: 0.8, covered: true },
        { wallet: "w1", soldFrac: 0.1, covered: false },
      ],
    };
    const feat = computeFeatures(f, null);
    expect(feat.sellersOver50).toBe(1);
    expect(feat.medianSoldFrac).toBeCloseTo(0.8, 10);
  });
});

describe("intégration données réelles (lecture seule)", () => {
  it("top5_share et gini recomputés matchent les metrics du fichier", () => {
    const p = new URL(
      "../data/earlybuyers/2nkmqh65eHHj61P2FpvpAoHsMBvxAmSvM9LaRrgopump.json",
      import.meta.url,
    );
    const f = readEarlyBuyersFile(p.pathname);
    expect(f).not.toBeNull();
    const amounts = f!.buyers.map((b) => b.amountRaw);
    const m = f!.metrics!;
    expect(m.top5_share).not.toBeNull();
    expect(m.gini).not.toBeNull();
    expect(topNAmountShare(amounts, 5)).toBeCloseTo(m.top5_share as number, 10);
    expect(giniOf(amounts)).toBeCloseTo(m.gini as number, 10);
  });
});

// ---------- outcomes ----------

describe("computeOutcome", () => {
  it("t0 = premier snapshot liq>=20000, Y 1h depuis prix nettoyé", () => {
    const s = series30m([1, 1.5, 2, 2.5, 3]); // t0 idx 0, 1h -> idx 2
    const o = computeOutcome("m", s);
    expect(o).not.toBeNull();
    expect(o!.t0Index).toBe(0);
    expect(o!.y["1h"]).toBeCloseTo(1, 10); // 2/1 - 1
    expect(o!.y["6h"]).toBeNull(); // série trop courte
    expect(o!.y["24h"]).toBeNull();
    expect(o!.survival["1h"]).toBe(true);
    expect(o!.survival["24h"]).toBeNull();
  });
  it("tick aberrant (100x vs voisins) exclu du Y", () => {
    const s = series30m([1, 1, 1, 100, 1, 1, 1]); // idx 3 aberrant
    const mask = aberrantMask([...s].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt)));
    expect(mask[3]).toBe(true);
    const o = computeOutcome("m", s);
    // 1h -> premier snapshot >= t0+1h non aberrant : idx 4 (prix 1)
    expect(o!.y["1h"]).toBeCloseTo(0, 10);
  });
  it("null si aucun t0 (liquidité insuffisante)", () => {
    const s = series30m([1, 2, 3], [1000, 1000, 1000]);
    expect(computeOutcome("m", s)).toBeNull();
    expect(findT0(s)).toBe(-1);
  });
  it("survie=false si liquidité sous le seuil à H", () => {
    const s = series30m([1, 1, 1, 1, 1], [30_000, 30_000, 5_000, 30_000, 30_000]);
    const o = computeOutcome("m", s);
    expect(o!.survival["1h"]).toBe(false);
  });
  it("snapshotAtHorizon null si horizon non couvert", () => {
    const s = series30m([1, 2]);
    const sorted = [...s].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const mask = aberrantMask(sorted);
    expect(snapshotAtHorizon(sorted, 0, 24 * 3_600_000, mask)).toBeNull();
  });
});

// ---------- analysis ----------

describe("safeSpearman (garde anti-dégénérescence)", () => {
  it("vecteur X ou Y constant => null, jamais un rho fallacieux", () => {
    expect(safeSpearman([1, 2, 3], [0.5, 0.5, 0.5])).toBeNull();
    expect(safeSpearman([2, 2, 2], [0.1, 0.2, 0.3])).toBeNull();
    expect(safeSpearman([1, 2], [1, 2])).toBeNull(); // n<3
    expect(safeSpearman([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });
});

describe("spearmanByHorizon", () => {
  it("monotonie parfaite => rho=1 ; Y constant => null", () => {
    const rows = [1, 2, 3, 4, 5].map((i) =>
      row(`m${i}`, { buyerCount: i }, { "1h": i * 0.1 }, {}),
    );
    const res = spearmanByHorizon(rows, ["1h"], false).filter(
      (r) => r.variable === "buyerCount" && r.target === "y",
    );
    expect(res).toHaveLength(1);
    expect(res[0]!.rho).toBeCloseTo(1, 10);
    expect(res[0]!.n).toBe(5);

    const flat = [1, 2, 3].map((i) => row(`f${i}`, { buyerCount: i }, { "1h": 0.5 }, {}));
    const res2 = spearmanByHorizon(flat, ["1h"], false).filter(
      (r) => r.variable === "buyerCount" && r.target === "y",
    );
    expect(res2[0]!.rho).toBeNull();
  });
  it("survie binaire traitée comme 0/1", () => {
    const rows = [1, 2, 3, 4].map((i) =>
      row(`s${i}`, { buyerCount: i }, {}, { "1h": i > 2 }),
    );
    const { xs, ys } = xyPairs(rows, "buyerCount", "1h", false, false);
    expect(ys).toEqual([0, 0, 1, 1]);
    expect(xs).toEqual([1, 2, 3, 4]);
  });
  it("exclusion des outliers |Y|>=10 en mode secondaire", () => {
    const rows = [
      row("a", { buyerCount: 1 }, { "1h": 0.1 }, {}),
      row("b", { buyerCount: 2 }, { "1h": 50 }, {}),
      row("c", { buyerCount: 3 }, { "1h": 0.3 }, {}),
    ];
    const withOut = xyPairs(rows, "buyerCount", "1h", true, false);
    const without = xyPairs(rows, "buyerCount", "1h", true, true);
    expect(withOut.xs).toHaveLength(3);
    expect(without.xs).toHaveLength(2);
  });
});

describe("groupStats", () => {
  it("métriques obligatoires sur distribution connue", () => {
    const ys = [-0.95, -0.5, -0.2, -0.1, 0, 0.1, 0.3, 0.5, 1, 2];
    const g = groupStats(ys, [true, true, false, true, true, false, true, true, true, true]);
    expect(g.n).toBe(10);
    expect(g.mean).toBeCloseTo(0.215, 10);
    expect(g.median).toBeCloseTo(0.05, 10);
    expect(g.min).toBe(-0.95);
    expect(g.max).toBe(2);
    expect(g.extremeLossRate).toBeCloseTo(0.1, 10);
    expect(g.survivalRate).toBeCloseTo(0.8, 10);
    expect(g.ci95).not.toBeNull(); // n>=10 : bootstrap du protocole
  });
  it("IC95 null si n<10 (protocole partagé)", () => {
    const g = groupStats([-0.95, -0.5, 0, 0.5, 2], [true, true, false, true, true]);
    expect(g.n).toBe(5);
    expect(g.ci95).toBeNull();
    expect(g.median).toBe(0);
  });
  it("drawdown max de la P&L cumulée", () => {
    // eq: 2 -> 1 -> 3 : pic 2, creux 1 => dd -50%
    const g = groupStats([1, -0.5, 2], [null, null, null]);
    expect(g.maxDrawdown).toBeCloseTo(-0.5, 10);
  });
  it("vide => n=0, tout null", () => {
    const g = groupStats([], []);
    expect(g.n).toBe(0);
    expect(g.mean).toBeNull();
  });
});

describe("decileTopBottom", () => {
  it("top vs bottom sur données synthétiques séparables", () => {
    const rows: DiscoveryRow[] = [];
    for (let i = 0; i < 20; i++)
      rows.push(
        row(`d${i}`, { gini: i / 20 }, { "1h": i < 10 ? -0.5 : 0.5 }, {}),
      );
    const res = decileTopBottom(rows, ["1h"], false).filter((r) => r.variable === "gini");
    expect(res).toHaveLength(1);
    expect(res[0]!.top.median).toBeGreaterThan(res[0]!.bottom.median!);
    expect(res[0]!.topMinusBottomMedian).toBeCloseTo(1, 10);
  });
});

describe("temporalStability", () => {
  it("deux moitiés avec rhoGap calculé", () => {
    const rows: DiscoveryRow[] = [];
    for (let i = 0; i < 6; i++)
      rows.push(
        row(`t${i}`, { buyerCount: i }, { "1h": i }, {}, `2026-09-28T0${i}:00:00.000Z`),
      );
    const res = temporalStability(rows, ["1h"]).filter(
      (r) => r.variable === "buyerCount" && r.target === "y",
    );
    expect(res).toHaveLength(1);
    expect(res[0]!.firstHalf.n).toBe(3);
    expect(res[0]!.secondHalf.n).toBe(3);
    expect(res[0]!.rhoGap).toBeCloseTo(0, 10); // monotone partout
  });
});

describe("cohortStability (grille anti-overfitting)", () => {
  it("ne produit que les cohortes autorisées", () => {
    const rows = [
      row("a", { buyerCount: 1 }, { "1h": 0.1 }, {}, "2026-09-28T00:00:00.000Z", "discovery"),
      row("b", { buyerCount: 2 }, { "1h": 0.2 }, {}, "2026-09-28T00:00:00.000Z", "calibration"),
      row("c", { buyerCount: 3 }, { "1h": 0.3 }, {}, "2026-09-28T00:00:00.000Z", "holdout"),
    ];
    const res = cohortStability(rows, ["1h"], ["discovery"]).filter(
      (r) => r.variable === "buyerCount" && r.target === "y",
    );
    expect(res).toHaveLength(1);
    expect(res[0]!.cohorts.map((c) => c.label)).toEqual(["discovery"]);
    expect(res[0]!.cohorts[0]!.n).toBe(1);
  });
});

describe("xValue", () => {
  it("retourne la variable demandée", () => {
    const r = row("m", { gini: 0.42 }, {}, {});
    expect(xValue(r.features, "gini")).toBe(0.42);
    expect(xValue(r.features, "top5Share")).toBeNull();
  });
});
