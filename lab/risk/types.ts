// Extensions v2 du Risk Engine (chantier 6). Définies ICI et non dans lab/types.ts parce que ce dernier est en cours
// d'unification par un autre chantier (TokenSnapshot). À FUSIONNER dans lab/types.ts dès que possible :
//   - RiskPolicy.version : 1 | 2, plus les quatre champs de RiskPolicyV2Fields (optionnels en v1, requis en v2) ;
//   - Intent : narrativeTag?, sourceWallet?, signalTs? ;
//   - LedgerEntry : narrativeTag?, sourceWallet? (copiés de l'intent par l'exécuteur, servent à la corrélation).
// Tant que la fusion n'est pas faite, `validatePolicy` renvoie le type v1 `RiskPolicy` (les champs v2 sont présents à
// l'exécution) et `evaluate` accepte `RiskPolicy | RiskPolicyV2`.

import type { Intent, LedgerEntry, RiskPolicy } from "../types.ts";

/** Champs ajoutés par la politique v2. Tous optionnels en v1 ; tous requis en v2 (voir policyProblems). */
export interface RiskPolicyV2Fields {
  /**
   * Nombre max de positions ouvertes partageant le même `narrativeTag` OU le même `sourceWallet` (la position
   * demandée comprise). Exposition cumulée par tag/wallet ≤ maxExposureCad / 2.
   */
  maxCorrelatedPositions?: number;
  /** Après N ventes perdantes consécutives (dernière < 24 h), les ACHATS sont bloqués 24 h ; les ventes passent. */
  maxConsecutiveLosses?: number;
  /** N lignes FAILED dans les 24 dernières heures → achats bloqués (reduce-only préservé). */
  executionErrorBudget?: number;
  /** Âge max (minutes) du signal d'un BUY : `now − intent.signalTs`. signalTs manquant = rejet du BUY. */
  maxSignalAgeMinutes?: number;
}

export type RiskPolicyV2 = Omit<RiskPolicy, "version"> & { version: 1 | 2 } & RiskPolicyV2Fields;

/** Champs v2 de l'intent (auto-déclarés par le plan analyse — voir la limite documentée dans lab/README.md). */
export interface IntentV2Fields {
  /** Thème / narratif de la thèse, ex. "ai-agents", "dog-coins". Normalisé (trim + minuscules) avant comparaison. */
  narrativeTag?: string;
  /** Wallet dont le signal est issu (early buyer suivi), base58. */
  sourceWallet?: string;
  /** Horodatage ISO 8601 (fuseau obligatoire) du signal à l'origine de l'intent. */
  signalTs?: string;
}

export type IntentV2 = Intent & IntentV2Fields;

/** Champs v2 d'une ligne de ledger : recopiés depuis l'intent par l'exécuteur au moment de la décision. */
export interface LedgerEntryV2Fields {
  narrativeTag?: string;
  sourceWallet?: string;
}

export type LedgerEntryV2 = LedgerEntry & LedgerEntryV2Fields;
