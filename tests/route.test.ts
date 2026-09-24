import { describe, expect, it } from "vitest";
import { ROUTE_THRESHOLDS, explainRoute, route, type RouteInput } from "../lab/decide/route.ts";
import { TRADE_VS_BUILD_CRITERIA, tradeVsBuild, type Criterion, type Score15, type TradeVsBuildInput } from "../lab/decide/tradeVsBuild.ts";

const good = (over: Partial<RouteInput> = {}): RouteInput => ({
  score: { score: 75, coverage: 0.9, missing: [] },
  crossCheck: { convergence: 3, conviction: "MOYENNE", families: ["human", "market", "onchain"] },
  redteam: { verdict: "OK", vetoes: [], unknownHard: [], overridden: false },
  riskPreview: { allowed: true, reasons: [] },
  ...over,
});

const grid = (trade: Score15, build: Score15, over: Partial<Record<Criterion, { trade: Score15; build: Score15 }>> = {}): TradeVsBuildInput =>
  Object.fromEntries(TRADE_VS_BUILD_CRITERIA.map((c) => [c, over[c] ?? { trade, build }])) as TradeVsBuildInput;

describe("route — la hiérarchie RISK > TRADING > STRATEGY > CLAUDE", () => {
  it("tout est vert → MEMECOIN_TRADE (défaut) ou CRYPTO_TRADE selon la classe d'actif", () => {
    expect(route(good())).toBe("MEMECOIN_TRADE");
    expect(route(good({ assetClass: "crypto" }))).toBe("CRYPTO_TRADE");
    const r = explainRoute(good());
    expect(r.tradeAllowed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.explanation).toMatch(/l'exécuteur ré-évaluera localement/);
  });

  it("le Risk Engine (aperçu) refuse → NO_TRADE même avec score 100 et conviction FORTE", () => {
    const r = explainRoute(good({ score: { score: 100, coverage: 1, missing: [] }, crossCheck: { convergence: 5, conviction: "FORTE", families: [] }, riskPreview: { allowed: false, reasons: ["PERTE_QUOTIDIENNE: x"] } }));
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reasons).toEqual(["RISQUE_REFUS: PERTE_QUOTIDIENNE: x"]);
  });

  it("red team NO_TRADE → NO_TRADE, avec les vetos et inconnus durs dans les raisons", () => {
    const r = explainRoute(good({ redteam: { verdict: "NO_TRADE", vetoes: ["mintFreezeAuthority"], unknownHard: ["honeypot"], overridden: false } }));
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reasons.join()).toMatch(/REDTEAM_VETO: mintFreezeAuthority, honeypot inconnu/);
  });

  it("conviction FAIBLE (1 famille) → NO_TRADE quel que soit le score", () => {
    expect(route(good({ score: { score: 99, coverage: 1, missing: [] }, crossCheck: { convergence: 1, conviction: "FAIBLE", families: ["market"] } }))).toBe("NO_TRADE");
  });

  it("score < 60 → NO_TRADE ; red team WARN relève le seuil à 70 ; seuils publics et surchargeables", () => {
    expect(ROUTE_THRESHOLDS).toEqual({ minScore: 60, minScoreWithWarnings: 70, minCoverage: 0.5 });
    expect(route(good({ score: { score: 59, coverage: 1, missing: [] } }))).toBe("NO_TRADE");
    expect(route(good({ score: { score: 60, coverage: 1, missing: [] } }))).toBe("MEMECOIN_TRADE");
    const warn = { verdict: "WARN" as const, vetoes: [], unknownHard: [], overridden: false };
    expect(explainRoute(good({ score: { score: 65, coverage: 1, missing: [] }, redteam: warn })).reasons.join()).toMatch(/SCORE_INSUFFISANT: 65 < 70 \(red team WARN\)/);
    expect(route(good({ score: { score: 70, coverage: 1, missing: [] }, redteam: warn }))).toBe("MEMECOIN_TRADE");
    expect(route(good({ score: { score: 65, coverage: 1, missing: [] }, redteam: warn, thresholds: { minScoreWithWarnings: 65 } }))).toBe("MEMECOIN_TRADE");
  });

  it("couverture du score < 50 % → NO_TRADE (un score sans données n'est pas un score)", () => {
    const r = explainRoute(good({ score: { score: 80, coverage: 0.4, missing: ["momentum"] } }));
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reasons.join()).toMatch(/COUVERTURE_INSUFFISANTE: 40 %/);
  });

  it("entrées manquantes → NO_TRADE motivé, jamais d'exception", () => {
    const r = explainRoute({} as RouteInput);
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reasons).toEqual(["RISQUE_INCONNU: aucun aperçu du Risk Engine", "REDTEAM_ABSENT: checklist non exécutée", "CROSSCHECK_ABSENT", "SCORE_ABSENT"]);
    expect(route(undefined as unknown as RouteInput)).toBe("NO_TRADE");
  });

  it("toutes les raisons de refus sont accumulées", () => {
    const r = explainRoute(good({ score: { score: 10, coverage: 0.2, missing: [] }, crossCheck: { convergence: 0, conviction: "FAIBLE", families: [] }, riskPreview: { allowed: false, reasons: [] } }));
    expect(r.reasons).toHaveLength(4);
  });
});

describe("route — TRADE vs BUILD", () => {
  it("grille BUILD + trade autorisé → TRADE_AND_BUILD ; grille BUILD + trade refusé → BUILD", () => {
    const build = tradeVsBuild(grid(2, 5));
    expect(build.decision).toBe("BUILD");
    expect(route(good({ tradeVsBuild: build }))).toBe("TRADE_AND_BUILD");
    expect(route(good({ tradeVsBuild: build, riskPreview: { allowed: false, reasons: ["x"] } }))).toBe("BUILD");
  });

  it("grille TRADE ou NO_ACTION ne recommande jamais de construire ; un refus de trade ne devient pas un BUILD", () => {
    expect(route(good({ tradeVsBuild: tradeVsBuild(grid(5, 2)) }))).toBe("MEMECOIN_TRADE");
    expect(route(good({ tradeVsBuild: tradeVsBuild(grid(1, 1)) }))).toBe("MEMECOIN_TRADE");
    expect(route(good({ tradeVsBuild: tradeVsBuild(grid(2, 2)), riskPreview: { allowed: false, reasons: [] } }))).toBe("NO_TRADE");
    expect(route(good({ tradeVsBuild: null }))).toBe("MEMECOIN_TRADE");
  });

  it("grille TRADE_AND_BUILD + trade autorisé → TRADE_AND_BUILD", () => {
    const both = tradeVsBuild(grid(4, 4));
    expect(both.decision).toBe("TRADE_AND_BUILD");
    expect(explainRoute(good({ tradeVsBuild: both })).buildRecommended).toBe(true);
    expect(route(good({ tradeVsBuild: both }))).toBe("TRADE_AND_BUILD");
  });
});

describe("tradeVsBuild — grille à 12 critères", () => {
  it("12 critères, notes 1..5, totaux sur 60, seuils explicites (60 % viable, 10 % de marge)", () => {
    expect(TRADE_VS_BUILD_CRITERIA).toHaveLength(12);
    const r = tradeVsBuild(grid(4, 3));
    expect(r.maxTotal).toBe(60);
    expect(r.tradeTotal).toBe(48);
    expect(r.buildTotal).toBe(36);
    expect(r.thresholds).toEqual({ minScore: 36, margin: 6, minScorePct: 60, marginPct: 10 });
    expect(r.decision).toBe("TRADE"); // 48 − 36 = 12 ≥ 6
    expect(r.rows).toHaveLength(12);
    expect(r.explanation).toMatch(/TRADE — trade 48\/60 \(viable\), build 36\/60 \(viable\)/);
  });

  it("les deux viables et proches → TRADE_AND_BUILD ; aucune viable → NO_ACTION", () => {
    expect(tradeVsBuild(grid(4, 4, { vitesse: { trade: 5, build: 4 } })).decision).toBe("TRADE_AND_BUILD");
    expect(tradeVsBuild(grid(2, 2)).decision).toBe("NO_ACTION");
    expect(tradeVsBuild(grid(3, 3)).decision).toBe("TRADE_AND_BUILD"); // 36 = seuil exact
    expect(tradeVsBuild(grid(3, 3), { minScorePct: 61 }).decision).toBe("NO_ACTION");
  });

  it("veto : « risque » ou « capital » noté 1 rend l'option non viable malgré un bon total", () => {
    const r = tradeVsBuild(grid(5, 5, { risque: { trade: 1, build: 5 } }));
    expect(r.tradeViable).toBe(false);
    expect(r.vetoes).toEqual([{ option: "trade", criterion: "risque" }]);
    expect(r.decision).toBe("BUILD");
    expect(tradeVsBuild(grid(5, 5, { capital: { trade: 5, build: 1 } })).decision).toBe("TRADE");
    expect(tradeVsBuild(grid(5, 5, { capital: { trade: 1, build: 1 } })).decision).toBe("NO_ACTION");
  });

  it("poids par critère et notes invalides", () => {
    const weighted = tradeVsBuild(grid(3, 3, { potentiel: { trade: 5, build: 1 } }), { weights: { potentiel: 5 } });
    expect(weighted.maxTotal).toBe(80);
    expect(weighted.tradeTotal).toBe(33 + 25);
    expect(weighted.decision).toBe("TRADE");
    const bad = tradeVsBuild({ ...grid(3, 3), risque: { trade: 6 as Score15, build: 0.5 as Score15 } });
    expect(bad.decision).toBe("NO_ACTION");
    expect(bad.problems.join()).toMatch(/critère risque/);
    expect(tradeVsBuild(null as unknown as TradeVsBuildInput).decision).toBe("NO_ACTION");
  });
});
