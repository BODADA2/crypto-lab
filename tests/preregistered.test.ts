import { describe, it, expect } from "vitest";
import { applyVanishRule, CRITERIA, migrationExtras, periodStats, VANISH_GAP_MS } from "../lab/backtest/preregistered.ts";
import type { Trade } from "../lab/backtest/harness.ts";
import type { TokenSnapshot } from "../lab/types.ts";

const trade = (over: Partial<Trade>): Trade => ({
  mint: "M",
  entryAt: "2026-09-30T12:00:00Z",
  exitAt: "2026-09-30T13:00:00Z",
  entryPrice: 1,
  exitPrice: 1.1,
  ret: 0.1,
  grossRet: 0.1,
  bars: 4,
  exit: "time-stop",
  score: 50,
  costs: 0.02,
  ...over,
});

describe("verdict pré-enregistré", () => {
  it("un token disparu des données compte −100 %", () => {
    const end = Date.parse("2026-10-16T00:00:00Z");
    const lastSeen = new Map([["GONE", end - VANISH_GAP_MS - 1], ["ALIVE", end - 60_000]]);
    const { trades, vanished } = applyVanishRule(
      [trade({ mint: "GONE", exit: "end-of-data", ret: 0.2 }), trade({ mint: "ALIVE", exit: "end-of-data", ret: 0.2 }), trade({ mint: "GONE", exit: "stop-loss", ret: -0.27 })],
      lastSeen,
      end,
    );
    expect(vanished).toBe(1);
    expect(trades.map((t) => t.ret)).toEqual([-1, 0.2, -0.27]);
  });

  it("moins de 30 trades n'est jamais un succès", () => {
    const s = periodStats(Array.from({ length: CRITERIA.minTradesPerPeriod - 1 }, () => trade({ ret: 0.5 })), 0);
    expect(s.pass).toBe(false);
    expect(s.reason).toContain("non concluant");
  });

  it("succès seulement si gains ÷ pertes ≥ 1,3 et espérance > 0", () => {
    const good = [...Array.from({ length: 20 }, () => trade({ ret: 0.3 })), ...Array.from({ length: 20 }, () => trade({ ret: -0.2 }))];
    expect(periodStats(good, 0).pass).toBe(true); // PF 1,5
    const weak = [...Array.from({ length: 20 }, () => trade({ ret: 0.25 })), ...Array.from({ length: 20 }, () => trade({ ret: -0.2 }))];
    expect(periodStats(weak, 0).pass).toBe(false); // PF 1,25
  });

  it("la migration n'est jamais fournie avant qu'elle ait eu lieu", () => {
    const at = Date.parse("2026-10-01T10:00:00Z");
    const extras = migrationExtras(new Map([["M", at]]));
    const snap = (iso: string) => ({ mint: "M", fetchedAt: iso }) as unknown as TokenSnapshot;
    expect(extras([snap("2026-10-01T09:59:00Z")]).migration).toBeNull();
    expect(extras([snap("2026-10-01T10:05:00Z")]).migration).toEqual({ migratedAt: at });
  });
});
