/**
 * Tests SPRINT 2C — familles E (Actors/Entity) + F (Creator History).
 * Données synthétiques uniquement : aucun accès disque, aucun holdout.
 */
import { describe, it, expect } from "vitest";
import {
  buildIncidence,
  recurrentWalletsAsOf,
  recurrentWalletsOverall,
  t0ByMint,
  type MintSet,
} from "./incidence.ts";
import { walletQualities } from "./quality.ts";
import { buildSharedPairs, outcomeCorrelation } from "./correlation.ts";
import { rng, permutationP, median, mean } from "./statsx.ts";

const T0 = 1_000_000;

function mkSet(mint: string, t0ms: number, wallets: string[]): MintSet {
  return {
    mint,
    t0ms,
    universe: "discovery",
    buyers: wallets.map((w, i) => ({
      wallet: w,
      slot: i,
      blockTimeMs: t0ms - (wallets.length - i) * 1000,
      amountRaw: "1000",
    })),
  };
}

describe("incidence", () => {
  const sets = [
    mkSet("m1", T0, ["wA", "wB"]),
    mkSet("m2", T0 + 1000, ["wA", "wC"]),
    mkSet("m3", T0 + 2000, ["wD"]),
  ];
  const inc = buildIncidence(sets);
  const t0 = t0ByMint(sets);

  it("construit l'incidence wallet -> mints", () => {
    expect(inc.get("wA")!.map((o) => o.mint).sort()).toEqual(["m1", "m2"]);
    expect(inc.get("wD")!.map((o) => o.mint)).toEqual(["m3"]);
  });

  it("recurrentWalletsAsOf : seuls les mints passés comptent (point-in-time)", () => {
    // m2 : wA vu dans m1 (t0 < t0m2) -> récurrent ; wC jamais vu -> non.
    const r2 = recurrentWalletsAsOf(inc, t0, "m2", T0 + 1000, 1);
    expect([...r2]).toEqual(["wA"]);
    // m1 : aucun mint passé -> vide (le futur m2 ne compte pas).
    const r1 = recurrentWalletsAsOf(inc, t0, "m1", T0, 1);
    expect(r1.size).toBe(0);
  });

  it("recurrentWalletsOverall : >=2 mints, sans filtre temporel", () => {
    expect(recurrentWalletsOverall(inc)).toEqual(["wA"]);
  });
});

describe("walletQualities", () => {
  it("ne compte que les mints passés labellisés (as-of-t0)", () => {
    const sets = [
      mkSet("m1", T0, ["wA"]),
      mkSet("m2", T0 + 1000, ["wA", "wB"]),
    ];
    const inc = buildIncidence(sets);
    const t0 = t0ByMint(sets);
    const survivalOf = new Map<string, boolean | null>([
      ["m1", true],
      ["m2", false],
    ]);
    // Pour m2 : wA a m1 (passé, survécu) -> qualité 1 ; wB aucun passé -> null.
    const q = walletQualities(sets[1]!, inc, t0, survivalOf, new Set());
    const qa = q.find((x) => x.wallet === "wA")!;
    const qb = q.find((x) => x.wallet === "wB")!;
    expect(qa.pastCount).toBe(1);
    expect(qa.quality).toBe(1);
    expect(qb.pastCount).toBe(0);
    expect(qb.quality).toBeNull();
    // Pour m1 : aucun passé (m2 est le futur) -> null partout.
    const q1 = walletQualities(sets[0]!, inc, t0, survivalOf, new Set());
    expect(q1[0]!.quality).toBeNull();
  });
});

describe("buildSharedPairs + outcomeCorrelation", () => {
  it("construit les paires partageant un wallet récurrent-as-of-t0", () => {
    const sets = [
      mkSet("m1", T0, ["wA", "x1"]),
      mkSet("m2", T0 + 1000, ["wA", "x2"]),
      mkSet("m3", T0 + 2000, ["wA", "x3"]),
    ];
    const inc = buildIncidence(sets);
    const t0 = t0ByMint(sets);
    const rec = new Map<string, Set<string>>();
    for (const s of sets) rec.set(s.mint, recurrentWalletsAsOf(inc, t0, s.mint, s.t0ms, 1));
    const buyerMints = new Map<string, string[]>();
    for (const [w, obs] of inc) buyerMints.set(w, [...new Set(obs.map((o) => o.mint))]);
    const pairs = buildSharedPairs(sets, buyerMints, t0, rec);
    // m1-m2 (wA récurrent as-of m2), m1-m3 et m2-m3 (wA récurrent as-of m3).
    expect(pairs.length).toBe(3);
    expect(pairs.every((p) => p.sharedWallets.includes("wA"))).toBe(true);
  });

  it("détecte une corrélation parfaite injectée (sanity check)", () => {
    // 6 mints en 3 paires ; outcomes identiques dans chaque paire.
    // 12 mints en 6 paires ; outcomes identiques dans chaque paire.
    const wallets = ["wA", "wB", "wC", "wD", "wE", "wF"];
    const yvals = [0.5, -0.9, 0.1, 1.2, -0.3, 0.0];
    const sets: MintSet[] = [];
    wallets.forEach((w, i) => {
      sets.push(mkSet(`m${i}x1`, T0 + i * 2, [w]));
      sets.push(mkSet(`m${i}x2`, T0 + i * 2 + 1, [w]));
    });
    const inc = buildIncidence(sets);
    const t0 = t0ByMint(sets);
    const rec = new Map<string, Set<string>>();
    for (const s of sets) rec.set(s.mint, recurrentWalletsAsOf(inc, t0, s.mint, s.t0ms, 1));
    const buyerMints = new Map<string, string[]>();
    for (const [w, obs] of inc) buyerMints.set(w, [...new Set(obs.map((o) => o.mint))]);
    const pairs = buildSharedPairs(sets, buyerMints, t0, rec);
    const y1hOf = new Map<string, number | null>();
    const survivalOf = new Map<string, boolean | null>();
    wallets.forEach((w, i) => {
      y1hOf.set(`m${i}x1`, yvals[i]!);
      y1hOf.set(`m${i}x2`, yvals[i]!);
      survivalOf.set(`m${i}x1`, yvals[i]! >= 0);
      survivalOf.set(`m${i}x2`, yvals[i]! >= 0);
    });
    const r = outcomeCorrelation(pairs, y1hOf, survivalOf, buyerMints);
    expect(r.nPairs).toBe(6);
    expect(r.meanAbsDiffY1h).toBe(0);
    expect(r.fracSameSurv).toBe(1);
    expect(r.permP_Y1h).not.toBeNull();
    expect(r.permP_Y1h!).toBeLessThan(0.2);
  });
});

describe("statsx", () => {
  it("rng déterministe", () => {
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("permutationP : nul quand n < 5", () => {
    expect(permutationP([1, 2], [3, 4], (x, y) => 1).p).toBeNull();
  });

  it("median/mean basiques", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNull();
  });
});
