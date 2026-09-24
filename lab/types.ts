// Types partagés du Crypto Lab (source de vérité pour les trois plans).
// Tout ce qui est écrit dans data/, intents/, ledger/ et journal/ doit correspondre à ces formes.

/** Fenêtres temporelles DexScreener. */
export type Window = "m5" | "h1" | "h6" | "h24";

export interface WindowedNumber {
  m5: number;
  h1: number;
  h6: number;
  h24: number;
}

export interface WindowedTxns {
  m5: { buys: number; sells: number };
  h1: { buys: number; sells: number };
  h6: { buys: number; sells: number };
  h24: { buys: number; sells: number };
}

/**
 * Valeur sentinelle d'une autorité (mint/freeze) que PERSONNE n'a encore vérifiée on-chain.
 * Non null ⇒ le Risk Engine la traite comme une autorité existante (refus), ce qui est le comportement voulu.
 */
export const UNKNOWN_AUTHORITY = "UNKNOWN";

/** Autorité on-chain : null = révoquée (vérifié), adresse base58 = existante, "UNKNOWN" = jamais vérifiée. */
export type Authority = typeof UNKNOWN_AUTHORITY | string | null;

/** Provenance d'un instantané. `local-verify` = construit par l'exécuteur sur la machine d'Hervé (seul format accepté en live). */
export type SnapshotSource = "dexscreener" | "fixture" | "manual" | "local-verify" | (string & {});

/**
 * Instantané d'un token Solana — TYPE UNIQUE pour les trois plans (chantier 1 de docs/architecture-v2.md).
 *
 * Écrit par le plan données dans `data/tokens/<mint>.json` (dernier état) et en série dans
 * `data/history/<mint>.jsonl` (une ligne par observation, backtest / signal volume) ; construit localement
 * par l'exécuteur (`lab/exec/verify.ts`) avant tout ordre ; lu par le Risk Engine.
 *
 * Champs inconnus EXPLICITES (jamais devinés, toujours conservateurs) :
 *   - `holders: null`            → nombre de détenteurs non collecté ;
 *   - `top10Pct: 100`            → concentration inconnue = maximale (le Risk Engine compare `top10Pct > maxTop10Pct`,
 *                                  un `null` y serait rejeté comme instantané invalide : la valeur 100 est le codage
 *                                  explicite de « inconnu » et produit le même refus) ;
 *   - `mintAuthority`/`freezeAuthority: "UNKNOWN"` → non vérifiées on-chain (refus tant qu'un MintInfo n'a pas tranché) ;
 *   - `priceUsd: 0`, `liquidityUsd: 0` → non fournis par la source (refusés par le Risk Engine) ;
 *   - `pairCreatedAt: null`      → âge inconnu ; `createdAt` vaut alors `fetchedAt` (âge 0 ⇒ AGE_MIN) ;
 *   - `fdvUsd`/`marketCapUsd: null`, `pairAddress`/`dexId`/`url: null` → non fournis.
 * `lab/collect/types.ts` fournit `makeSnapshot()` (construction avec ces défauts) et `normalizeSnapshot()`
 * (lecture tolérante d'anciens fichiers).
 */
export interface TokenSnapshot {
  /** Adresse du mint (base58). */
  mint: string;
  chain: "solana";
  symbol: string;
  name: string;
  /** Date de création de la paire principale (ISO 8601) ; = `fetchedAt` si `pairCreatedAt` est inconnu (conservateur). */
  createdAt: string;
  /** Création de la paire principale, epoch ms ; null si inconnue. */
  pairCreatedAt: number | null;
  /** Paire principale retenue (la plus liquide) ; null si aucune. */
  pairAddress: string | null;
  dexId: string | null;
  url: string | null;
  /** Prix en USD ; 0 si inconnu (refusé par le Risk Engine). */
  priceUsd: number;
  /** Liquidité du pool en USD ; 0 si inconnue. */
  liquidityUsd: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  /** Volumes USD par fenêtre (m5/h1/h6/h24), agrégés sur toutes les paires du token. */
  volume: WindowedNumber;
  /**
   * Vues plates DÉRIVÉES de `volume` (toujours égales à volume.m5 / volume.h1 / volume.h24) pour les lecteurs qui
   * n'ont pas besoin des fenêtres (Risk Engine, red team). Les producteurs les maintiennent via `makeSnapshot` /
   * `normalizeSnapshot` / `pairToSnapshot` ; ne jamais les modifier sans modifier `volume`.
   */
  volume5m: number;
  volume1h: number;
  volume24h: number;
  /** Variation de prix (%) par fenêtre. */
  priceChange: WindowedNumber;
  /** Transactions (achats/ventes) par fenêtre. */
  txns: WindowedTxns;
  /** Nombre de détenteurs ; null si non collecté (DexScreener ne le fournit pas). */
  holders: number | null;
  /** Part (en %) détenue par les 10 plus gros porteurs, 0..100 ; 100 = inconnu (conservateur). */
  top10Pct: number;
  /** Autorité de mint : null = révoquée, adresse = existante, "UNKNOWN" = non vérifiée. */
  mintAuthority: Authority;
  /** Autorité de gel : null = révoquée, adresse = existante, "UNKNOWN" = non vérifiée. */
  freezeAuthority: Authority;
  /** Boosts DexScreener actifs (0 si inconnu). */
  boostsActive: number;
  /** Nombre de paires connues pour ce token. */
  pairCount: number;
  /** Provenance de l'observation. */
  source: SnapshotSource;
  /** Moment où l'instantané a été pris (ISO 8601, fuseau obligatoire). Sert au contrôle de fraîcheur. */
  fetchedAt: string;
  /** Décimales du token SPL. En live, TOUJOURS lues du RPC par l'exécuteur, jamais d'un fichier du dépôt. */
  decimals?: number;
  /** Extensions Token-2022 dangereuses détectées localement (taxe, gel par défaut, délégué permanent…). */
  riskyExtensions?: string[];
}

export type IntentKind = "BUY" | "SELL" | "NO_ACTION";

/** Proposition d'action produite par le plan analyse (intents/<ISO>-<id>.json). Jamais un ordre. */
export interface Intent {
  id: string;
  createdAt: string;
  kind: IntentKind;
  mint: string;
  /** Montant proposé en CAD. Pour SELL : notionnel à vendre au prix de marché courant. */
  sizeCad: number;
  maxSlippageBps: number;
  thesis: string;
  signals: string[];
  invalidation: string;
  expiresAt: string;
}

/**
 * Décision journalisée dans ledger/trades.jsonl.
 * - PENDING  : l'ordre a passé le Risk Engine et va être exécuté (écrit AVANT l'exécution).
 * - PAPER    : rempli en simulation.
 * - EXECUTED : rempli en mode live.
 * - REJECTED : refusé par le Risk Engine (ou intent invalide).
 * - FAILED   : accepté mais l'exécution a échoué.
 */
export type LedgerDecision = "PENDING" | "PAPER" | "EXECUTED" | "REJECTED" | "FAILED";

export type ExecutionMode = "paper" | "live";

export interface LedgerFill {
  /** Prix effectif payé/reçu en USD (slippage inclus). */
  priceUsd: number;
  /** Taux CAD par USD utilisé. */
  fxCadPerUsd: number;
  /** Quantité de tokens achetée (>0) ou vendue (>0). */
  qty: number;
  /** Montant brut en CAD : cash sorti (BUY) ou produit brut de la vente avant frais (SELL). */
  grossCad: number;
  /** Montant net : investi après frais (BUY) ou encaissé après frais (SELL). */
  netCad: number;
  slippageBps: number;
  /** Signature de transaction (live uniquement). */
  txid?: string;
}

export interface LedgerFees {
  platformCad: number;
  swapCad: number;
  priorityCad: number;
  /** Loyer du compte de token associé (live, nouvelle position) — estimation pessimiste. */
  ataRentCad?: number;
  totalCad: number;
}

/** Une ligne de ledger/trades.jsonl. Le ledger est la source de vérité rejouable du portefeuille. */
export interface LedgerEntry {
  /** Horodatage de l'écriture (ISO 8601). */
  ts: string;
  intentId: string;
  mint: string;
  kind: IntentKind;
  decision: LedgerDecision;
  mode: ExecutionMode;
  reasons: string[];
  /** Taille demandée dans l'intent (CAD). */
  requestedSizeCad: number;
  /** Taille retenue par le Risk Engine (CAD), si acceptée. */
  sizeCad?: number;
  fill?: LedgerFill;
  fees?: LedgerFees;
  /** PnL réalisé en CAD (SELL uniquement, net de frais). */
  pnlCad?: number;
  /** Équité (cash + positions au coût ou au marché) juste après l'écriture. Sert au calcul du pic. */
  equityAfterCad?: number;
  /** Vrai si l'instantané évalué a été construit par l'exécuteur (RPC + DexScreener), faux si lu du dépôt (paper non vérifié). */
  verified?: boolean;
  /**
   * Origine de la ligne dans le ledger local : "local" (écrite par l'exécuteur) ou "repo-import" (copiée du ledger du dépôt
   * au premier lancement — ne crée ni cash ni position, ne sert qu'à restreindre : pertes, cadence, doublons).
   */
  origin?: "local" | "repo-import";
  /** Chaînage du ledger local : numéro de séquence, HMAC de la ligne précédente, HMAC de cette ligne. */
  seq?: number;
  prevHmac?: string;
  hmac?: string;
}

/** Politique de risque. Lue uniquement depuis un fichier local, jamais depuis le dépôt. */
export interface RiskPolicy {
  version: 1;
  /** Capital alloué au trading (CAD). Sert de base au drawdown et au cash initial. */
  tradingCapitalCad: number;
  maxPositionSizeCad: number;
  maxOpenPositions: number;
  maxExposureCad: number;
  maxDailyLossCad: number;
  maxWeeklyLossCad: number;
  /** Drawdown max depuis le pic, en % du capital de trading. */
  maxDrawdownPct: number;
  maxSlippageBps: number;
  minLiquidityUsd: number;
  minTokenAgeMinutes: number;
  allowMintAuthority: boolean;
  allowFreezeAuthority: boolean;
  /** Part max (en %) des 10 plus gros porteurs. */
  maxTop10Pct: number;
  /** Intervalle minimal entre deux ordres sur le même mint (minutes). */
  minOrderIntervalPerMintMinutes: number;
  /** Fenêtre interdite [startHour, endHour) dans le fuseau donné. `blockSells` (défaut false) : bloque aussi les ventes. */
  forbiddenWindow: { startHour: number; endHour: number; timeZone: string; blockSells?: boolean };
  /** Durée de vie par défaut d'un intent (minutes). */
  defaultIntentTtlMinutes: number;
  /** Âge max d'un instantané de token (minutes) ; si fetchedAt est absent, aucun contrôle. */
  maxSnapshotAgeMinutes: number;
  /** Si vrai, un BUY trop gros est réduit aux plafonds plutôt que rejeté. */
  allowSizeAdjustment: boolean;
  /** Taille minimale d'un ordre (CAD) — en dessous, on rejette (frais disproportionnés). */
  minOrderSizeCad: number;
  /** Autoriser le renfort d'une position dont la marque est sous le coût (défaut false). */
  allowAveragingDown?: boolean;
}

/** Entrée de journal/hypotheses.jsonl. */
export interface HypothesisEntry {
  id: string;
  createdAt: string;
  hypothesis: string;
  /** Nom du signal testé (ex. "early-buyer-overlap", "volume-spike-5m"). */
  signal: string;
  /** Données à l'appui (libres, sérialisables). */
  data: Record<string, unknown>;
  /** Décision prise : "BUY" | "SELL" | "NO_ACTION" | "REJECTED" ... */
  decision: string;
  /** Résultat observé : "WIN" | "LOSS" | "FLAT" | "MISSED" ... */
  result?: string;
  error?: string;
  /** Rendement observé (fraction, ex. 0.12 = +12 %). */
  return?: number;
  /** Drawdown max observé pendant la position (fraction). */
  drawdown?: number;
  context: Record<string, unknown>;
  /** Moment de la mise à jour du résultat (ISO 8601). */
  resolvedAt?: string;
}

export interface Position {
  mint: string;
  symbol?: string;
  qty: number;
  /** Coût total d'acquisition en CAD (frais inclus). */
  costCad: number;
  openedAt: string;
  /** Dernière valeur de marché (CAD) si connue. */
  markCad?: number;
  lastPriceUsd?: number;
  markedAt?: string;
}

export interface PortfolioState {
  cashCad: number;
  positions: Position[];
  realizedPnlCad: number;
  peakEquityCad: number;
  /** PnL réalisé par jour (clé AAAA-MM-JJ dans le fuseau de la politique). */
  dailyPnlByDate: Record<string, number>;
  /** PnL réalisé par semaine ISO (clé AAAA-Www). */
  weeklyPnlByWeek: Record<string, number>;
}

export interface RiskVerdict {
  allowed: boolean;
  reasons: string[];
  adjustedSizeCad?: number;
}
