// Score 0–100 transparent (chantier 4). Fonction pure et déterministe : même entrée → même score.
//
// Principe : 17 variables du mandat, chacune normalisée 0..1 par une méthode documentée (score.weights.json + normalizers
// ci-dessous), pondérée par un poids public et versionné. Une variable absente vaut 0 ET est listée dans `missing[]` :
// un score élevé avec beaucoup de variables manquantes est un score qu'on ne devrait pas croire, et on le voit.
// Le score est un CLASSEMENT explicable, jamais une estimation de chance de succès.

import DEFAULT_WEIGHTS_JSON from "./score.weights.json" with { type: "json" };

export const SCORE_VARIABLES = [
  "novelty",
  "velocity",
  "realVolume",
  "liquidity",
  "orderFlow",
  "walletQuality",
  "concentration",
  "humanTraction",
  "onchainTraction",
  "devActivity",
  "narrative",
  "manipulationRisk",
  "rugRisk",
  "narrativeDistance",
  "momentum",
  "asymmetry",
  "strategyTrackRecord",
] as const;

export type ScoreVariable = (typeof SCORE_VARIABLES)[number];

export interface WeightSpec {
  weight: number;
  label: string;
  method: string;
}

export interface ScoreWeights {
  version: number;
  variables: Record<ScoreVariable, WeightSpec>;
}

/** Données brutes d'entrée. Tout est optionnel : ce qui manque vaut 0 et est signalé. */
export interface ScoreInput {
  /** Âge du token (heures). */
  tokenAgeHours?: number;
  /** z-score du volume 5 min (lab/signals/volume.ts). */
  volumeZScore5m?: number;
  /** Volume 1 h en USD. */
  volume1hUsd?: number;
  /** Part estimée de wash trading dans le volume, 0..1 (0 si inconnue mais volume connu → variable partielle, voir notes). */
  washTradingShare?: number;
  liquidityUsd?: number;
  /** Part des achats dans le volume 1 h, 0..1. */
  buyShare1h?: number;
  /** Part des premiers acheteurs qui sont des wallets suivis gagnants, 0..1. */
  qualityWalletShare?: number;
  /** Part des 10 plus gros porteurs, 0..100. */
  top10Pct?: number;
  /** Mentions humaines sur 24 h. */
  humanMentions24h?: number;
  /** Croissance des holders sur 1 h, en %. */
  holdersGrowth1hPct?: number;
  /** Commits publics sur 7 jours. */
  devCommits7d?: number;
  /** Accélération du narratif : taux 24 h / taux 7 j. */
  narrativeAccelRatio?: number;
  /** Part des transactions attribuées à des bots, 0..1. */
  botShare?: number;
  /** Boost payé / promotion payante active. */
  paidPromotion?: boolean;
  /** Autorités (null = révoquée). `undefined` = inconnu. */
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  /** Extensions Token-2022 risquées détectées ([] = aucune ; undefined = inconnu). */
  riskyExtensions?: string[];
  /** Part de la liquidité verrouillée ou brûlée, 0..1. */
  lpLockedShare?: number;
  /** Heures depuis le premier signal du narratif. */
  narrativeAgeHours?: number;
  /** Variation de prix sur 1 h, en %. */
  priceChange1hPct?: number;
  /** Ratio objectif / stop (ex. 0.40 / 0.25 = 1.6). */
  rewardRiskRatio?: number;
  /** Performance historique de la stratégie émettrice : espérance nette par trade (fraction) et nombre de trades. */
  strategyExpectancy?: number;
  strategyTradeCount?: number;
}

export interface ScoreBreakdownRow {
  variable: ScoreVariable;
  label: string;
  /** Valeur brute utilisée (null si absente). */
  raw: number | string | null;
  normalized: number;
  weight: number;
  /** Points apportés au score sur 100. */
  contribution: number;
  method: string;
  /** Vrai si la variable était absente (normalized = 0). */
  missing: boolean;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdownRow[];
  missing: ScoreVariable[];
  explanation: string;
  weightsVersion: number;
  /** Part du poids total couverte par des variables présentes, 0..1 (couverture des données). */
  coverage: number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (x: number, d = 3): number => Math.round(x * 10 ** d) / 10 ** d;

/** Résultat d'un normaliseur : la valeur brute retenue et sa version 0..1, ou null si la donnée manque. */
type Norm = { raw: number | string; normalized: number } | null;

/**
 * Normaliseurs : un par variable, purs, documentés dans score.weights.json (le code fait foi).
 * Retour null = variable absente.
 */
export const NORMALIZERS: Record<ScoreVariable, (i: ScoreInput) => Norm> = {
  novelty: (i) => (num(i.tokenAgeHours) && i.tokenAgeHours >= 0 ? { raw: i.tokenAgeHours, normalized: clamp01(1 - (i.tokenAgeHours - 1) / 71) } : null),
  velocity: (i) => (num(i.volumeZScore5m) ? { raw: i.volumeZScore5m, normalized: clamp01(i.volumeZScore5m / 5) } : null),
  realVolume: (i) => {
    if (!num(i.volume1hUsd) || i.volume1hUsd < 0 || !num(i.washTradingShare)) return null;
    const real = i.volume1hUsd * (1 - clamp01(i.washTradingShare));
    return { raw: round(real, 2), normalized: clamp01(Math.log10(1 + real) / 6) };
  },
  liquidity: (i) => (num(i.liquidityUsd) && i.liquidityUsd >= 0 ? { raw: i.liquidityUsd, normalized: i.liquidityUsd <= 20_000 ? 0 : clamp01(Math.log10(i.liquidityUsd / 20_000) / Math.log10(50)) } : null),
  orderFlow: (i) => (num(i.buyShare1h) && i.buyShare1h >= 0 && i.buyShare1h <= 1 ? { raw: i.buyShare1h, normalized: clamp01((i.buyShare1h - 0.5) * 2) } : null),
  walletQuality: (i) => (num(i.qualityWalletShare) && i.qualityWalletShare >= 0 && i.qualityWalletShare <= 1 ? { raw: i.qualityWalletShare, normalized: i.qualityWalletShare } : null),
  concentration: (i) => (num(i.top10Pct) && i.top10Pct >= 0 && i.top10Pct <= 100 ? { raw: i.top10Pct, normalized: clamp01(1 - i.top10Pct / 50) } : null),
  humanTraction: (i) => (num(i.humanMentions24h) && i.humanMentions24h >= 0 ? { raw: i.humanMentions24h, normalized: clamp01(Math.log10(1 + i.humanMentions24h) / 3) } : null),
  onchainTraction: (i) => (num(i.holdersGrowth1hPct) ? { raw: i.holdersGrowth1hPct, normalized: clamp01(i.holdersGrowth1hPct / 50) } : null),
  devActivity: (i) => (num(i.devCommits7d) && i.devCommits7d >= 0 ? { raw: i.devCommits7d, normalized: clamp01(i.devCommits7d / 20) } : null),
  narrative: (i) => (num(i.narrativeAccelRatio) && i.narrativeAccelRatio >= 0 ? { raw: i.narrativeAccelRatio, normalized: clamp01((i.narrativeAccelRatio - 1) / 4) } : null),
  manipulationRisk: (i) => {
    if (!num(i.washTradingShare) && !num(i.botShare) && typeof i.paidPromotion !== "boolean") return null;
    const risk = Math.max(num(i.washTradingShare) ? clamp01(i.washTradingShare) : 0, num(i.botShare) ? clamp01(i.botShare) : 0, i.paidPromotion === true ? 0.5 : 0);
    return { raw: round(risk), normalized: clamp01(1 - risk) };
  },
  rugRisk: (i) => {
    const authoritiesKnown = i.mintAuthority !== undefined && i.freezeAuthority !== undefined;
    if (!authoritiesKnown) return null;
    if (i.mintAuthority || i.freezeAuthority) return { raw: "autorité présente", normalized: 0 };
    if (Array.isArray(i.riskyExtensions) && i.riskyExtensions.length > 0) return { raw: `extensions: ${i.riskyExtensions.join(",")}`, normalized: 0 };
    if (!num(i.lpLockedShare)) return null; // autorités OK mais LP inconnue : on ne devine pas
    return { raw: clamp01(i.lpLockedShare), normalized: clamp01(i.lpLockedShare) };
  },
  narrativeDistance: (i) => (num(i.narrativeAgeHours) && i.narrativeAgeHours >= 0 ? { raw: i.narrativeAgeHours, normalized: clamp01(1 - (i.narrativeAgeHours - 6) / 66) } : null),
  momentum: (i) => (num(i.priceChange1hPct) ? { raw: i.priceChange1hPct, normalized: clamp01(i.priceChange1hPct / 50) } : null),
  asymmetry: (i) => (num(i.rewardRiskRatio) && i.rewardRiskRatio >= 0 ? { raw: i.rewardRiskRatio, normalized: clamp01((i.rewardRiskRatio - 1) / 3) } : null),
  strategyTrackRecord: (i) =>
    num(i.strategyExpectancy) && num(i.strategyTradeCount) && i.strategyTradeCount >= 30
      ? { raw: i.strategyExpectancy, normalized: clamp01(i.strategyExpectancy / 0.2) }
      : null,
};

/** Renvoie les problèmes d'un jeu de poids (vide si valide). */
export function weightsProblems(w: unknown): string[] {
  const problems: string[] = [];
  if (!w || typeof w !== "object") return ["poids : objet attendu"];
  const o = w as Record<string, unknown>;
  if (!num(o.version)) problems.push("poids : version manquante");
  const vars = o.variables as Record<string, unknown> | undefined;
  if (!vars || typeof vars !== "object") return [...problems, "poids : variables manquantes"];
  for (const v of SCORE_VARIABLES) {
    const spec = vars[v] as Partial<WeightSpec> | undefined;
    if (!spec || !num(spec.weight) || spec.weight < 0) problems.push(`poids : ${v}.weight doit être un nombre ≥ 0`);
    if (!spec || typeof spec.method !== "string" || spec.method.length === 0) problems.push(`poids : ${v}.method manquante`);
  }
  for (const k of Object.keys(vars)) if (!(SCORE_VARIABLES as readonly string[]).includes(k)) problems.push(`poids : variable inconnue ${k}`);
  const total = SCORE_VARIABLES.reduce((s, v) => s + ((vars[v] as WeightSpec | undefined)?.weight ?? 0), 0);
  if (problems.length === 0 && total <= 0) problems.push("poids : somme nulle");
  return problems;
}

export const DEFAULT_WEIGHTS: ScoreWeights = DEFAULT_WEIGHTS_JSON as ScoreWeights;

/**
 * Calcule le score. Pure, déterministe, ne lève que si les poids sont invalides (erreur de configuration, pas de données).
 */
export function scoreToken(input: ScoreInput, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoreResult {
  const wp = weightsProblems(weights);
  if (wp.length > 0) throw new Error(`Poids de score invalides :\n- ${wp.join("\n- ")}`);
  const totalWeight = SCORE_VARIABLES.reduce((s, v) => s + weights.variables[v].weight, 0);
  const safeInput: ScoreInput = input && typeof input === "object" ? input : {};

  const breakdown: ScoreBreakdownRow[] = [];
  const missing: ScoreVariable[] = [];
  let sum = 0;
  let coveredWeight = 0;
  for (const v of SCORE_VARIABLES) {
    const spec = weights.variables[v];
    const n = NORMALIZERS[v](safeInput);
    const normalized = n ? round(clamp01(n.normalized), 4) : 0;
    const contribution = round((normalized * spec.weight * 100) / totalWeight, 2);
    if (!n) missing.push(v);
    else coveredWeight += spec.weight;
    sum += contribution;
    breakdown.push({ variable: v, label: spec.label, raw: n ? n.raw : null, normalized, weight: spec.weight, contribution, method: spec.method, missing: !n });
  }
  const score = Math.max(0, Math.min(100, Math.round(sum)));
  const coverage = round(coveredWeight / totalWeight, 3);

  const top = [...breakdown].filter((r) => !r.missing).sort((a, b) => b.contribution - a.contribution).slice(0, 3);
  const weak = [...breakdown].filter((r) => !r.missing && r.normalized < 0.2).map((r) => r.label);
  const explanation =
    `Score ${score}/100 (poids v${weights.version}, couverture ${Math.round(coverage * 100)} % du poids total). ` +
    (top.length > 0 ? `Principaux apports : ${top.map((r) => `${r.label} ${r.contribution} pts (brut ${String(r.raw)})`).join(" ; ")}. ` : "Aucune variable renseignée. ") +
    (weak.length > 0 ? `Faibles : ${weak.join(", ")}. ` : "") +
    (missing.length > 0 ? `Absentes (comptées 0) : ${missing.map((m) => weights.variables[m].label).join(", ")}.` : "Toutes les variables sont renseignées.");

  return { score, breakdown, missing, explanation, weightsVersion: weights.version, coverage };
}
