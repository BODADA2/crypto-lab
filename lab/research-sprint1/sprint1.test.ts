/**
 * SPRINT 1 — tests des calculs partagés et des expériences.
 * Données synthétiques uniquement : aucun accès réseau, aucune lecture de data/.
 */
import { describe, expect, it } from "vitest";
import {
  jaccard,
  fisherZDiff,
  zscore,
  assignTercile,
  percentile,
  survivalTimes,
  spearmanP,
} from "./common.ts";
import { kaplanMeier, fitCoxPH } from "../predictive/earlybuyers/survival.ts";
import { applyWindow } from "../predictive/earlybuyers/windows.ts";
import type { SnapshotBuyer } from "../predictive/earlybuyers/types.ts";
import type { TokenSnapshot } from "../types.ts";
import { findT0 } from "../predictive/universe.ts";

/* ---------------- jaccard ---------------- */

describe("jaccard", () => {
  it("vaut 1/3 pour {a,b} vs {b,c}", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 10);
  });
  it("vaut 1 pour deux sets identiques non vides", () => {
    expect(jaccard(new Set(["a"]), new Set(["a"]))).toBe(1);
  });
  it("vaut 0 si les deux sets sont vides", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  it("vaut 0 pour des sets disjoints", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
});

/* ---------------- fisherZDiff ---------------- */

describe("fisherZDiff", () => {
  it("p ~ 1 quand r et n sont identiques", () => {
    const { p } = fisherZDiff(0.4, 200, 0.4, 200);
    expect(p).toBeCloseTo(1, 6);
  });
  it("p petit quand les corrélations diffèrent nettement", () => {
    const { p } = fisherZDiff(0.5, 500, -0.5, 500);
    expect(p).toBeLessThan(1e-10);
  });
  it("NaN si n < 4", () => {
    const { p } = fisherZDiff(0.5, 3, 0.5, 100);
    expect(Number.isNaN(p)).toBe(true);
  });
});

/* ---------------- zscore / terciles ---------------- */

describe("zscore/assignTercile/percentile", () => {
  it("zscore centre-réduit", () => {
    const z = zscore([1, 2, 3, 4, 5]);
    expect(z[2]).toBeCloseTo(0, 10);
    expect(z[4]).toBeCloseTo(Math.SQRT2, 10);
  });
  it("zscore NaN si variance nulle", () => {
    expect(zscore([3, 3, 3]).every(Number.isNaN)).toBe(true);
  });
  it("assigne les terciles correctement", () => {
    expect(assignTercile(0, 2, 5)).toBe(1);
    expect(assignTercile(4, 2, 5)).toBe(2);
    expect(assignTercile(9, 2, 5)).toBe(3);
  });
  it("percentile interpole", () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([0, 10, 20], 1 / 3)).toBeCloseTo(20 / 3, 10);
  });
});

/* ---------------- kaplanMeier jouet ---------------- */

describe("kaplanMeier", () => {
  it("courbe jouet connue", () => {
    // 4 sujets : événements à t=1,2,4 ; censure à t=3 (ne change pas S).
    const km = kaplanMeier([1, 2, 3, 4], [true, true, false, true]);
    const at = (t: number) => km.filter((p) => p.t <= t).at(-1)!.s;
    expect(at(1)).toBeCloseTo(0.75, 10);
    expect(at(2)).toBeCloseTo(0.5, 10);
    expect(at(4)).toBeCloseTo(0, 10);
  });
});

/* ---------------- fitCoxPH univarié jouet ---------------- */

describe("fitCoxPH", () => {
  it("détecte une feature protectrice (jouet)", () => {
    // Relation bruitée mais nette : durée = 1 + 0.5*X + bruit, tous événements.
    // (Évite la séparation parfaite → effet Hauck-Donner sur le Wald.)
    const durations: number[] = [];
    const events: boolean[] = [];
    const X: number[][] = [];
    for (let i = 0; i < 40; i++) {
      const x = i % 11;
      durations.push(1 + 0.5 * x + 3 * ((i * 37) % 10) / 10);
      events.push(true);
      X.push([x]);
    }
    const r = fitCoxPH({ durations, events, X, featureNames: ["x"] });
    expect(r.converged).toBe(true);
    expect(r.n).toBe(40);
    expect(r.hr[0]).toBeLessThan(1); // protecteur
    expect(r.pWald[0]).toBeLessThan(0.05);
  });
  it("refuse n < 30 (garde d'honnêteté)", () => {
    const r = fitCoxPH({
      durations: [1, 2],
      events: [true, false],
      X: [[0], [1]],
      featureNames: ["x"],
    });
    expect(r.converged).toBe(false);
    expect(r.concordance).toBeNull();
  });
});

/* ---------------- survivalTimes jouet ---------------- */

function snap(t: string, price: number, liq: number): TokenSnapshot {
  return {
    mint: "m",
    chain: "solana",
    symbol: "T",
    fetchedAt: t,
    priceUsd: price,
    liquidityUsd: liq,
  } as TokenSnapshot;
}

describe("survivalTimes", () => {
  it("détecte le premier passage sous -50 %", () => {
    const s = [
      snap("2026-09-28T00:00:00Z", 1, 1000), // pré-t0 (liq < 20000)
      snap("2026-09-28T01:00:00Z", 1, 25000), // t0
      snap("2026-09-28T02:00:00Z", 0.9, 25000),
      snap("2026-09-28T03:00:00Z", 0.4, 25000), // -60 % → événement à h=2
      snap("2026-09-28T04:00:00Z", 0.3, 25000),
    ];
    const sp = survivalTimes(s);
    expect(sp).not.toBeNull();
    expect(sp!.event).toBe(true);
    expect(sp!.durationH).toBeCloseTo(2, 6);
  });
  it("censure quand le prix ne passe jamais sous -50 %", () => {
    const s = [
      snap("2026-09-28T00:00:00Z", 1, 25000), // t0
      snap("2026-09-28T02:00:00Z", 0.9, 25000),
      snap("2026-09-28T04:00:00Z", 0.8, 25000),
      snap("2026-09-28T06:00:00Z", 0.7, 25000),
    ];
    const sp = survivalTimes(s);
    expect(sp).not.toBeNull();
    expect(sp!.event).toBe(false);
    expect(sp!.durationH).toBeCloseTo(6, 6);
  });
  it("null si < 3 ticks post-t0 (garde labels.ts)", () => {
    const s = [
      snap("2026-09-28T00:00:00Z", 1, 25000),
      snap("2026-09-28T02:00:00Z", 0.9, 25000),
    ];
    expect(survivalTimes(s)).toBeNull();
  });
  it("ignore les ticks aberrants (glitch prix x100)", () => {
    const s = [
      snap("2026-09-28T00:00:00Z", 1, 25000), // t0
      snap("2026-09-28T01:00:00Z", 0.9, 25000),
      snap("2026-09-28T02:00:00Z", 90, 25000), // glitch x100 → ignoré
      snap("2026-09-28T03:00:00Z", 0.9, 25000),
      snap("2026-09-28T04:00:00Z", 0.9, 25000),
    ];
    const sp = survivalTimes(s);
    expect(sp).not.toBeNull();
    expect(sp!.event).toBe(false); // le glitch ne crée pas un faux événement
  });
});

/* ---------------- applyWindow (fenêtres E4) ---------------- */

function buyer(wallet: string, slot: number | null, tsMs: number): SnapshotBuyer {
  return { wallet, blockTimeMs: tsMs, slot, rank: 0, amountRaw: BigInt(0) };
}

describe("applyWindow", () => {
  const set = [
    buyer("w1", 100, 1000),
    buyer("w2", 100, 2000),
    buyer("w3", 105, 3000),
    buyer("w4", 200, 4000),
  ];
  it("pre_t0_set = identité", () => {
    expect(applyWindow(set, "pre_t0_set")).toHaveLength(4);
  });
  it("first_block = buyers du slot minimum", () => {
    const w = applyWindow(set, "first_block");
    expect(w.map((b) => b.wallet).sort()).toEqual(["w1", "w2"]);
  });
  it("first_5_slots = slots min..min+4", () => {
    const w = applyWindow(set, "first_5_slots");
    expect(w.map((b) => b.wallet).sort()).toEqual(["w1", "w2"]);
  });
  it("first_60s / first_300s filtrent sur blockTimeMs", () => {
    expect(applyWindow(set, "first_60s").map((b) => b.wallet).sort()).toEqual([
      "w1", "w2", "w3", "w4",
    ]);
    const tight = [buyer("a", 1, 1000), buyer("b", 1, 61001)];
    expect(applyWindow(tight, "first_60s").map((b) => b.wallet)).toEqual(["a"]);
    expect(applyWindow(tight, "first_300s").map((b) => b.wallet).sort()).toEqual(["a", "b"]);
  });
  it("first_block = [] si aucun slot non-null", () => {
    const noSlots = [buyer("a", null, 1000)];
    expect(applyWindow(noSlots, "first_block")).toHaveLength(0);
    expect(applyWindow(noSlots, "first_5_slots")).toHaveLength(0);
  });
});

/* ---------------- spearmanP ---------------- */

describe("spearmanP", () => {
  it("p petite pour corrélation forte", () => {
    expect(spearmanP(0.5, 500)).toBeLessThan(1e-10);
  });
  it("NaN si n < 3", () => {
    expect(Number.isNaN(spearmanP(0.5, 2))).toBe(true);
  });
});

/* ---------------- findT0 (sanity) ---------------- */

describe("findT0", () => {
  it("premier snapshot liq>=20000 et prix>0", () => {
    const s = [
      snap("2026-09-28T00:00:00Z", 1, 5000),
      snap("2026-09-28T01:00:00Z", 1, 25000),
    ];
    expect(findT0(s)).toBe(1);
  });
});
