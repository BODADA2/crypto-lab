/**
 * Types du moteur autonome de paper trading (§3 et §4 du cahier des charges).
 * Une simulation n'est jamais une transaction réelle : chaque objet porte son statut.
 */

/** Les 10 dimensions du score interne (§8). */
export const SCORE_DIMENSIONS = [
  "securite",
  "liquidite",
  "onchain",
  "momentum",
  "volume",
  "structure",
  "narratif",
  "catalyseur",
  "risque",
  "asymetrie",
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export interface DimensionResult {
  dimension: ScoreDimension;
  /** 0..100. 0 avec `critical=true` = élimination, même si les autres dimensions sont fortes. */
  score: number;
  weight: number;
  /** Vrai si la donnée manquait (INCONNU, jamais inventé). */
  missing: boolean;
  /** Risque critique : élimine le token quoi qu'il arrive (§8, §12). */
  critical: boolean;
  notes: string[];
}

export interface InternalScore {
  composite: number;
  dimensions: DimensionResult[];
  /** Part du poids total couverte par des données réelles, 0..1. */
  coverage: number;
  eliminated: boolean;
  eliminationReason: string | null;
  /** Rappel : classement relatif, jamais une garantie de rendement. */
  disclaimer: string;
}

export interface TokenRef {
  mint: string;
  symbol: string;
  name: string;
  chain: string;
}

export interface PriceTarget {
  label: "TP1" | "TP2" | "TP3";
  priceUsd: number;
  pct: number;
  /** Part de la position sortie à ce niveau. */
  exitShare: number;
}

/** Décision de paper trading (§3). `kind: "no_trade"` = décision valide, pas un échec. */
export interface PaperDecision {
  id: string;
  kind: "trade" | "no_trade";
  createdAt: string;
  cycleId: string;
  token: TokenRef;
  setup: string;
  /** Prix d'entrée simulé (après coûts). */
  entryPriceUsd: number | null;
  entryAt: string | null;
  reason: string;
  invalidation: string;
  stopPriceUsd: number | null;
  stopPct: number | null;
  targets: PriceTarget[];
  /** Taille de position virtuelle en $. */
  sizeUsd: number | null;
  riskUsd: number | null;
  riskPct: number | null;
  /** Ratio rendement/risque (TP1 / stop). */
  rewardRiskRatio: number | null;
  cancelConditions: string[];
  marketRegime: string;
  score: InternalScore | null;
  /** Données manquantes au moment de la décision (INCONNU explicite). */
  unknowns: string[];
  /** Market cap USD à l'entrée (null si inconnu) — pour les stats par market cap (§4). */
  marketCapUsdAtEntry: number | null;
  noTradeReason: string | null;
  status: "open" | "closed" | "cancelled";
}

export type ExitReason =
  | "stop"
  | "tp1"
  | "tp2"
  | "tp3"
  | "time_stop"
  | "invalidation"
  | "cancelled";

export interface DecisionClose {
  decisionId: string;
  closedAt: string;
  exitPriceUsd: number;
  /** Résultat net de coûts, en %. */
  resultPct: number;
  /** Résultat en R (resultPct / stopPct). */
  resultR: number;
  /** Drawdown de l'equity moteur au moment de la clôture, en %. */
  drawdownPct: number;
  durationMin: number;
  /** Excursion favorable maximale, en multiple (ex. 1.8 = +80 %). */
  mfe: number;
  /** Excursion défavorable maximale, en multiple. */
  mae: number;
  exitReason: ExitReason;
  setup: string;
  marketConditions: string;
  /** Erreur éventuelle (ex. "entrée tardive", "stop trop serré", "aucune"). */
  error: string;
  /** Détail des sorties partielles : [{niveau, part, prix}]. */
  partialExits: Array<{ level: string; share: number; priceUsd: number }>;
}

/** Décision enrichie de sa clôture (vue ledger). */
export interface ClosedPaperDecision extends PaperDecision {
  close: DecisionClose;
}

export interface PerformanceMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  averageWinPct: number | null;
  averageLossPct: number | null;
  profitFactor: number | null;
  expectancyPct: number | null;
  maxDrawdownPct: number;
  averageR: number | null;
  medianR: number | null;
  bySetup: Record<string, { trades: number; winRate: number | null; averageR: number | null }>;
  byMarketCap: Record<string, { trades: number; winRate: number | null; averageR: number | null }>;
  byChain: Record<string, { trades: number; winRate: number | null; averageR: number | null }>;
  byRegime: Record<string, { trades: number; winRate: number | null; averageR: number | null }>;
}

/** Résumé d'un cycle de recherche (§11). */
export interface CycleSummary {
  cycleId: string;
  date: string;
  marketRegime: string;
  regimeNote: string;
  tokensAnalyzed: number;
  newTokens: number;
  eliminated: Array<{ mint: string; symbol: string; reasons: string[] }>;
  noTrades: number;
  /** Décisions NO_TRADE réellement persistées au journal (plafond anti-bruit). */
  noTradesPersisted: number;
  paperTrades: number;
  wins: number;
  losses: number;
  open: number;
  metrics: PerformanceMetrics;
  errors: string[];
  adjustments: string[];
  hypothesesToTest: string[];
  opportunities: Array<{
    token: string;
    setup: string;
    requiredConditions: string;
    invalidation: string;
  }>;
  /** Sections du cahier des charges inapplicables avec les données actuelles. */
  notApplicable: string[];
  halted: boolean;
}
