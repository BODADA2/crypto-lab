import { describe, it, expect } from "vitest";
import { bundleRiskStatic, detectEarlyDump, BUNDLE_EXCLUDE_SCORE, type WalletTrade } from "../lab/signals/bundle.ts";
import { UNKNOWN_AUTHORITY } from "../lab/collect/types.ts";

const base = {
  top10Pct: 25,
  holders: 500,
  mintAuthority: null,
  freezeAuthority: null,
  liquidityUsd: 50_000,
};

describe("bundleRiskStatic", () => {
  it("score bas pour un token sain et connu", () => {
    const r = bundleRiskStatic(base);
    expect(r.score).toBeLessThan(BUNDLE_EXCLUDE_SCORE);
    expect(r.reasons).toHaveLength(0);
  });

  it("pénalise fortement le top10 inconnu (100 % par défaut = conservateur)", () => {
    const r = bundleRiskStatic({ ...base, top10Pct: 100 });
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.reasons.join(" ")).toMatch(/inconnu/);
  });

  it("pénalise la concentration élevée et les autorités actives", () => {
    const r = bundleRiskStatic({ ...base, top10Pct: 70, mintAuthority: "auth1", freezeAuthority: "auth2", holders: 30 });
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("ne pénalise pas les autorités UNKNOWN (donnée manquante, pas un risque avéré)", () => {
    const r = bundleRiskStatic({ ...base, mintAuthority: UNKNOWN_AUTHORITY, freezeAuthority: UNKNOWN_AUTHORITY });
    expect(r.score).toBe(0);
  });

  it("le score ne dépasse jamais 100", () => {
    const r = bundleRiskStatic({ top10Pct: 100, holders: 5, mintAuthority: "a", freezeAuthority: "b", liquidityUsd: 100 });
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

const T0 = Date.parse("2026-09-01T00:00:00Z");
function trade(wallet: string, side: "buy" | "sell", atMin: number, usd: number): WalletTrade {
  return { wallet, side, atMs: T0 + atMin * 60_000, usd };
}

describe("detectEarlyDump", () => {
  it("lève le drapeau quand les wallets précoces vendent en bloc", () => {
    const trades = [
      trade("w1", "buy", 5, 3000),
      trade("w2", "buy", 8, 5000),
      trade("w1", "sell", 20, 2800),
      trade("w2", "sell", 25, 4500),
    ];
    const r = detectEarlyDump(trades, T0);
    expect(r.flag).toBe(true);
    expect(r.earlyWallets).toBe(2);
    expect(r.reason).toMatch(/ventes groupées/);
  });

  it("ne lève pas le drapeau si les précoces tiennent", () => {
    const trades = [trade("w1", "buy", 5, 3000), trade("w2", "buy", 8, 5000), trade("w3", "sell", 40, 1000)];
    const r = detectEarlyDump(trades, T0);
    expect(r.flag).toBe(false);
    expect(r.sellRatio).toBe(0);
  });

  it("ne conclut pas sans achats précoces significatifs", () => {
    const r = detectEarlyDump([trade("w1", "buy", 5, 10)], T0);
    expect(r.flag).toBe(false);
    expect(r.reason).toMatch(/pas assez/);
  });

  it("ignore les achats hors fenêtre précoce", () => {
    const trades = [trade("w1", "buy", 120, 5000), trade("w1", "sell", 130, 4000)];
    const r = detectEarlyDump(trades, T0);
    expect(r.earlyWallets).toBe(0);
    expect(r.flag).toBe(false);
  });
});
