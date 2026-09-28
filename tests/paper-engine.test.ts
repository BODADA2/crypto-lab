import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptationForRegime } from "../lab/paper-engine/config.ts";
import {
  closeDecision,
  computeMetrics,
  currentDrawdownPct,
  loadLedger,
  nextDecisionId,
  openDecision,
} from "../lab/paper-engine/ledger.ts";
import { analyzeBlock, proposeAdjustment } from "../lab/paper-engine/learn.ts";
import { determineRegime } from "../lab/paper-engine/regime.ts";
import { scoreCandidate, type ScoreCandidate } from "../lab/paper-engine/score.ts";
import { simulateClose } from "../lab/paper-engine/cycle.ts";
import type { PaperDecision } from "../lab/paper-engine/types.ts";
import type { TokenSnapshot } from "../lab/types.ts";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});
const mkTmp = (): string => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pe-")));

function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint: "MINT",
    chain: "solana",
    symbol: "TST",
    name: "Test",
    createdAt: "2026-09-28T00:00:00.000Z",
    pairCreatedAt: Date.parse("2026-09-27T00:00:00.000Z"),
    pairAddress: "PAIR",
    dexId: "pumpswap",
    url: null,
    priceUsd: 1,
    liquidityUsd: 100_000,
    fdvUsd: 1_000_000,
    marketCapUsd: 1_000_000,
    volume: { m5: 1000, h1: 50_000, h6: 50_000, h24: 50_000 },
    volume5m: 1000,
    volume1h: 50_000,
    volume24h: 50_000,
    priceChange: { m5: 1, h1: 10, h6: 10, h24: 10 },
    txns: { m5: { buys: 10, sells: 8 }, h1: { buys: 100, sells: 80 }, h6: { buys: 100, sells: 80 }, h24: { buys: 100, sells: 80 } },
    holders: 500,
    top10Pct: 25,
    mintAuthority: null,
    freezeAuthority: null,
    fetchedAt: "2026-09-28T12:00:00.000Z",
    ...over,
  } as TokenSnapshot;
}

function cand(over: Partial<ScoreCandidate> = {}): ScoreCandidate {
  const series = Array.from({ length: 15 }, (_, i) =>
    snap({ priceUsd: 1 + i * 0.01, fetchedAt: `2026-09-28T${String(i).padStart(2, "0")}:00:00.000Z` }),
  );
  return {
    mint: "MINT",
    symbol: "TST",
    name: "Test",
    chain: "solana",
    series,
    catalystScore: 20,
    narrativeAccelRatio: null,
    blocklisted: false,
    volumeZScore5m: 1.5,
    ...over,
  };
}

describe("score interne", () => {
  it("élimine sur autorité mint active même si le reste est fort", () => {
    const s = scoreCandidate(cand({ series: [snap({ mintAuthority: "SOMEADDR" })] }));
    expect(s.eliminated).toBe(true);
    expect(s.eliminationReason).toContain("securite");
  });

  it("élimine sur dev blocklisté", () => {
    const s = scoreCandidate(cand({ blocklisted: true }));
    expect(s.eliminated).toBe(true);
    expect(s.eliminationReason).toContain("onchain");
  });

  it("marque INCONNU sans éliminer quand les données manquent", () => {
    const s = scoreCandidate(
      cand({ series: [snap({ mintAuthority: "UNKNOWN", freezeAuthority: "UNKNOWN", holders: null, top10Pct: 100 })] }),
    );
    expect(s.eliminated).toBe(false);
    const missing = s.dimensions.filter((d) => d.missing).map((d) => d.dimension);
    expect(missing).toContain("securite");
    expect(s.coverage).toBeLessThan(1);
  });

  it("composite borné 0..100 et couverture cohérente", () => {
    const s = scoreCandidate(cand());
    expect(s.composite).toBeGreaterThanOrEqual(0);
    expect(s.composite).toBeLessThanOrEqual(100);
    expect(s.coverage).toBeGreaterThan(0);
    expect(s.coverage).toBeLessThanOrEqual(1);
    expect(s.disclaimer).toContain("jamais une garantie");
  });
});

describe("ledger", () => {
  function decision(over: Partial<PaperDecision> = {}): PaperDecision {
    return {
      id: "PE-0001",
      kind: "trade",
      createdAt: "2026-09-28T12:00:00.000Z",
      cycleId: "001",
      token: { mint: "MINT", symbol: "TST", name: "Test", chain: "solana" },
      setup: "volume-zscore",
      entryPriceUsd: 1,
      entryAt: "2026-09-28T12:00:00.000Z",
      reason: "test",
      invalidation: "stop",
      stopPriceUsd: 0.8,
      stopPct: 20,
      targets: [],
      sizeUsd: 500,
      riskUsd: 100,
      riskPct: 1,
      rewardRiskRatio: 1.5,
      cancelConditions: [],
      marketRegime: "SIDEWAYS",
      score: null,
      unknowns: [],
      noTradeReason: null,
      status: "open",
      marketCapUsdAtEntry: 800_000,
      ...over,
    };
  }

  it("open → close → métriques", () => {
    const root = mkTmp();
    openDecision(root, decision());
    closeDecision(root, {
      decisionId: "PE-0001",
      closedAt: "2026-09-28T13:00:00.000Z",
      exitPriceUsd: 1.3,
      resultPct: 28.7,
      resultR: 1.43,
      drawdownPct: 0,
      durationMin: 60,
      mfe: 1.35,
      mae: 0.95,
      exitReason: "tp1",
      setup: "volume-zscore",
      marketConditions: "SIDEWAYS",
      error: "aucune",
      partialExits: [],
    });
    const { closed } = loadLedger(root);
    expect(closed).toHaveLength(1);
    const m = computeMetrics(root);
    expect(m.trades).toBe(1);
    expect(m.winRate).toBe(1);
    expect(m.averageR).toBeCloseTo(1.43, 5);
    expect(m.bySetup["volume-zscore"]?.trades).toBe(1);
    expect(m.byMarketCap["300 k$ – 1 M$"]?.trades).toBe(1);
  });

  it("drawdown après une perte", () => {
    const root = mkTmp();
    openDecision(root, decision({ id: "PE-0001" }));
    closeDecision(root, {
      decisionId: "PE-0001",
      closedAt: "2026-09-28T13:00:00.000Z",
      exitPriceUsd: 0.8,
      resultPct: -21.3,
      resultR: -1.06,
      drawdownPct: 0,
      durationMin: 60,
      mfe: 1.02,
      mae: 0.79,
      exitReason: "stop",
      setup: "s",
      marketConditions: "SIDEWAYS",
      error: "aucune",
      partialExits: [],
    });
    // perte de 21.3 % sur 500 $ = -106.5 $ sur 10 000 $ → drawdown ≈ 1.07 %
    expect(currentDrawdownPct(root)).toBeCloseTo(1.065, 2);
  });

  it("nextDecisionId incrémente", () => {
    const root = mkTmp();
    expect(nextDecisionId(root)).toBe("PE-0001");
    openDecision(root, decision({ id: "PE-0001" }));
    expect(nextDecisionId(root)).toBe("PE-0002");
  });
});

describe("config / régime", () => {
  it("RISK OFF bloque les nouvelles positions", () => {
    expect(adaptationForRegime("RISK OFF").noNewTrades).toBe(true);
  });
  it("INCONNU ne change pas les règles de sécurité", () => {
    const a = adaptationForRegime("INCONNU");
    expect(a.noNewTrades).toBe(false);
    expect(a.minScore).toBe(60);
  });
  it("determineRegime → INCONNU sans données", () => {
    const root = mkTmp();
    const r = determineRegime(root);
    expect(r.regime).toBe("INCONNU");
  });
});

describe("learn", () => {
  it("proposeAdjustment rejette les petites séries", () => {
    const root = mkTmp();
    const p = proposeAdjustment(root, {
      parameter: "minScore",
      before: "60",
      after: "70",
      evidence: "impression",
      validation: "aucune",
      evidenceTrades: 12,
      validationTrades: 0,
      validationPositive: false,
    });
    expect(p.valid).toBe(false);
    expect(p.rejectionReason).toContain("n=12");
  });

  it("analyzeBlock ne propose rien sous n=30", () => {
    const a = analyzeBlock([]);
    expect(a.blockSize).toBe(0);
    expect(a.notes.join(" ")).toContain("AUCUN ajustement");
  });
});

describe("simulateClose", () => {
  function bars(prices: number[]): (TokenSnapshot & { fetchedAt: string })[] {
    return prices.map((p, i) => ({
      ...snap({ priceUsd: p, fetchedAt: `2026-09-28T${String(12 + i).padStart(2, "0")}:00:00.000Z` }),
      fetchedAt: `2026-09-28T${String(12 + i).padStart(2, "0")}:00:00.000Z`,
    }));
  }
  function dec(): PaperDecision {
    return {
      id: "PE-0001",
      kind: "trade",
      createdAt: "2026-09-28T12:00:00.000Z",
      cycleId: "001",
      token: { mint: "M", symbol: "T", name: "T", chain: "solana" },
      setup: "s",
      entryPriceUsd: 1,
      entryAt: "2026-09-28T12:00:00.000Z",
      reason: "t",
      invalidation: "stop",
      stopPriceUsd: 0.8,
      stopPct: 20,
      targets: [
        { label: "TP1", priceUsd: 1.3, pct: 30, exitShare: 0.5 },
        { label: "TP2", priceUsd: 1.8, pct: 80, exitShare: 0.3 },
        { label: "TP3", priceUsd: 3.0, pct: 200, exitShare: 0.2 },
      ],
      sizeUsd: 500,
      riskUsd: 100,
      riskPct: 1,
      rewardRiskRatio: 1.5,
      cancelConditions: [],
      marketRegime: "SIDEWAYS",
      score: null,
      unknowns: [],
      noTradeReason: null,
      status: "open",
      marketCapUsdAtEntry: null,
    };
  }

  it("stop d'abord (conservateur) quand le prix chute", () => {
    const b = bars([1, 0.9, 0.75, 0.7]);
    const { close } = simulateClose(b, 0, dec(), 20);
    expect(close.exitReason).toBe("stop");
    expect(close.resultPct).toBeLessThan(0);
    expect(close.mae).toBeLessThan(1);
  });

  it("sorties partielles sur TP1 puis TP2", () => {
    const b = bars([1, 1.1, 1.35, 1.85, 1.9]);
    const { close } = simulateClose(b, 0, dec(), 20);
    expect(close.exitReason).toBe("time_stop");
    expect(close.partialExits?.map((e) => e.level)).toEqual(["tp1", "tp2", "time_stop"]);
    expect(close.resultPct).toBeGreaterThan(0);
    expect(close.mfe).toBeGreaterThan(1.3);
  });
});
