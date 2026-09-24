import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS, NORMALIZERS, SCORE_VARIABLES, scoreToken, weightsProblems, type ScoreInput, type ScoreWeights } from "../lab/signals/score.ts";
import { REPO_ROOT } from "./execFixtures.ts";

/** Entrée complète et favorable : toutes les variables renseignées. */
const FULL: ScoreInput = {
  tokenAgeHours: 2,
  volumeZScore5m: 4,
  volume1hUsd: 200_000,
  washTradingShare: 0.1,
  liquidityUsd: 150_000,
  buyShare1h: 0.7,
  qualityWalletShare: 0.4,
  top10Pct: 20,
  humanMentions24h: 120,
  holdersGrowth1hPct: 30,
  devCommits7d: 10,
  narrativeAccelRatio: 3,
  botShare: 0.2,
  paidPromotion: false,
  mintAuthority: null,
  freezeAuthority: null,
  riskyExtensions: [],
  lpLockedShare: 0.9,
  narrativeAgeHours: 12,
  priceChange1hPct: 25,
  rewardRiskRatio: 1.6,
  strategyExpectancy: 0.08,
  strategyTradeCount: 45,
};

describe("scoreToken — structure et déterminisme", () => {
  it("renvoie un score entier 0..100, 17 lignes de détail, et est déterministe", () => {
    const a = scoreToken(FULL);
    const b = scoreToken(JSON.parse(JSON.stringify(FULL)) as ScoreInput);
    expect(a).toEqual(b);
    expect(Number.isInteger(a.score)).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(100);
    expect(a.breakdown).toHaveLength(17);
    expect(a.breakdown.map((r) => r.variable)).toEqual([...SCORE_VARIABLES]);
    expect(a.missing).toEqual([]);
    expect(a.coverage).toBe(1);
    expect(a.weightsVersion).toBe(DEFAULT_WEIGHTS.version);
  });

  it("le score est la somme des contributions, chaque contribution = normalized × weight × 100 / Σ weights", () => {
    const r = scoreToken(FULL);
    const total = SCORE_VARIABLES.reduce((s, v) => s + DEFAULT_WEIGHTS.variables[v].weight, 0);
    for (const row of r.breakdown) {
      expect(row.contribution).toBeCloseTo((row.normalized * row.weight * 100) / total, 1);
      expect(row.normalized).toBeGreaterThanOrEqual(0);
      expect(row.normalized).toBeLessThanOrEqual(1);
      expect(row.method.length).toBeGreaterThan(0);
    }
    expect(r.score).toBe(Math.round(r.breakdown.reduce((s, row) => s + row.contribution, 0)));
  });

  it("bornes : entrée vide → 0 avec les 17 variables manquantes ; entrée maximale → 100", () => {
    const empty = scoreToken({});
    expect(empty.score).toBe(0);
    expect(empty.missing).toHaveLength(17);
    expect(empty.coverage).toBe(0);
    expect(empty.explanation).toMatch(/Aucune variable renseignée/);
    const max = scoreToken({
      ...FULL,
      tokenAgeHours: 0.5,
      volumeZScore5m: 10,
      volume1hUsd: 5_000_000,
      washTradingShare: 0,
      liquidityUsd: 2_000_000,
      buyShare1h: 1,
      qualityWalletShare: 1,
      top10Pct: 0,
      humanMentions24h: 10_000,
      holdersGrowth1hPct: 100,
      devCommits7d: 50,
      narrativeAccelRatio: 10,
      botShare: 0,
      lpLockedShare: 1,
      narrativeAgeHours: 1,
      priceChange1hPct: 100,
      rewardRiskRatio: 5,
      strategyExpectancy: 1,
    });
    expect(max.score).toBe(100);
    expect(max.breakdown.every((r) => r.normalized === 1)).toBe(true);
  });

  it("variables absentes = 0 ET listées dans missing, avec la couverture correspondante", () => {
    const r = scoreToken({ liquidityUsd: 150_000, top10Pct: 20 });
    expect(r.missing).toHaveLength(15);
    expect(r.missing).not.toContain("liquidity");
    expect(r.missing).not.toContain("concentration");
    const liq = r.breakdown.find((b) => b.variable === "liquidity")!;
    expect(liq.missing).toBe(false);
    expect(liq.raw).toBe(150_000);
    const missingRow = r.breakdown.find((b) => b.variable === "momentum")!;
    expect(missingRow).toMatchObject({ missing: true, raw: null, normalized: 0, contribution: 0 });
    const total = SCORE_VARIABLES.reduce((s, v) => s + DEFAULT_WEIGHTS.variables[v].weight, 0);
    expect(r.coverage).toBeCloseTo((DEFAULT_WEIGHTS.variables.liquidity.weight + DEFAULT_WEIGHTS.variables.concentration.weight) / total, 3);
    expect(r.explanation).toMatch(/Absentes \(comptées 0\)/);
  });

  it("des valeurs absurdes (NaN, Infinity, négatives, hors bornes) sont traitées comme absentes, jamais d'exception", () => {
    const r = scoreToken({ tokenAgeHours: -1, volumeZScore5m: NaN, liquidityUsd: Infinity, buyShare1h: 2, top10Pct: 150, qualityWalletShare: -0.1, strategyExpectancy: 0.5, strategyTradeCount: 29 });
    expect(r.score).toBe(0);
    expect(r.missing).toHaveLength(17);
    expect(scoreToken(null as unknown as ScoreInput).score).toBe(0);
  });
});

describe("scoreToken — méthodes de normalisation (documentées)", () => {
  it("nouveauté : 1 h → 1, 72 h → 0, 36,5 h → 0,5", () => {
    expect(NORMALIZERS.novelty({ tokenAgeHours: 1 })!.normalized).toBe(1);
    expect(NORMALIZERS.novelty({ tokenAgeHours: 72 })!.normalized).toBe(0);
    expect(NORMALIZERS.novelty({ tokenAgeHours: 36.5 })!.normalized).toBeCloseTo(0.5, 6);
  });

  it("liquidité : ≤ 20 k$ → 0, 1 M$ → 1, log-linéaire entre les deux", () => {
    expect(NORMALIZERS.liquidity({ liquidityUsd: 20_000 })!.normalized).toBe(0);
    expect(NORMALIZERS.liquidity({ liquidityUsd: 1_000_000 })!.normalized).toBeCloseTo(1, 6);
    const mid = NORMALIZERS.liquidity({ liquidityUsd: Math.sqrt(20_000 * 1_000_000) })!.normalized;
    expect(mid).toBeCloseTo(0.5, 6);
  });

  it("volume réel : exige la part de wash trading ; volume × (1 − wash)", () => {
    expect(NORMALIZERS.realVolume({ volume1hUsd: 100_000 })).toBeNull();
    const r = NORMALIZERS.realVolume({ volume1hUsd: 100_000, washTradingShare: 0.5 })!;
    expect(r.raw).toBe(50_000);
    expect(r.normalized).toBeCloseTo(Math.log10(50_001) / 6, 6);
  });

  it("rug (inversé) : autorité présente ou extension risquée → 0 ; autorités révoquées mais LP inconnue → absente", () => {
    expect(NORMALIZERS.rugRisk({ mintAuthority: "X", freezeAuthority: null, lpLockedShare: 1 })!.normalized).toBe(0);
    expect(NORMALIZERS.rugRisk({ mintAuthority: null, freezeAuthority: null, riskyExtensions: ["transferFee"], lpLockedShare: 1 })!.normalized).toBe(0);
    expect(NORMALIZERS.rugRisk({ mintAuthority: null, freezeAuthority: null })).toBeNull();
    expect(NORMALIZERS.rugRisk({ lpLockedShare: 1 })).toBeNull();
    expect(NORMALIZERS.rugRisk({ mintAuthority: null, freezeAuthority: null, riskyExtensions: [], lpLockedShare: 0.8 })!.normalized).toBe(0.8);
  });

  it("manipulation (inversée) : max(wash, bots, boost payé 0,5) ; concentration : 1 − top10/50", () => {
    expect(NORMALIZERS.manipulationRisk({ washTradingShare: 0.2, botShare: 0.6 })!.normalized).toBeCloseTo(0.4, 6);
    expect(NORMALIZERS.manipulationRisk({ paidPromotion: true })!.normalized).toBe(0.5);
    expect(NORMALIZERS.manipulationRisk({})).toBeNull();
    expect(NORMALIZERS.concentration({ top10Pct: 25 })!.normalized).toBe(0.5);
    expect(NORMALIZERS.concentration({ top10Pct: 60 })!.normalized).toBe(0);
  });

  it("performance historique : absente sous n < 30 (aucun score sans données)", () => {
    expect(NORMALIZERS.strategyTrackRecord({ strategyExpectancy: 0.1, strategyTradeCount: 29 })).toBeNull();
    expect(NORMALIZERS.strategyTrackRecord({ strategyExpectancy: 0.1, strategyTradeCount: 30 })!.normalized).toBeCloseTo(0.5, 6);
    expect(NORMALIZERS.strategyTrackRecord({ strategyExpectancy: -0.1, strategyTradeCount: 50 })!.normalized).toBe(0);
  });
});

describe("score.weights.json — poids versionnés", () => {
  it("le fichier est valide, couvre exactement les 17 variables, chacune avec une méthode", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "lab", "signals", "score.weights.json"), "utf8")) as ScoreWeights;
    expect(weightsProblems(raw)).toEqual([]);
    expect(Object.keys(raw.variables).sort()).toEqual([...SCORE_VARIABLES].sort());
    expect(raw.version).toBeGreaterThanOrEqual(1);
  });

  it("des poids invalides sont refusés (variable manquante, poids négatif, variable inconnue, somme nulle)", () => {
    const base = JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)) as ScoreWeights;
    const noVar = JSON.parse(JSON.stringify(base)) as ScoreWeights;
    delete (noVar.variables as Partial<typeof noVar.variables>).momentum;
    expect(weightsProblems(noVar).join()).toMatch(/momentum/);
    expect(weightsProblems({ ...base, variables: { ...base.variables, novelty: { ...base.variables.novelty, weight: -1 } } }).join()).toMatch(/novelty/);
    expect(weightsProblems({ ...base, variables: { ...base.variables, luck: { weight: 1, label: "x", method: "y" } } }).join()).toMatch(/variable inconnue luck/);
    const zero = JSON.parse(JSON.stringify(base)) as ScoreWeights;
    for (const v of SCORE_VARIABLES) zero.variables[v].weight = 0;
    expect(weightsProblems(zero).join()).toMatch(/somme nulle/);
    expect(() => scoreToken(FULL, zero)).toThrow(/Poids de score invalides/);
  });

  it("des poids injectés changent le score de façon prévisible (transparence)", () => {
    const only = JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)) as ScoreWeights;
    for (const v of SCORE_VARIABLES) only.variables[v].weight = v === "liquidity" ? 1 : 0;
    expect(scoreToken({ liquidityUsd: 1_000_000 }, only).score).toBe(100);
    expect(scoreToken({ liquidityUsd: 20_000 }, only).score).toBe(0);
  });

  it("ni le code, ni les poids, ni les sorties ne parlent de « probabilité »", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "lab", "signals", "score.ts"), "utf8");
    const weights = fs.readFileSync(path.join(REPO_ROOT, "lab", "signals", "score.weights.json"), "utf8");
    expect(src.toLowerCase()).not.toMatch(/probabilit/);
    expect(weights.toLowerCase()).not.toMatch(/probabilit/);
    expect(JSON.stringify(scoreToken(FULL)).toLowerCase()).not.toMatch(/probabilit/);
  });
});
