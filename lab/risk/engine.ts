// Risk Engine — fonctions pures et déterministes. Aucune E/S ici sauf loadPolicy (lecture locale).
// Contrat : evaluate() ne lève JAMAIS ; toute anomalie est un rejet motivé.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Intent,
  LedgerEntry,
  PortfolioState,
  Position,
  RiskPolicy,
  RiskVerdict,
  TokenSnapshot,
} from "../types.ts";
import { dateKey, hourInZone, isValidTimeZone, isoWeekKey, parseIso, toDate } from "../time.ts";
import type { IntentV2, LedgerEntryV2, RiskPolicyV2 } from "./types.ts";

export type { IntentV2, LedgerEntryV2, RiskPolicyV2 } from "./types.ts";

// ---------------------------------------------------------------------------
// Validation de la politique
// ---------------------------------------------------------------------------

/** Fenêtre glissante des règles v2 (série de pertes, budget d'erreurs) : 24 h. */
export const V2_WINDOW_MS = 24 * 3600_000;

/** Champs v2 : optionnels si version = 1, tous requis si version = 2. */
const V2_NUMERIC_FIELDS: Array<[keyof RiskPolicyV2, { min: number; max?: number; integer?: boolean }]> = [
  ["maxCorrelatedPositions", { min: 1, integer: true }],
  ["maxConsecutiveLosses", { min: 1, integer: true }],
  ["executionErrorBudget", { min: 1, integer: true }],
  ["maxSignalAgeMinutes", { min: 0 }],
];

const NUMERIC_FIELDS: Array<[keyof RiskPolicy, { min: number; max?: number; integer?: boolean }]> = [
  ["tradingCapitalCad", { min: 1 }],
  ["maxPositionSizeCad", { min: 1 }],
  ["maxOpenPositions", { min: 1, integer: true }],
  ["maxExposureCad", { min: 1 }],
  ["maxDailyLossCad", { min: 1 }],
  ["maxWeeklyLossCad", { min: 1 }],
  ["maxDrawdownPct", { min: 1, max: 100 }],
  ["maxSlippageBps", { min: 1, max: 10_000 }],
  ["minLiquidityUsd", { min: 0 }],
  ["minTokenAgeMinutes", { min: 0 }],
  ["maxTop10Pct", { min: 0, max: 100 }],
  ["minOrderIntervalPerMintMinutes", { min: 0 }],
  ["defaultIntentTtlMinutes", { min: 1 }],
  ["maxSnapshotAgeMinutes", { min: 0 }],
  ["minOrderSizeCad", { min: 0 }],
];

const BOOLEAN_FIELDS: Array<keyof RiskPolicy> = [
  "allowMintAuthority",
  "allowFreezeAuthority",
  "allowSizeAdjustment",
];

/** Renvoie la liste des problèmes (vide si la politique est valide). */
export function policyProblems(input: unknown): string[] {
  const problems: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["politique : objet JSON attendu"];
  }
  const p = input as Record<string, unknown>;
  if (p.version !== 1 && p.version !== 2) problems.push("politique : version doit être 1 ou 2");
  const checkNumeric = (field: string, rule: { min: number; max?: number; integer?: boolean }): void => {
    const v = p[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`politique : ${field} doit être un nombre fini`);
      return;
    }
    if (v < rule.min) problems.push(`politique : ${field} doit être ≥ ${rule.min}`);
    if (rule.max !== undefined && v > rule.max) problems.push(`politique : ${field} doit être ≤ ${rule.max}`);
    if (rule.integer && !Number.isInteger(v)) problems.push(`politique : ${field} doit être entier`);
  };
  for (const [field, rule] of NUMERIC_FIELDS) checkNumeric(field, rule);
  // v2 : les quatre champs sont requis ; v1 : validés seulement s'ils sont présents.
  for (const [field, rule] of V2_NUMERIC_FIELDS) {
    if (p.version === 2 || p[field] !== undefined) checkNumeric(field, rule);
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof p[field] !== "boolean") problems.push(`politique : ${field} doit être booléen`);
  }
  const fw = p.forbiddenWindow as Record<string, unknown> | undefined;
  if (!fw || typeof fw !== "object") {
    problems.push("politique : forbiddenWindow manquant");
  } else {
    const ok = (h: unknown): h is number => typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 24;
    if (!ok(fw.startHour) || !ok(fw.endHour)) problems.push("politique : forbiddenWindow.startHour/endHour doivent être des entiers 0..24");
    if (!isValidTimeZone(fw.timeZone)) problems.push("politique : forbiddenWindow.timeZone invalide");
    if (fw.blockSells !== undefined && typeof fw.blockSells !== "boolean") problems.push("politique : forbiddenWindow.blockSells doit être booléen");
  }
  if (p.allowAveragingDown !== undefined && typeof p.allowAveragingDown !== "boolean") {
    problems.push("politique : allowAveragingDown doit être booléen");
  }
  // Cohérences internes
  if (problems.length === 0) {
    const q = input as RiskPolicy;
    if (q.maxPositionSizeCad > q.maxExposureCad) problems.push("politique : maxPositionSizeCad > maxExposureCad");
    if (q.maxExposureCad > q.tradingCapitalCad) problems.push("politique : maxExposureCad > tradingCapitalCad");
    if (q.maxDailyLossCad > q.maxWeeklyLossCad) problems.push("politique : maxDailyLossCad > maxWeeklyLossCad");
    if (q.minOrderSizeCad > q.maxPositionSizeCad) problems.push("politique : minOrderSizeCad > maxPositionSizeCad");
    const v2 = input as RiskPolicyV2;
    if (v2.maxCorrelatedPositions !== undefined && v2.maxCorrelatedPositions > q.maxOpenPositions) {
      problems.push("politique : maxCorrelatedPositions > maxOpenPositions");
    }
  }
  return problems;
}

/**
 * Valide et renvoie la politique typée ; lève avec la liste des problèmes sinon.
 * Type de retour : `RiskPolicy` (v1) tant que lab/types.ts n'est pas fusionné — les champs v2 sont présents à l'exécution
 * et lus par `evaluate` via `RiskPolicyV2`.
 */
export function validatePolicy(input: unknown): RiskPolicy {
  const problems = policyProblems(input);
  if (problems.length > 0) throw new Error(`Politique de risque invalide :\n- ${problems.join("\n- ")}`);
  return input as RiskPolicy;
}

// ---------------------------------------------------------------------------
// Chargement local de la politique (jamais depuis le dépôt)
// ---------------------------------------------------------------------------

/** Racine du dépôt = deux niveaux au-dessus de lab/risk/. */
export function defaultRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export interface LoadPolicyOptions {
  repoRoot?: string;
  home?: string;
  env?: Record<string, string | undefined>;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Chemin de politique attendu : RISK_POLICY_PATH sinon ~/.crypto-lab/risk.policy.json. */
export function resolvePolicyPath(opts: LoadPolicyOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  return env.RISK_POLICY_PATH && env.RISK_POLICY_PATH.length > 0
    ? path.resolve(env.RISK_POLICY_PATH)
    : path.join(home, ".crypto-lab", "risk.policy.json");
}

/**
 * Charge une politique locale. Refuse tout fichier situé dans le dépôt.
 * Autorisé : sous ~/.crypto-lab/, ou le chemin exact de RISK_POLICY_PATH s'il est hors du dépôt.
 */
export function loadPolicy(policyPath: string, opts: LoadPolicyOptions = {}): RiskPolicy {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const repoRoot = realpathOrSelf(opts.repoRoot ?? defaultRepoRoot());
  const resolved = realpathOrSelf(policyPath);
  const localDir = realpathOrSelf(path.join(home, ".crypto-lab"));

  if (isInside(repoRoot, resolved)) {
    throw new Error(`Refus : la politique de risque ne doit jamais être lue depuis le dépôt (${resolved})`);
  }
  const viaEnv = env.RISK_POLICY_PATH ? realpathOrSelf(env.RISK_POLICY_PATH) === resolved : false;
  if (!isInside(localDir, resolved) && !viaEnv) {
    throw new Error(
      `Refus : la politique doit se trouver sous ${localDir} ou être désignée par RISK_POLICY_PATH (${resolved})`,
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (e) {
    throw new Error(`Politique introuvable ou illisible : ${resolved} (${(e as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Politique : JSON invalide (${(e as Error).message})`);
  }
  return validatePolicy(parsed);
}

// ---------------------------------------------------------------------------
// Évaluation
// ---------------------------------------------------------------------------

const FILL_DECISIONS = new Set(["PENDING", "PAPER", "EXECUTED"]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Valeur de marché d'une position : dernier mark si connu, sinon le coût. */
export function positionValueCad(p: Position): number {
  return isFiniteNumber(p.markCad) ? p.markCad : p.costCad;
}

/** Valeur retenue pour les PLAFONDS (taille par mint, exposition) : max(coût, marque) — une marque basse ne libère pas de place. */
export function positionCapValueCad(p: Position): number {
  return Math.max(p.costCad, positionValueCad(p));
}

/** Perte latente (≤ 0) des positions marquées : Σ min(0, marque − coût). Les positions sans marque comptent 0. */
export function latentLossCad(portfolio: PortfolioState): number {
  return portfolio.positions.reduce((s, p) => (isFiniteNumber(p.markCad) ? s + Math.min(0, p.markCad - p.costCad) : s), 0);
}

/** Équité = cash + valeur des positions. */
export function equityCad(portfolio: PortfolioState): number {
  return portfolio.cashCad + portfolio.positions.reduce((s, p) => s + positionValueCad(p), 0);
}

function intentProblems(intent: unknown): string[] {
  const problems: string[] = [];
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return ["INTENT_INVALIDE: objet attendu"];
  const i = intent as Record<string, unknown>;
  for (const f of ["id", "createdAt", "kind", "mint", "expiresAt"] as const) {
    if (!nonEmptyString(i[f])) problems.push(`CHAMP_MANQUANT: ${f}`);
  }
  if (i.kind !== "BUY" && i.kind !== "SELL" && i.kind !== "NO_ACTION") problems.push(`KIND_INVALIDE: ${String(i.kind)}`);
  if (i.kind === "BUY" || i.kind === "SELL") {
    if (!isFiniteNumber(i.sizeCad)) problems.push("CHAMP_MANQUANT: sizeCad");
    if (!isFiniteNumber(i.maxSlippageBps)) problems.push("CHAMP_MANQUANT: maxSlippageBps");
    if (!nonEmptyString(i.thesis)) problems.push("CHAMP_MANQUANT: thesis");
    if (!Array.isArray(i.signals)) problems.push("CHAMP_MANQUANT: signals");
    if (!nonEmptyString(i.invalidation)) problems.push("CHAMP_MANQUANT: invalidation");
  }
  if (nonEmptyString(i.mint) && !BASE58.test(i.mint)) problems.push("MINT_INVALIDE: format base58 attendu");
  if (nonEmptyString(i.createdAt) && !parseIso(i.createdAt)) problems.push("DATE_INVALIDE: createdAt");
  if (nonEmptyString(i.expiresAt) && !parseIso(i.expiresAt)) problems.push("DATE_INVALIDE: expiresAt");
  // Champs v2 (optionnels) : s'ils sont présents, ils doivent être bien formés.
  if (i.signalTs !== undefined && !parseIso(i.signalTs)) problems.push("DATE_INVALIDE: signalTs");
  if (i.narrativeTag !== undefined && typeof i.narrativeTag !== "string") problems.push("CHAMP_INVALIDE: narrativeTag doit être une chaîne");
  if (i.sourceWallet !== undefined && (typeof i.sourceWallet !== "string" || !BASE58.test(i.sourceWallet))) {
    problems.push("WALLET_INVALIDE: sourceWallet doit être une adresse base58");
  }
  return problems;
}

function portfolioProblems(portfolio: unknown): string[] {
  if (!portfolio || typeof portfolio !== "object") return ["PORTEFEUILLE_INVALIDE: objet attendu"];
  const p = portfolio as Record<string, unknown>;
  const problems: string[] = [];
  if (!isFiniteNumber(p.cashCad)) problems.push("PORTEFEUILLE_INVALIDE: cashCad");
  if (!Array.isArray(p.positions)) problems.push("PORTEFEUILLE_INVALIDE: positions");
  else {
    for (const pos of p.positions as unknown[]) {
      const q = pos as Record<string, unknown>;
      if (!q || !nonEmptyString(q.mint) || !isFiniteNumber(q.qty) || !isFiniteNumber(q.costCad)) {
        problems.push("PORTEFEUILLE_INVALIDE: position malformée");
        break;
      }
    }
  }
  if (!isFiniteNumber(p.peakEquityCad)) problems.push("PORTEFEUILLE_INVALIDE: peakEquityCad");
  if (!p.dailyPnlByDate || typeof p.dailyPnlByDate !== "object") problems.push("PORTEFEUILLE_INVALIDE: dailyPnlByDate");
  if (!p.weeklyPnlByWeek || typeof p.weeklyPnlByWeek !== "object") problems.push("PORTEFEUILLE_INVALIDE: weeklyPnlByWeek");
  return problems;
}

function snapshotProblems(snapshot: unknown, mint: string): string[] {
  if (!snapshot || typeof snapshot !== "object") return ["SNAPSHOT_MANQUANT: aucun instantané du token"];
  const s = snapshot as Record<string, unknown>;
  const problems: string[] = [];
  if (s.mint !== mint) problems.push(`SNAPSHOT_INCOHERENT: mint ${String(s.mint)} ≠ ${mint}`);
  if (!isFiniteNumber(s.priceUsd) || s.priceUsd <= 0) problems.push("SNAPSHOT_INVALIDE: priceUsd");
  if (!isFiniteNumber(s.liquidityUsd)) problems.push("SNAPSHOT_INVALIDE: liquidityUsd");
  if (!parseIso(s.createdAt)) problems.push("SNAPSHOT_INVALIDE: createdAt");
  if (!("mintAuthority" in s) || !("freezeAuthority" in s)) problems.push("SNAPSHOT_INVALIDE: autorités absentes");
  if (!isFiniteNumber(s.top10Pct)) problems.push("SNAPSHOT_INVALIDE: top10Pct");
  if (!parseIso(s.fetchedAt)) problems.push("SNAPSHOT_INVALIDE: fetchedAt obligatoire (ISO 8601 avec fuseau)");
  return problems;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Règles v2 — helpers purs, exportés pour les tests
// ---------------------------------------------------------------------------

const FILLED = new Set(["PAPER", "EXECUTED"]);

/**
 * Série de pertes : ventes remplies (PAPER/EXECUTED, tous modes — sens conservateur, comme la cadence) triées par ts,
 * comptées depuis la plus récente tant que pnlCad < 0. Un gain ou un PnL nul remet le compteur à zéro.
 * Renvoie la longueur de la série et l'horodatage de la dernière perte.
 */
export function consecutiveLosses(ledger: readonly LedgerEntry[]): { count: number; lastLossTs: string | null } {
  const sells = ledger
    .filter((e) => e && e.kind === "SELL" && FILLED.has(e.decision) && isFiniteNumber(e.pnlCad) && parseIso(e.ts) !== null)
    .sort((a, b) => parseIso(a.ts)!.getTime() - parseIso(b.ts)!.getTime());
  let count = 0;
  let lastLossTs: string | null = null;
  for (let i = sells.length - 1; i >= 0; i--) {
    const e = sells[i]!;
    if (e.pnlCad! >= 0) break;
    if (count === 0) lastLossTs = e.ts;
    count++;
  }
  return { count, lastLossTs };
}

/** Nombre de lignes FAILED dont ts ∈ (now − windowMs, now + 1 min]. */
export function failedExecutionsWithin(ledger: readonly LedgerEntry[], now: Date, windowMs: number = V2_WINDOW_MS): number {
  return ledger.filter((e) => {
    if (!e || e.decision !== "FAILED") return false;
    const t = parseIso(e.ts);
    return t !== null && now.getTime() - t.getTime() < windowMs && t.getTime() <= now.getTime() + 60_000;
  }).length;
}

export const normalizeTag = (tag: unknown): string | null => (nonEmptyString(tag) ? tag.trim().toLowerCase() : null);

/**
 * Étiquettes (narratif, wallet source) d'une position ouverte : lues sur la ligne d'ACHAT remplie la plus récente de ce
 * mint dans le ledger local. Une position dont l'achat n'a pas d'étiquette n'est corrélée à rien (limite documentée).
 */
export function positionTags(mint: string, ledger: readonly LedgerEntry[]): { narrativeTag: string | null; sourceWallet: string | null } {
  let best: LedgerEntryV2 | null = null;
  let bestT = -Infinity;
  for (const e of ledger as readonly LedgerEntryV2[]) {
    if (!e || e.mint !== mint || e.kind !== "BUY" || !FILLED.has(e.decision)) continue;
    const t = parseIso(e.ts)?.getTime();
    if (t === undefined || t < bestT) continue;
    if (e.narrativeTag === undefined && e.sourceWallet === undefined) continue;
    best = e;
    bestT = t;
  }
  return {
    narrativeTag: best ? normalizeTag(best.narrativeTag) : null,
    sourceWallet: best && nonEmptyString(best.sourceWallet) ? best.sourceWallet.trim() : null,
  };
}

/**
 * Évalue un intent contre la politique. Pure, déterministe, ne lève jamais.
 * @param ledger entrées existantes du ledger (doublons, cadence par mint, série de pertes, budget d'erreurs, corrélation).
 */
export function evaluate(
  intent: Intent | IntentV2,
  portfolio: PortfolioState,
  snapshot: TokenSnapshot | null | undefined,
  policy: RiskPolicy | RiskPolicyV2,
  now: Date | string | number,
  ledger: readonly LedgerEntry[] = [],
): RiskVerdict {
  try {
    return evaluateUnsafe(intent, portfolio, snapshot, policy as RiskPolicyV2, now, ledger);
  } catch (e) {
    return { allowed: false, reasons: [`ERREUR_INTERNE: ${(e as Error)?.message ?? String(e)}`] };
  }
}

function evaluateUnsafe(
  intent: IntentV2,
  portfolio: PortfolioState,
  snapshot: TokenSnapshot | null | undefined,
  policy: RiskPolicyV2,
  nowInput: Date | string | number,
  ledger: readonly LedgerEntry[],
): RiskVerdict {
  const reasons: string[] = [];

  // 0. Entrées structurelles : on s'arrête tôt si les objets de base sont inutilisables.
  const pp = policyProblems(policy);
  if (pp.length > 0) return { allowed: false, reasons: pp.map((r) => `POLITIQUE_INVALIDE: ${r}`) };
  const now = toDate(nowInput);
  if (!now) return { allowed: false, reasons: ["HORLOGE_INVALIDE: now"] };
  const ip = intentProblems(intent);
  if (ip.length > 0) return { allowed: false, reasons: ip };
  const pf = portfolioProblems(portfolio);
  if (pf.length > 0) return { allowed: false, reasons: pf };
  if (!Array.isArray(ledger)) return { allowed: false, reasons: ["LEDGER_INVALIDE: tableau attendu"] };

  if (intent.kind === "NO_ACTION") {
    return { allowed: false, reasons: ["NO_ACTION: aucune exécution requise"] };
  }

  const tz = policy.forbiddenWindow.timeZone;

  // 1. Doublon : même id déjà journalisé (quelle que soit la décision).
  if (ledger.some((e) => e && e.intentId === intent.id)) {
    reasons.push(`INTENT_DUPLIQUE: ${intent.id} déjà présent dans le ledger`);
  }

  // 2. Expiration (expiresAt fourni, borné par le TTL par défaut à partir de createdAt).
  const createdAt = parseIso(intent.createdAt)!;
  const expiresAt = parseIso(intent.expiresAt)!;
  const ttlCap = new Date(createdAt.getTime() + policy.defaultIntentTtlMinutes * 60_000);
  const effectiveExpiry = expiresAt.getTime() < ttlCap.getTime() ? expiresAt : ttlCap;
  if (now.getTime() > effectiveExpiry.getTime()) {
    reasons.push(`INTENT_EXPIRE: expiré à ${effectiveExpiry.toISOString()}, maintenant ${now.toISOString()}`);
  }
  if (createdAt.getTime() > now.getTime() + 5 * 60_000) {
    reasons.push("INTENT_FUTUR: createdAt est dans le futur");
  }

  const isSell = intent.kind === "SELL";
  const position = portfolio.positions.find((p) => p.mint === intent.mint);

  // 3. Fenêtre horaire interdite [start, end) dans le fuseau de la politique. Reduce-only : les ventes passent
  //    sauf si la politique le demande (forbiddenWindow.blockSells).
  const hour = hourInZone(now, tz);
  const { startHour, endHour } = policy.forbiddenWindow;
  const inWindow = startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
  if (inWindow && (!isSell || policy.forbiddenWindow.blockSells === true)) {
    reasons.push(`FENETRE_INTERDITE: ${hour}h dans [${startHour}h, ${endHour}h) ${tz}`);
  }

  // 4. Pertes quotidienne / hebdomadaire : réalisé (net de frais et slippage) + perte latente des positions marquées.
  //    Reduce-only : n'empêche jamais une vente.
  const todayKey = dateKey(now, tz);
  const weekKey = isoWeekKey(now, tz);
  const latent = latentLossCad(portfolio);
  const dailyPnl = (portfolio.dailyPnlByDate[todayKey] ?? 0) + latent;
  const weeklyPnl = (portfolio.weeklyPnlByWeek[weekKey] ?? 0) + latent;
  if (!isSell && dailyPnl <= -policy.maxDailyLossCad) {
    reasons.push(`PERTE_QUOTIDIENNE: ${round2(dailyPnl)} CAD (latent ${round2(latent)}) ≤ -${policy.maxDailyLossCad} (${todayKey})`);
  }
  if (!isSell && weeklyPnl <= -policy.maxWeeklyLossCad) {
    reasons.push(`PERTE_HEBDO: ${round2(weeklyPnl)} CAD (latent ${round2(latent)}) ≤ -${policy.maxWeeklyLossCad} (${weekKey})`);
  }

  // 5. Drawdown depuis le pic, en % du capital de trading (positions au marché). Reduce-only.
  const equity = equityCad(portfolio);
  const drawdownCad = Math.max(0, portfolio.peakEquityCad - equity);
  const maxDrawdownCad = (policy.maxDrawdownPct / 100) * policy.tradingCapitalCad;
  if (!isSell && drawdownCad >= maxDrawdownCad) {
    reasons.push(
      `DRAWDOWN_MAX: ${round2(drawdownCad)} CAD depuis le pic ${round2(portfolio.peakEquityCad)} ≥ ${round2(maxDrawdownCad)} — revue humaine requise`,
    );
  }

  // 6. Slippage.
  if (intent.maxSlippageBps <= 0) reasons.push("SLIPPAGE_INVALIDE: maxSlippageBps ≤ 0");
  if (intent.maxSlippageBps > policy.maxSlippageBps) {
    reasons.push(`SLIPPAGE_MAX: ${intent.maxSlippageBps} bps > ${policy.maxSlippageBps}`);
  }

  // 7. Instantané du token (exigé pour BUY et SELL : il fournit le prix). fetchedAt est obligatoire.
  const sp = snapshotProblems(snapshot, intent.mint);
  reasons.push(...sp);
  const snap = sp.length === 0 ? (snapshot as TokenSnapshot) : null;
  if (snap) {
    const fetched = parseIso(snap.fetchedAt)!;
    if (now.getTime() - fetched.getTime() > policy.maxSnapshotAgeMinutes * 60_000) {
      reasons.push(`SNAPSHOT_PERIME: pris à ${snap.fetchedAt}, âge > ${policy.maxSnapshotAgeMinutes} min`);
    }
  }

  // 8. Cadence : un seul ordre par mint par intervalle (PENDING/PAPER/EXECUTED comptent).
  const intervalMs = policy.minOrderIntervalPerMintMinutes * 60_000;
  const recent = ledger.find((e) => {
    if (!e || e.mint !== intent.mint || !FILL_DECISIONS.has(e.decision)) return false;
    const t = parseIso(e.ts);
    return t !== null && now.getTime() - t.getTime() < intervalMs && t.getTime() <= now.getTime() + 60_000;
  });
  if (recent) {
    reasons.push(`CADENCE_MINT: ordre ${recent.intentId} sur ${intent.mint} à ${recent.ts} (< ${policy.minOrderIntervalPerMintMinutes} min)`);
  }

  let adjustedSizeCad: number | undefined;

  if (intent.kind === "BUY") {
    // 9. Qualité du token (uniquement à l'achat : on doit toujours pouvoir sortir).
    if (snap) {
      if (snap.liquidityUsd < policy.minLiquidityUsd) {
        reasons.push(`LIQUIDITE_MIN: ${snap.liquidityUsd} USD < ${policy.minLiquidityUsd}`);
      }
      const ageMin = (now.getTime() - parseIso(snap.createdAt)!.getTime()) / 60_000;
      if (ageMin < policy.minTokenAgeMinutes) {
        reasons.push(`AGE_MIN: ${round2(ageMin)} min < ${policy.minTokenAgeMinutes}`);
      }
      if (snap.mintAuthority && !policy.allowMintAuthority) reasons.push("MINT_AUTHORITY: autorité de mint non révoquée");
      if (snap.freezeAuthority && !policy.allowFreezeAuthority) reasons.push("FREEZE_AUTHORITY: autorité de gel non révoquée");
      if (snap.top10Pct > policy.maxTop10Pct) reasons.push(`TOP10_MAX: ${snap.top10Pct} % > ${policy.maxTop10Pct} %`);
      if (Array.isArray(snap.riskyExtensions) && snap.riskyExtensions.length > 0) {
        reasons.push(`EXTENSION_RISQUEE: ${snap.riskyExtensions.join(", ")}`);
      }
    }

    // 10. État du portefeuille : toute position ouverte doit avoir une marque récente, sinon l'état est inconnu.
    const unmarked = portfolio.positions.filter((p) => !isFiniteNumber(p.markCad)).map((p) => p.mint);
    if (unmarked.length > 0) reasons.push(`MARQUE_INCONNUE: position(s) sans marque au marché : ${unmarked.join(", ")}`);
    if (position && isFiniteNumber(position.markCad) && position.markCad < position.costCad && policy.allowAveragingDown !== true) {
      reasons.push(`RENFORT_EN_PERTE: ${intent.mint} marqué ${round2(position.markCad)} < coût ${round2(position.costCad)}`);
    }

    // 11. Taille, nombre de positions, exposition, cash — plafonds au max(coût, marque).
    let size = intent.sizeCad;
    if (size <= 0) reasons.push("TAILLE_INVALIDE: sizeCad ≤ 0");
    const exposure = portfolio.positions.reduce((s, p) => s + positionCapValueCad(p), 0);
    const exposureRoom = policy.maxExposureCad - exposure;
    const caps: Array<[string, number]> = [
      ["TAILLE_MAX", policy.maxPositionSizeCad],
      ["EXPOSITION_MAX", exposureRoom],
      ["CASH_INSUFFISANT", portfolio.cashCad],
    ];
    if (position) caps.push(["TAILLE_MAX", policy.maxPositionSizeCad - positionCapValueCad(position)]);
    const [tightest, capValue] = caps.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (size > capValue) {
      if (policy.allowSizeAdjustment && capValue >= policy.minOrderSizeCad) {
        size = round2(capValue);
      } else {
        const detail: Record<string, string> = {
          TAILLE_MAX: `${intent.sizeCad} CAD > ${policy.maxPositionSizeCad} (déjà ${round2(position ? positionCapValueCad(position) : 0)} sur ce mint)`,
          EXPOSITION_MAX: `exposition ${round2(exposure)} + ${intent.sizeCad} > ${policy.maxExposureCad}`,
          CASH_INSUFFISANT: `${intent.sizeCad} CAD > cash disponible ${round2(portfolio.cashCad)}`,
        };
        reasons.push(`${tightest}: ${detail[tightest]}`);
      }
    }
    if (!position && portfolio.positions.length >= policy.maxOpenPositions) {
      reasons.push(`POSITIONS_MAX: ${portfolio.positions.length} positions ouvertes ≥ ${policy.maxOpenPositions}`);
    }
    if (size > 0 && size < policy.minOrderSizeCad) reasons.push(`TAILLE_MIN: ${size} CAD < ${policy.minOrderSizeCad}`);
    adjustedSizeCad = size;

    // 12. Politique v2 — toutes ces règles ne bloquent que les ACHATS (reduce-only préservé).
    // 12a. Âge du signal : signalTs obligatoire pour un BUY dès que la politique fixe maxSignalAgeMinutes.
    if (policy.maxSignalAgeMinutes !== undefined) {
      const sig = parseIso(intent.signalTs);
      if (!sig) {
        reasons.push("SIGNAL_TS_MANQUANT: signalTs absent ou non ISO 8601 (fuseau obligatoire)");
      } else if (sig.getTime() > now.getTime() + 5 * 60_000) {
        reasons.push("SIGNAL_FUTUR: signalTs est dans le futur");
      } else {
        const ageMin = (now.getTime() - sig.getTime()) / 60_000;
        if (ageMin > policy.maxSignalAgeMinutes) {
          reasons.push(`SIGNAL_PERIME: signal daté de ${intent.signalTs}, âge ${round2(ageMin)} min > ${policy.maxSignalAgeMinutes}`);
        }
      }
    }

    // 12b. Série de pertes : N ventes perdantes consécutives dont la dernière date de moins de 24 h → plus d'achat.
    if (policy.maxConsecutiveLosses !== undefined) {
      const streak = consecutiveLosses(ledger);
      const last = streak.lastLossTs ? parseIso(streak.lastLossTs) : null;
      if (streak.count >= policy.maxConsecutiveLosses && last && now.getTime() - last.getTime() < V2_WINDOW_MS) {
        const until = new Date(last.getTime() + V2_WINDOW_MS).toISOString();
        reasons.push(`SERIE_DE_PERTES: ${streak.count} pertes consécutives ≥ ${policy.maxConsecutiveLosses} (dernière ${streak.lastLossTs}) — achats bloqués jusqu'à ${until}`);
      }
    }

    // 12c. Budget d'erreurs d'exécution : N lignes FAILED en 24 h → plus d'achat (quelque chose casse, on n'insiste pas).
    if (policy.executionErrorBudget !== undefined) {
      const failed = failedExecutionsWithin(ledger, now);
      if (failed >= policy.executionErrorBudget) {
        reasons.push(`BUDGET_ERREURS: ${failed} échec(s) d'exécution en 24 h ≥ ${policy.executionErrorBudget} — achats bloqués`);
      }
    }

    // 12d. Corrélation : positions ouvertes (autres mints) partageant le narratif ou le wallet source de l'intent.
    //      Nombre ≤ maxCorrelatedPositions (position demandée comprise) ; exposition cumulée ≤ maxExposureCad / 2.
    if (policy.maxCorrelatedPositions !== undefined) {
      const tag = normalizeTag(intent.narrativeTag);
      const wallet = nonEmptyString(intent.sourceWallet) ? intent.sourceWallet.trim() : null;
      if (tag !== null || wallet !== null) {
        const others = portfolio.positions.filter((p) => p.mint !== intent.mint && p.qty > 0);
        const tagged = others.map((p) => ({ p, tags: positionTags(p.mint, ledger) }));
        const halfExposure = policy.maxExposureCad / 2;
        const check = (label: "NARRATIF" | "WALLET", value: string | null, pick: (t: ReturnType<typeof positionTags>) => string | null): void => {
          if (value === null) return;
          const same = tagged.filter(({ tags }) => pick(tags) === value);
          const own = position ? positionCapValueCad(position) : 0;
          const sameExposure = same.reduce((s, { p }) => s + positionCapValueCad(p), 0) + own;
          const total = same.length + 1; // la position demandée comprise
          if (total > policy.maxCorrelatedPositions!) {
            reasons.push(`CORRELATION_${label}: ${same.length} position(s) déjà sur « ${value} » (${same.map(({ p }) => p.mint).join(", ")}) + celle-ci = ${total} > ${policy.maxCorrelatedPositions}`);
          }
          if (sameExposure + intent.sizeCad > halfExposure) {
            reasons.push(`EXPOSITION_${label}: ${round2(sameExposure)} + ${intent.sizeCad} CAD sur « ${value} » > ${round2(halfExposure)} (maxExposureCad / 2)`);
          }
        };
        check("NARRATIF", tag, (t) => t.narrativeTag);
        check("WALLET", wallet, (t) => t.sourceWallet);
      }
    }
  } else {
    // SELL (reduce-only) : seules les règles structurelles s'appliquent.
    if (!position || position.qty <= 0) {
      reasons.push(`VENTE_SANS_POSITION: aucune position sur ${intent.mint}`);
    } else {
      if (intent.sizeCad <= 0) reasons.push("TAILLE_INVALIDE: sizeCad ≤ 0");
      // La quantité vendue est bornée à la position détenue par l'exécuteur (qui connaît le prix et le taux).
      adjustedSizeCad = intent.sizeCad;
    }
  }

  if (reasons.length > 0) return { allowed: false, reasons };
  return { allowed: true, reasons: [], adjustedSizeCad };
}
