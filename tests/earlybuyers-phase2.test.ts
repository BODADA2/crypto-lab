/**
 * Tests Phase 2 — Early Buyers + Survival Model.
 *
 *  - audit : fixture avec feature post-t0 → FAIL ; fixture propre → PASS ;
 *  - snapshot : filtre t0 strict, exclusion < 5 buyers ;
 *  - labels : DD calculé sur série synthétique avec glitch → glitch ignoré ;
 *    mint DATA_ERROR → labels null + flag ;
 *  - stats : spearman ~nul sur données indépendantes ;
 *  - modèles : la logistique converge sur données séparables synthétiques.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { auditAntiLeakage } from "../lab/predictive/earlybuyers/audit.ts";
import { buildSnapshot } from "../lab/predictive/earlybuyers/snapshot.ts";
import { computeLabels, DATA_ERROR_MINTS } from "../lab/predictive/earlybuyers/labels.ts";
import { permutationPValue, spearman, mulberry32 } from "../lab/predictive/earlybuyers/stats.ts";
import { trainLogistic } from "../lab/predictive/earlybuyers/models.ts";
import type { FeatureSet } from "../lab/predictive/earlybuyers/types.ts";

const EB_DIR = "data/earlybuyers";
const H_DIR = "data/history";
const tmpFiles: string[] = [];

function tmpWrite(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  tmpFiles.push(path);
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* noop */
    }
  }
});

function mkFeatureSet(mint: string, t0ms: number, tsMs: number): FeatureSet {
  return {
    mint,
    universe: "discovery",
    t0ms,
    features: {
      nBuyers: { value: 10, tsMs },
      giniAmt: { value: 0.5, tsMs },
    },
  };
}

describe("audit anti-fuite", () => {
  it("PASS quand toutes les features sont <= t0ms", () => {
    const t0 = 1_790_000_000_000;
    const r = auditAntiLeakage([mkFeatureSet("m1", t0, t0 - 1000), mkFeatureSet("m2", t0, t0)]);
    expect(r.pass).toBe(true);
    expect(r.checked).toBe(4);
    expect(r.violations).toHaveLength(0);
  });

  it("FAIL avec identification précise quand une feature est post-t0", () => {
    const t0 = 1_790_000_000_000;
    const bad = mkFeatureSet("BADMINT", t0, t0 + 60_000);
    const r = auditAntiLeakage([mkFeatureSet("ok", t0, t0 - 1), bad]);
    expect(r.pass).toBe(false);
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0]!.mint).toBe("BADMINT");
    expect(r.violations[0]!.feature).toBe("nBuyers");
    expect(r.violations[0]!.overSec).toBeCloseTo(60, 6);
  });
});

/* ------------------------------------------------------------------ */

const T0_ISO = "2026-09-26T05:00:00.000Z";
const T0_MS = Date.parse(T0_ISO);
const T0_SEC = Math.floor(T0_MS / 1000);

function historyLine(mint: string, iso: string, price: number, liq: number): string {
  return JSON.stringify({
    mint,
    chain: "solana",
    symbol: "T",
    name: "T",
    createdAt: iso,
    pairCreatedAt: T0_MS,
    pairAddress: null,
    dexId: "pumpswap",
    url: null,
    priceUsd: price,
    liquidityUsd: liq,
    fdvUsd: null,
    marketCapUsd: null,
    volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
    fetchedAt: iso,
  });
}

function buyer(wallet: string, blockTime: number | null, rank: number, amount: string) {
  return { wallet, blockTime, slot: 1, rank, amountRaw: amount };
}

describe("snapshot", () => {
  it("filtre strictement les buyers post-t0 et à blockTime null", async () => {
    const mint = "TESTSNAPaaa111pump";
    const hist = [
      historyLine(mint, "2026-09-26T04:00:00.000Z", 0.001, 10_000), // pas de t0 (liq < 20000)
      historyLine(mint, T0_ISO, 0.001, 50_000),
      historyLine(mint, "2026-09-26T06:00:00.000Z", 0.002, 60_000),
    ].join("\n");
    tmpWrite(join(H_DIR, `${mint}.jsonl`), hist);
    const buyers = [
      buyer("w1", T0_SEC - 100, 0, "100"),
      buyer("w2", T0_SEC - 50, 1, "200"),
      buyer("w3", T0_SEC, 2, "300"), // == t0ms : inclus (<=)
      buyer("w4", T0_SEC - 10, 3, "400"),
      buyer("w5", T0_SEC - 5, 4, "500"),
      buyer("w6", T0_SEC - 1, 5, "600"),
      buyer("w7", T0_SEC + 3600, 6, "700"), // post-t0 : exclu
      buyer("w8", null, 7, "800"), // blockTime null : exclu
    ];
    tmpWrite(join(EB_DIR, `${mint}.json`), JSON.stringify({ mint, buyers }));

    const snap = await buildSnapshot(mint, { fetchMissing: false });
    expect(snap.excludedReason).toBeNull();
    expect(snap.t0ms).toBe(T0_MS);
    expect(snap.buyers.map((b) => b.wallet)).toEqual(["w1", "w2", "w3", "w4", "w5", "w6"]);
    // Sans réseau : historiques null mais snapshot valide.
    expect(snap.histories["w1"]!.txCountPreT0).toBeNull();
  });

  it("exclut avec raison documentée quand < 5 buyers pré-t0", async () => {
    const mint = "TESTSNAPbbb222pump";
    const hist = [historyLine(mint, T0_ISO, 0.001, 50_000)].join("\n");
    tmpWrite(join(H_DIR, `${mint}.jsonl`), hist);
    const buyers = [
      buyer("w1", T0_SEC - 100, 0, "100"),
      buyer("w2", T0_SEC - 50, 1, "200"),
      buyer("w3", T0_SEC + 10, 2, "300"), // post-t0
    ];
    tmpWrite(join(EB_DIR, `${mint}.json`), JSON.stringify({ mint, buyers }));
    const snap = await buildSnapshot(mint, { fetchMissing: false });
    expect(snap.excludedReason).toMatch(/< 5/);
    expect(snap.buyers).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("labels", () => {
  it("ignore le tick glitch dans ddMax24h", () => {
    const mint = "TESTLBLccc333pump";
    // t0 à 05:00, prix 1.0 ; glitch x1000 à 06:00 ; retour à 0.9 puis 0.7.
    const hist = [
      historyLine(mint, T0_ISO, 1.0, 50_000),
      historyLine(mint, "2026-09-26T06:00:00.000Z", 1000.0, 50_000), // glitch
      historyLine(mint, "2026-09-26T07:00:00.000Z", 0.9, 50_000),
      historyLine(mint, "2026-09-26T08:00:00.000Z", 0.7, 50_000),
      historyLine(mint, "2026-09-26T09:00:00.000Z", 0.75, 50_000),
    ].join("\n");
    tmpWrite(join(H_DIR, `${mint}.jsonl`), hist);
    const l = computeLabels(mint);
    // Sans le glitch : min = 0.7/1.0 - 1 = -0.30.
    expect(l.ddMax24h).toBeCloseTo(-0.3, 9);
    expect(l.dd30_24h).toBe(true);
    expect(l.dd50_24h).toBe(false);
    expect(l.survival_50_24h).toBe(true);
  });

  it("neutralise le mint DATA_ERROR (SKHY)", () => {
    const skhy = [...DATA_ERROR_MINTS][0]!;
    const l = computeLabels(skhy);
    expect(l.dataError).toBe(true);
    expect(l.y1h).toBeNull();
    expect(l.ddMax24h).toBeNull();
    expect(l.survival_50_24h).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("stats", () => {
  it("spearman ~nul sur données indépendantes (p-value non significative)", () => {
    const rnd = mulberry32(999);
    const xs = Array.from({ length: 60 }, () => rnd());
    const ys = Array.from({ length: 60 }, () => rnd());
    const s = spearman(xs, ys);
    expect(s).not.toBeNull();
    expect(Math.abs(s!)).toBeLessThan(0.25);
    const p = permutationPValue(xs, ys);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.05);
  });

  it("détecte une relation monotone forte", () => {
    const xs = Array.from({ length: 60 }, (_, i) => i);
    const ys = xs.map((x) => x * 2 + 1);
    expect(spearman(xs, ys)).toBeCloseTo(1, 9);
    expect(permutationPValue(xs, ys)!).toBeLessThan(0.01);
  });
});

/* ------------------------------------------------------------------ */

describe("modèles", () => {
  it("la logistique converge sur données séparables synthétiques", () => {
    const rnd = mulberry32(7);
    const X: number[][] = [];
    const y: boolean[] = [];
    for (let i = 0; i < 40; i++) {
      const x1 = rnd() * 2 - 1;
      const x2 = rnd() * 2 - 1;
      X.push([x1, x2]);
      y.push(x1 + x2 > 0.2);
    }
    const r = trainLogistic({ X, y, featureNames: ["x1", "x2"] });
    expect(r.converged).toBe(true);
    expect(r.trainAcc!).toBeGreaterThan(0.9);
    expect(r.trainAUC!).toBeGreaterThan(0.9);
  });
});
