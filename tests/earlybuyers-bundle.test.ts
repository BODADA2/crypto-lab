/**
 * Tests des métriques de bundling H-BUNDLE (fonctions pures).
 * Aucun appel réseau : montants et historiques fabriqués.
 */
import { describe, expect, it } from "vitest";
import { computeBundleMetrics, computeCoordinatedSells } from "../lab/signals/earlybuyers.ts";
import type { WalletTokenEvent } from "../lab/collect/types.ts";

const NOW = 1_790_000_000_000;
const now = () => NOW;

function buyer(wallet: string, slot: number, amountRaw: string, rank = 0) {
  return { wallet, slot, amountRaw, rank, signature: "sig", blockTime: null };
}

function evt(mint: string, blockTime: number | null, direction: "in" | "out", deltaRaw: string): WalletTokenEvent {
  return { signature: "s", blockTime, mint, deltaRaw, direction };
}

describe("computeBundleMetrics", () => {
  it("top5_share = 1 quand 5 wallets captent tout", () => {
    const buyers = [
      buyer("w0", 1, "50"),
      buyer("w1", 2, "20"),
      buyer("w2", 3, "15"),
      buyer("w3", 4, "10"),
      buyer("w4", 5, "5"),
      buyer("w5", 6, "0"),
    ];
    const m = computeBundleMetrics(buyers, { now });
    expect(m.top5_share).toBeCloseTo(1, 10);
    expect(m.buyerCount).toBe(6);
    expect(m.totalRaw).toBe("100");
  });

  it("top5_share partiel : top5 sur 10 montants égaux = 0.5", () => {
    const buyers = Array.from({ length: 10 }, (_, i) => buyer(`w${i}`, i, "10"));
    const m = computeBundleMetrics(buyers, { now });
    expect(m.top5_share).toBeCloseTo(0.5, 10);
  });

  it("gini = 0 pour des montants égaux", () => {
    const buyers = Array.from({ length: 8 }, (_, i) => buyer(`w${i}`, i, "100"));
    const m = computeBundleMetrics(buyers, { now });
    expect(m.gini).toBeCloseTo(0, 10);
  });

  it("gini = (n-1)/n quand un wallet capte tout", () => {
    const buyers = [buyer("w0", 1, "100"), buyer("w1", 2, "0"), buyer("w2", 3, "0"), buyer("w3", 4, "0")];
    const m = computeBundleMetrics(buyers, { now });
    expect(m.gini).toBeCloseTo(0.75, 10);
  });

  it("gini dans [0,1] sur distribution réaliste", () => {
    const buyers = [buyer("a", 1, "32960034"), buyer("b", 1, "38663718"), buyer("c", 2, "28152688"), buyer("d", 3, "1000")];
    const m = computeBundleMetrics(buyers, { now });
    expect(m.gini).toBeGreaterThan(0);
    expect(m.gini).toBeLessThan(1);
  });

  it("same_slot_max détecte la coordination temporelle", () => {
    const buyers = [buyer("a", 7, "10"), buyer("b", 7, "10"), buyer("c", 7, "10"), buyer("d", 9, "10")];
    const m = computeBundleMetrics(buyers, { now });
    expect(m.same_slot_max).toBeCloseTo(0.75, 10);
  });

  it("vide : zéros, pas de crash", () => {
    const m = computeBundleMetrics([], { now });
    expect(m.top5_share).toBe(0);
    expect(m.gini).toBe(0);
    expect(m.same_slot_max).toBe(0);
    expect(m.totalRaw).toBe("0");
  });

  it("montants invalides traités comme 0", () => {
    const m = computeBundleMetrics([buyer("a", 1, "nope"), buyer("b", 2, "10")], { now });
    expect(m.totalRaw).toBe("10");
    expect(m.top5_share).toBeCloseTo(1, 10);
  });
});

describe("computeCoordinatedSells", () => {
  const MINT = "mintX";
  const MIG = 1_790_000_000; // secondes

  it("compte les vendeurs >50% dans la fenêtre, ignore les non-couverts", () => {
    const buyers = [
      { wallet: "w1", amountRaw: "100" },
      { wallet: "w2", amountRaw: "100" },
      { wallet: "w3", amountRaw: "100" },
    ];
    const histories = new Map<string, WalletTokenEvent[]>([
      // w1 : couvert (historique remonte avant migration), vend 80 dans la fenêtre
      ["w1", [evt(MINT, MIG - 100, "in", "100"), evt(MINT, MIG + 60, "out", "-80")]],
      // w2 : couvert, vend 10 seulement
      ["w2", [evt(MINT, MIG - 50, "in", "100"), evt(MINT, MIG + 120, "out", "-10")]],
      // w3 : NON couvert (historique trop récent) mais vend tout — exclu du ratio
      ["w3", [evt(MINT, MIG + 3600, "in", "100"), evt(MINT, MIG + 3700, "out", "-100")]],
    ]);
    const r = computeCoordinatedSells(buyers, histories, MINT, MIG * 1000, { windowSec: 300, minCovered: 2, now });
    expect(r.walletsChecked).toBe(3);
    expect(r.walletsCovered).toBe(2);
    expect(r.sellersOver50).toBe(1);
    expect(r.coordinated_sells).toBeCloseTo(0.5, 10);
    expect(r.details.find((d) => d.wallet === "w3")!.covered).toBe(false);
  });

  it("null si couverture insuffisante", () => {
    const buyers = [{ wallet: "w1", amountRaw: "100" }];
    const histories = new Map<string, WalletTokenEvent[]>([["w1", [evt(MINT, MIG + 10, "out", "-60")]]]);
    const r = computeCoordinatedSells(buyers, histories, MINT, MIG * 1000, { minCovered: 5, now });
    expect(r.coordinated_sells).toBeNull();
    expect(r.walletsCovered).toBe(0);
  });

  it("ventes hors fenêtre non comptées", () => {
    const buyers = [{ wallet: "w1", amountRaw: "100" }];
    const histories = new Map<string, WalletTokenEvent[]>([
      ["w1", [evt(MINT, MIG - 100, "in", "100"), evt(MINT, MIG + 301, "out", "-100")]],
    ]);
    const r = computeCoordinatedSells(buyers, histories, MINT, MIG * 1000, { windowSec: 300, minCovered: 1, now });
    expect(r.sellersOver50).toBe(0);
    expect(r.coordinated_sells).toBeCloseTo(0, 10);
  });

  it("autres mints ignorés", () => {
    const buyers = [{ wallet: "w1", amountRaw: "100" }];
    const histories = new Map<string, WalletTokenEvent[]>([
      ["w1", [evt("autreMint", MIG - 100, "in", "100"), evt(MINT, MIG - 100, "in", "100"), evt("autreMint", MIG + 60, "out", "-90")]],
    ]);
    const r = computeCoordinatedSells(buyers, histories, MINT, MIG * 1000, { minCovered: 1, now });
    expect(r.details[0]!.soldFrac).toBeCloseTo(0, 10);
  });
});
