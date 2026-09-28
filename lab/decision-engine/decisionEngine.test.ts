import { describe, it, expect } from "vitest";
import { decide, lethalChecks, buyTriggers } from "./decisionEngine.ts";
import { PaperLedger } from "./paperLedger.ts";
import { DEFAULT_CONFIG, type TokenSnapshot } from "./types.ts";

function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint: "MINT_TEST_11111111111111111111111111111111",
    ticker: "$TEST",
    priceUsd: 0.001,
    liquidityUsd: 50000,
    migrated: false,
    lpBurnedOrLocked: null,
    mintAuthority: null,
    freezeAuthority: null,
    top10HolderPctRaw: 12,
    top10HolderPctAdj: 12,
    holderExclusionMethod: "test",
    velocityUsd2min: 35000,
    velocityMethod: "test",
    curveProgressPct: 60,
    curveAccelPct: 5,
    narrativeTags: [],
    smartWalletNetBuyUsd: null,
    dataQuality: 0.9,
    timestamp: Date.now(),
    ...over,
  };
}

describe("filtres létaux", () => {
  it("rejette si mint authority active", () => {
    const s = decide(snap({ mintAuthority: "active" }));
    expect(s.action).toBe("SKIP");
    expect(s.reasoning_short).toContain("mint=active");
  });

  it("rejette si freeze authority active", () => {
    const s = decide(snap({ freezeAuthority: "active" }));
    expect(s.action).toBe("SKIP");
  });

  it("rejette si liquidité < 8000", () => {
    const s = decide(snap({ liquidityUsd: 7999 }));
    expect(s.action).toBe("SKIP");
    expect(s.reasoning_short).toContain("7999");
  });

  it("rejette si liquidité INCONNUE (fail-closed)", () => {
    const s = decide(snap({ liquidityUsd: null }));
    expect(s.action).toBe("SKIP");
    expect(s.reasoning_short).toContain("INCONNUE");
  });

  it("rejette si migré sans LP brûlé/verrouillé", () => {
    const s = decide(snap({ migrated: true, lpBurnedOrLocked: null }));
    expect(s.action).toBe("SKIP");
    expect(s.reasoning_short).toContain("LP");
  });

  it("rejette si top10 > 20%", () => {
    const s = decide(snap({ top10HolderPctRaw: 25, top10HolderPctAdj: 25 }));
    expect(s.action).toBe("SKIP");
    expect(s.reasoning_short).toContain("25.0%");
  });

  it("rejette si concentration INCONNUE (fail-closed)", () => {
    const s = decide(snap({ top10HolderPctRaw: null, top10HolderPctAdj: null }));
    expect(s.action).toBe("SKIP");
  });

  it("tous les checks passent sur un token propre", () => {
    const checks = lethalChecks(snap());
    expect(checks.every((c) => c.pass)).toBe(true);
  });
});

describe("triggers d'achat", () => {
  it("BUY sur spike de vélocité", () => {
    const s = decide(snap());
    expect(s.action).toBe("BUY");
    expect(s.triggers.some((t) => t.startsWith("VELOCITY"))).toBe(true);
  });

  it("BUY sur courbe + narratif", () => {
    const s = decide(snap({ velocityUsd2min: 1000, curveAccelPct: 15, narrativeTags: ["CTO"] }));
    expect(s.action).toBe("BUY");
    expect(s.triggers.some((t) => t.startsWith("CURVE_NARRATIVE"))).toBe(true);
  });

  it("BUY sur smart wallets", () => {
    const s = decide(snap({ velocityUsd2min: 1000, smartWalletNetBuyUsd: 8000 }));
    expect(s.action).toBe("BUY");
    expect(s.triggers.some((t) => t.startsWith("SMART"))).toBe(true);
  });

  it("SKIP si aucun trigger malgré filtres OK", () => {
    const s = decide(snap({ velocityUsd2min: 1000 }));
    expect(s.action).toBe("SKIP");
    expect(s.reasoning_short).toContain("aucun trigger");
  });

  it("SKIP si dataQuality insuffisante", () => {
    const s = decide(snap({ dataQuality: 0.5 }));
    expect(s.action).toBe("SKIP");
    expect(s.reasoning_short).toContain("dataQuality");
  });

  it("2 triggers → HIGH, conf 80", () => {
    const s = decide(snap({ curveAccelPct: 15, narrativeTags: ["CTO"] }));
    expect(s.action).toBe("BUY");
    expect(s.triggers.length).toBe(2);
    expect(s.urgency).toBe("HIGH");
    expect(s.confidence_score).toBe(80);
  });

  it("format JSON conforme au contrat", () => {
    const s = decide(snap());
    expect(s.mode).toBe("PAPER");
    expect(s.real_execution).toBe(false);
    expect(s.position_size_pct).toBe(2.5);
    expect(s.stop_loss_pct).toBe(-8);
    expect(s.take_profit_levels).toEqual([100, 200, 500]);
    expect(typeof s.contract).toBe("string");
  });
});

describe("ledger paper — sorties", () => {
  it("hard stop à -8%", () => {
    const l = new PaperLedger(DEFAULT_CONFIG);
    l.open("M1", "$A", 1, 1000);
    const ev = l.evaluate("M1", 0.91, 2000);
    expect(ev[0].kind).toBe("STOP_LOSS");
    expect(ev[0].pnlPct).toBeCloseTo(-9, 5);
    expect(l.openCount).toBe(0);
  });

  it("time-exit : pas de nouvel ATH en 240s → 100%", () => {
    const l = new PaperLedger(DEFAULT_CONFIG);
    l.open("M1", "$A", 1, 1000);
    l.evaluate("M1", 1.02, 100_000); // petit plus haut → peak reset
    const ev = l.evaluate("M1", 1.01, 100_000 + 240_000 + 1000);
    expect(ev[0].kind).toBe("TIME_EXIT");
    expect(l.openCount).toBe(0);
  });

  it("pas de time-exit si ATH récent", () => {
    const l = new PaperLedger(DEFAULT_CONFIG);
    l.open("M1", "$A", 1, 1000);
    const ev = l.evaluate("M1", 1.5, 200_000); // nouvel ATH à t=200s
    expect(ev.length).toBe(0);
    expect(l.openCount).toBe(1);
  });

  it("TP1 50% à +100% puis trailing stop", () => {
    const l = new PaperLedger(DEFAULT_CONFIG);
    l.open("M1", "$A", 1, 1000);
    const ev1 = l.evaluate("M1", 2.2, 2000);
    expect(ev1[0].kind).toBe("TAKE_PROFIT_50");
    expect(l.openCount).toBe(1); // moonbag restant
    const ev2 = l.evaluate("M1", 1.8, 3000); // -18% depuis peak 2.2
    expect(ev2[0].kind).toBe("TRAILING_STOP");
    expect(l.openCount).toBe(0);
  });

  it("bankroll débitée/créditée en paper", () => {
    const l = new PaperLedger(DEFAULT_CONFIG);
    const before = l.bankrollUsd;
    l.open("M1", "$A", 1, 1000); // investit 25$
    l.evaluate("M1", 0.9, 2000); // stop -10%
    expect(l.bankrollUsd).toBeLessThan(before);
  });

  it("buyTriggers pur : seuils exacts", () => {
    expect(buyTriggers(snap({ velocityUsd2min: 19999 })).length).toBe(0);
    expect(buyTriggers(snap({ velocityUsd2min: 20000 })).length).toBe(1);
  });
});
