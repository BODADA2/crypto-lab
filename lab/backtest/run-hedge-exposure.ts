/**
 * Extension hedge — exposure-reduction (H-HEDGE-EXPOSURE) + stratégie de référence.
 *
 * Phase : DÉCOUVERTE UNIQUEMENT. Données : data/history/ (biaisées, borne
 * optimiste). Le holdout data/track-unbiased/ n'est JAMAIS touché.
 *
 * Contenu :
 *  1. Score composite explicite (pas le rendement brut) :
 *       S = (E_w − λ_DD·DD − λ_σ·σ) × P_oos
 *     E_w   = espérance winsorisée au p99 (mise = 1)
 *     DD    = drawdown max additif sur rendements winsorisés, en unités de mise
 *             (même définition que summarizeVariant)
 *     σ     = écart-type des rendements nets par trade, winsorisés
 *     λ_DD = 0,001, λ_σ = 0,05 (choix d'échelle documentés, phase découverte).
 *     Forme additive volontaire : avec E_w < 0, un ratio E_w/risque inverserait
 *     la préférence (plus de risque = score « meilleur »). Ici le risque
 *     dégrade toujours le score.
 *     P_oos = 1 / (1 + I) — pénalité d'instabilité walk-forward
 *     I     = |S_is − S_oos| / (|S_is| + |S_oos| + 0,01)
 *     Walk-forward : 60 % premiers trades (ordre chronologique d'entrée) = IS,
 *     40 % derniers = OOS. Proxy FAIBLE (même fenêtre biaisée de 5 jours) —
 *     le vrai OOS est le holdout 30 j.
 *     Règle de veto : un score n'est actionnable que si PF_w ≥ 1 ET médiane ≥ 0,
 *     sinon NO_TRADE quel que soit le rang.
 *  2. H-HEDGE-EXPOSURE : disjoncteur d'exposition (détecte la dégradation et
 *     réduit/supprime l'exposition). Paramètres PRÉ-ENGAGÉS avant tout résultat :
 *     fenêtre K=30 trades complétés, suspension si winRate < 35 % ET médiane < 0,
 *     reprise si médiane > 0. Modes HALT (exposition 0) et HALVE (×0,5).
 *     Mesures : délai de détection vs début des drawdowns, ΔDD, ΔE_w,
 *     coût des faux positifs (gagnants ratés pendant la suspension).
 *     Sensibilité K×seuil rapportée comme contrôle de robustesse —
 *     JAMAIS utilisée pour sélectionner le hedge (interdiction méthodologique).
 *  3. Décorrélation MESURÉE (jamais supposée) : corrélations de Spearman
 *     roulantes des P&L et des drawdowns, avec corrélation « sous stress »
 *     (quand le DD de A dépasse sa médiane). La paire candidate est choisie
 *     sur la décorrélation mesurée, pas sur le résultat final du portefeuille.
 *
 * Usage : npx tsx lab/backtest/run-hedge-exposure.ts [rootDir]
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistoryDir } from "./harness.ts";
import {
  buildVariants,
  loadRegimeByDay,
  summarizeVariant,
  winsorize,
  mean,
  std,
  median,
  quantile,
  spearman,
  blendPortfolio,
  VARIANT_LABELS,
  type HTrade,
  type VariantId,
} from "./run-hedge-analysis.ts";

/** Ré-exporté pour les tests (source : run-hedge-analysis). */
export type { HTrade, VariantId };

// ---------------------------------------------------------------------------
// 0. Utilitaires locaux
// ---------------------------------------------------------------------------

function fmtP(x: number | null, digits = 2): string {
  return x === null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(digits)} %`;
}
function fmt2(x: number | null): string {
  return x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(2);
}

/** Drawdown max additif en unités de mise (équité partant de 0).
 * Même définition que summarizeVariant : rendements WINSORISÉS, ordre chronologique. */
export function maxDDUnitsW(winsorizedRetsChrono: number[]): number {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const r of winsorizedRetsChrono) {
    eq += r;
    if (eq > peak) peak = eq;
    const cur = peak - eq;
    if (cur > dd) dd = cur;
  }
  return dd;
}

/** Rendements nets en ordre chronologique d'entrée. */
export function chronoRets(trades: HTrade[]): number[] {
  return [...trades].sort((a, b) => a.entryAt.localeCompare(b.entryAt)).map((t) => t.ret);
}

/** Profit factor sur rendements winsorisés (robuste aux outliers). */
export function profitFactorW(winsorizedRets: number[]): number | null {
  let gains = 0;
  let losses = 0;
  for (const r of winsorizedRets) {
    if (r > 0) gains += r;
    else losses -= r;
  }
  if (losses <= 0) return gains > 0 ? Infinity : null;
  return gains / losses;
}

// ---------------------------------------------------------------------------
// 1. Score composite
// ---------------------------------------------------------------------------

export interface CompositeScore {
  id: string;
  n: number;
  /** Composantes */
  Ew: number | null;
  DD: number | null;
  sigma: number | null;
  pfW: number | null;
  medianRet: number | null;
  /** Walk-forward */
  scoreIS: number | null;
  scoreOOS: number | null;
  instability: number | null;
  pOos: number | null;
  /** Score final */
  score: number | null;
  /** Vetos */
  vetoPF: boolean;
  vetoMedian: boolean;
  actionable: boolean;
  conclusive: boolean;
}

/**
 * Score brut (sans pénalité OOS).
 * Forme ADDITIVE (pas un ratio) : avec E_w < 0, diviser par le risque
 * inverserait la préférence (plus de DD = score « meilleur »). Ici un DD
 * ou une σ plus élevés dégradent toujours le score.
 * λ_DD = 0,001 : 50 unités de DD pèsent ≈ une espérance de −5 %.
 * λ_σ  = 0,05  : une σ de 0,6 pèse ≈ −3 %. Choix d'échelle documentés,
 * phase découverte — à challenger, pas des constantes universelles.
 */
export const LAMBDA_DD = 0.001;
export const LAMBDA_SIGMA = 0.05;
function rawScore(Ew: number, DD: number, sigma: number): number {
  return Ew - LAMBDA_DD * DD - LAMBDA_SIGMA * sigma;
}

/**
 * Score composite d'une série de trades.
 * Formule documentée : S = (E_w − λ_DD·DD − λ_σ·σ) × P_oos
 */
export function compositeScore(id: string, trades: HTrade[], winsorCap: number): CompositeScore {
  return compositeScoreFromRets(id, chronoRets(trades), winsorCap);
}

/** Variante sur rendements déjà en ordre chronologique (ex. série protégée). */
export function compositeScoreFromRets(id: string, retsChrono: number[], winsorCap: number): CompositeScore {
  const base = {
    id,
    n: retsChrono.length,
    Ew: null as number | null,
    DD: null as number | null,
    sigma: null as number | null,
    pfW: null as number | null,
    medianRet: null as number | null,
    scoreIS: null as number | null,
    scoreOOS: null as number | null,
    instability: null as number | null,
    pOos: null as number | null,
    score: null as number | null,
    vetoPF: true,
    vetoMedian: true,
    actionable: false,
    conclusive: retsChrono.length >= 30,
  };
  if (!retsChrono.length) return base;
  // retsChrono est déjà en ordre chronologique d'entrée.
  const rets = retsChrono;
  const w = winsorize(rets, winsorCap);
  const Ew = mean(w);
  const DD = maxDDUnitsW(w);
  const sigma = std(w);
  const pfW = profitFactorW(w);
  const med = median(rets);

  // Walk-forward 60/40 chronologique (ordre d'entrée)
  const cut = Math.max(1, Math.floor(rets.length * 0.6));
  const rIS = rets.slice(0, cut);
  const rOOS = rets.slice(cut);
  let scoreIS: number | null = null;
  let scoreOOS: number | null = null;
  let instability: number | null = null;
  let pOos: number | null = null;
  if (rIS.length >= 10 && rOOS.length >= 10) {
    const wIS = winsorize(rIS, winsorCap);
    const wOOS = winsorize(rOOS, winsorCap);
    scoreIS = rawScore(mean(wIS), maxDDUnitsW(wIS), std(wIS));
    scoreOOS = rawScore(mean(wOOS), maxDDUnitsW(wOOS), std(wOOS));
    instability = Math.abs(scoreIS - scoreOOS) / (Math.abs(scoreIS) + Math.abs(scoreOOS) + 0.01);
    pOos = 1 / (1 + (instability as number));
  }

  const score = rawScore(Ew, DD, sigma) * (pOos ?? 1);
  const vetoPF = !(pfW !== null && Number.isFinite(pfW) && pfW >= 1);
  const vetoMedian = !(med >= 0);
  return {
    ...base,
    Ew,
    DD,
    sigma,
    pfW: pfW === Infinity ? null : pfW,
    medianRet: med,
    scoreIS,
    scoreOOS,
    instability,
    pOos,
    score,
    vetoPF,
    vetoMedian,
    actionable: !vetoPF && !vetoMedian,
  };
}

// ---------------------------------------------------------------------------
// 2. H-HEDGE-EXPOSURE : disjoncteur d'exposition
// ---------------------------------------------------------------------------

export interface BreakerParams {
  /** Fenêtre glissante (trades complétés). */
  windowK: number;
  /** Suspension si winRate(fenêtre) < seuil ET médiane(fenêtre) < 0. */
  haltWinRate: number;
}

/**
 * Paramètres PRIMAIRES — PRÉ-ENGAGÉS avant tout résultat (nombres ronds,
 * principe : ~1/2 journée de trades, suspension sous 35 % de réussite).
 * La sensibilité est rapportée comme contrôle, jamais pour sélectionner.
 */
export const BREAKER_PRIMARY: BreakerParams = { windowK: 30, haltWinRate: 0.35 };
export const BREAKER_SENSITIVITY_K = [15, 30, 60];
export const BREAKER_SENSITIVITY_WR = [0.3, 0.35, 0.4];

export type BreakerMode = "halt" | "halve";

export interface DDEpisode {
  startIdx: number;
  troughIdx: number;
  endIdx: number;
  depth: number;
}

/** Épisodes de drawdown pic→creux→nouveau pic sur une courbe d'équité. */
export function drawdownEpisodes(equity: number[]): DDEpisode[] {
  const eps: DDEpisode[] = [];
  if (!equity.length) return eps;
  let peak = equity[0] as number;
  let peakIdx = 0;
  let trough = peak;
  let troughIdx = 0;
  let inDD = false;
  for (let i = 1; i < equity.length; i++) {
    const e = equity[i] as number;
    if (e > peak) {
      if (inDD) {
        eps.push({ startIdx: peakIdx, troughIdx, endIdx: i, depth: peak - trough });
        inDD = false;
      }
      peak = e;
      peakIdx = i;
      trough = e;
      troughIdx = i;
    } else {
      if (e < trough) {
        trough = e;
        troughIdx = i;
      }
      inDD = true;
    }
  }
  if (inDD) eps.push({ startIdx: peakIdx, troughIdx, endIdx: equity.length - 1, depth: peak - trough });
  return eps;
}

export interface SkippedTrade {
  entryAt: string;
  hypotheticalRet: number;
}

export interface BreakerResult {
  baseId: string;
  mode: BreakerMode;
  params: BreakerParams;
  nTotal: number;
  nTraded: number;
  nSkipped: number;
  /** Nombre de périodes de suspension déclenchées. */
  haltEpisodes: number;
  /** Index (ordre d'entrée) des déclenchements de suspension. */
  haltTriggers: number[];
  protectedRets: number[];
  skipped: SkippedTrade[];
  /** Coût des faux positifs : gagnants ratés pendant les suspensions. */
  missedWinners: number;
  missedPnL: number;
  /** Bénéfice : pertes évitées pendant les suspensions. */
  avoidedLosers: number;
  avoidedLoss: number;
  /** Délai de détection par épisode de DD (trades entre début du DD et suspension ; null = non détecté). */
  detectionDelays: (number | null)[];
  /** Épisodes où la suspension était déjà active au début (délai 0 légitime). */
  alreadyHaltedCount: number;
  ddEpisodes: DDEpisode[];
  /** Stats comparatives */
  EwBase: number | null;
  EwProtected: number | null;
  ddBase: number | null;
  ddProtected: number | null;
  pfWBase: number | null;
  pfWProtected: number | null;
}

function winRateOf(xs: number[]): number {
  return xs.length ? xs.filter((x) => x > 0).length / xs.length : 0;
}

/**
 * Simule le disjoncteur en séquence temporelle TRADABLE : à chaque candidat,
 * la fenêtre ne contient que les trades COMPLÉTÉS (exitAt ≤ entryAt du candidat).
 */
export function runCircuitBreaker(
  allTrades: HTrade[],
  params: BreakerParams,
  mode: BreakerMode,
  winsorCap: number,
  baseId: string,
): BreakerResult {
  const sorted = [...allTrades].sort((a, b) => a.entryAt.localeCompare(b.entryAt));
  const protectedRets: number[] = [];
  const skipped: SkippedTrade[] = [];
  const haltTriggers: number[] = [];
  /** État de suspension à chaque index candidat (ordre d'entrée) — mesure honnête du délai. */
  const haltedAt: boolean[] = [];
  let halted = false;
  let haltEpisodes = 0;
  const MIN_WINDOW = 10;

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i] as HTrade;
    // Fenêtre : trades complétés avant l'entrée du candidat
    const completed = sorted
      .slice(0, i)
      .filter((x) => (x.exitAt === undefined ? true : (x.exitAt as string) <= t.entryAt));
    const win = completed.slice(-params.windowK);
    if (win.length >= MIN_WINDOW) {
      const wr = winRateOf(win.map((x) => x.ret));
      const med = median(win.map((x) => x.ret));
      if (!halted && wr < params.haltWinRate && med < 0) {
        halted = true;
        haltEpisodes++;
        haltTriggers.push(i);
      } else if (halted && med > 0) {
        halted = false;
      }
    }
    haltedAt.push(halted);
    if (halted) {
      if (mode === "halt") {
        skipped.push({ entryAt: t.entryAt, hypotheticalRet: t.ret });
      } else {
        protectedRets.push(t.ret * 0.5);
      }
    } else {
      protectedRets.push(t.ret);
    }
  }

  // Faux positifs vs pertes évitées
  let missedWinners = 0;
  let missedPnL = 0;
  let avoidedLosers = 0;
  let avoidedLoss = 0;
  for (const s of skipped) {
    if (s.hypotheticalRet > 0) {
      missedWinners++;
      missedPnL += s.hypotheticalRet;
    } else {
      avoidedLosers++;
      avoidedLoss -= s.hypotheticalRet;
    }
  }

  // Épisodes de DD sur la courbe NON protégée (ordre d'entrée)
  const baseRets = sorted.map((t) => t.ret);
  const equity: number[] = [];
  let eq = 0;
  for (const r of baseRets) {
    eq += r;
    equity.push(eq);
  }
  const ddEpisodes = drawdownEpisodes(equity);
  const triggerSet = new Set(haltTriggers);
  // Délai honnête : si déjà suspendu au début de l'épisode → 0 (distingué) ;
  // sinon premier NOUVEAU déclenchement dans l'épisode ; sinon null (non détecté).
  const detectionDelays: (number | null)[] = ddEpisodes.map((ep) => {
    if (haltedAt[ep.startIdx]) return 0;
    for (let i = ep.startIdx + 1; i <= ep.endIdx; i++) {
      if (triggerSet.has(i)) return i - ep.startIdx;
    }
    return null;
  });
  const alreadyHaltedCount = ddEpisodes.filter((ep, k) => detectionDelays[k] === 0 && haltedAt[ep.startIdx]).length;

  const wBase = winsorize(baseRets, winsorCap);
  const wProt = winsorize(protectedRets, winsorCap);
  return {
    baseId,
    mode,
    params,
    nTotal: sorted.length,
    nTraded: protectedRets.length,
    nSkipped: skipped.length,
    haltEpisodes,
    haltTriggers,
    protectedRets,
    skipped,
    missedWinners,
    missedPnL,
    avoidedLosers,
    avoidedLoss,
    detectionDelays,
    alreadyHaltedCount,
    ddEpisodes,
    EwBase: baseRets.length ? mean(wBase) : null,
    EwProtected: protectedRets.length ? mean(wProt) : null,
    ddBase: baseRets.length ? maxDDUnitsW(wBase) : null,
    ddProtected: protectedRets.length ? maxDDUnitsW(wProt) : null,
    pfWBase: profitFactorW(wBase),
    pfWProtected: profitFactorW(wProt),
  };
}

// ---------------------------------------------------------------------------
// 3. Décorrélation mesurée : corrélations roulantes P&L et drawdowns
// ---------------------------------------------------------------------------

export interface PairedSeries {
  xs: number[];
  ys: number[];
  n: number;
}

export function commonMintSeries(a: HTrade[], b: HTrade[]): PairedSeries {
  const mb = new Map<string, HTrade>();
  for (const t of b) mb.set(t.mint, t);
  const pairs: { x: number; y: number; t: string }[] = [];
  for (const t of a) {
    const o = mb.get(t.mint);
    if (o) pairs.push({ x: t.ret, y: o.ret, t: t.entryAt });
  }
  pairs.sort((p, q) => p.t.localeCompare(q.t));
  return { xs: pairs.map((p) => p.x), ys: pairs.map((p) => p.y), n: pairs.length };
}

export interface RollingCorr {
  pair: string;
  n: number;
  nWindows: number;
  window: number;
  /** Corrélation roulante des P&L par trade */
  pnlMean: number | null;
  pnlMin: number | null;
  pnlMax: number | null;
  /** Corrélation roulante des séries de drawdown */
  ddMean: number | null;
  ddMin: number | null;
  ddMax: number | null;
  /** Corrélation moyenne « sous stress » (fenêtres où le DD de A > médiane) */
  stressMean: number | null;
  stressN: number;
}

function rollingStats(series: number[], other: number[], window: number, step: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let st = 0; st + window <= series.length; st += step) {
    const c = spearman(series.slice(st, st + window), other.slice(st, st + window));
    out.push(Number.isFinite(c) ? c : null);
  }
  return out;
}

function ddSeries(rets: number[]): number[] {
  const out: number[] = [];
  let eq = 0;
  let peak = 0;
  for (const r of rets) {
    eq += r;
    if (eq > peak) peak = eq;
    out.push(peak - eq);
  }
  return out;
}

export function rollingCorrelation(
  a: HTrade[],
  b: HTrade[],
  labelA: string,
  labelB: string,
  window = 50,
  step = 10,
): RollingCorr {
  const ps = commonMintSeries(a, b);
  const base: RollingCorr = {
    pair: `${labelA}×${labelB}`,
    n: ps.n,
    nWindows: 0,
    window,
    pnlMean: null,
    pnlMin: null,
    pnlMax: null,
    ddMean: null,
    ddMin: null,
    ddMax: null,
    stressMean: null,
    stressN: 0,
  };
  if (ps.n < window + step) return base;
  const pnlCorrs = rollingStats(ps.xs, ps.ys, window, step).filter((c): c is number => c !== null);
  const dda = ddSeries(ps.xs);
  const ddb = ddSeries(ps.ys);
  const ddCorrs = rollingStats(dda, ddb, window, step).filter((c): c is number => c !== null);
  // Stress : fenêtres où le DD de A dépasse sa médiane
  const medDDa = median(dda);
  const stress: number[] = [];
  let w = 0;
  for (let st = 0; st + window <= ps.xs.length; st += step) {
    const c = spearman(ps.xs.slice(st, st + window), ps.ys.slice(st, st + window));
    if (!Number.isFinite(c)) {
      w++;
      continue;
    }
    if (median(dda.slice(st, st + window)) > medDDa) stress.push(c);
    w++;
  }
  const avg = (xs: number[]) => (xs.length ? mean(xs) : null);
  void w;
  return {
    ...base,
    nWindows: pnlCorrs.length,
    pnlMean: avg(pnlCorrs),
    pnlMin: pnlCorrs.length ? Math.min(...pnlCorrs) : null,
    pnlMax: pnlCorrs.length ? Math.max(...pnlCorrs) : null,
    ddMean: avg(ddCorrs),
    ddMin: ddCorrs.length ? Math.min(...ddCorrs) : null,
    ddMax: ddCorrs.length ? Math.max(...ddCorrs) : null,
    stressMean: avg(stress),
    stressN: stress.length,
  };
}

// ---------------------------------------------------------------------------
// 4. Exécution
// ---------------------------------------------------------------------------

export interface ExposureAnalysisResult {
  computedAt: string;
  dataBiasNote: string;
  winsorCap: number;
  compositeScores: CompositeScore[];
  breakerPrimary: BreakerResult[];
  breakerSensitivity: {
    baseId: string;
    mode: BreakerMode;
    windowK: number;
    haltWinRate: number;
    EwProtected: number | null;
    ddProtected: number | null;
    nSkipped: number;
    haltEpisodes: number;
  }[];
  rollingCorrs: RollingCorr[];
  /** Portefeuille 50/50 de la paire la plus décorrélée (choix sur décorrélation mesurée). */
  decorrelatedPair: { pair: string; stressMean: number | null } | null;
  portfolioDecorrelated: {
    pair: string;
    n: number;
    score: CompositeScore;
    scoreA: number | null;
    scoreB: number | null;
  } | null;
}

export function runExposureAnalysis(rootDir: string): ExposureAnalysisResult {
  const seriesByMint = loadHistoryDir(join(rootDir, "data", "history"));
  const regimeByDay = loadRegimeByDay(join(rootDir, "data", "scans"));
  const variants = buildVariants(seriesByMint, regimeByDay);
  const ids = Object.keys(variants) as VariantId[];

  const pooledRets = ids.flatMap((id) => variants[id].map((t) => t.ret)).sort((a, b) => a - b);
  const winsorCap = quantile(pooledRets, 0.99);

  // 1. Scores composites V1..V10
  const compositeScores = ids.map((id) => compositeScore(id, variants[id], winsorCap));

  // 2. Disjoncteur : paramètres primaires sur V1 et V10
  const breakerPrimary: BreakerResult[] = [];
  for (const baseId of ["V1", "V10"] as VariantId[]) {
    for (const mode of ["halt", "halve"] as BreakerMode[]) {
      breakerPrimary.push(runCircuitBreaker(variants[baseId], BREAKER_PRIMARY, mode, winsorCap, baseId));
    }
  }

  // Sensibilité : contrôle de robustesse (pas de sélection dessus)
  const breakerSensitivity: ExposureAnalysisResult["breakerSensitivity"] = [];
  for (const baseId of ["V1", "V10"] as VariantId[]) {
    for (const k of BREAKER_SENSITIVITY_K) {
      for (const wr of BREAKER_SENSITIVITY_WR) {
        const r = runCircuitBreaker(variants[baseId], { windowK: k, haltWinRate: wr }, "halt", winsorCap, baseId);
        breakerSensitivity.push({
          baseId,
          mode: "halt",
          windowK: k,
          haltWinRate: wr,
          EwProtected: r.EwProtected,
          ddProtected: r.ddProtected,
          nSkipped: r.nSkipped,
          haltEpisodes: r.haltEpisodes,
        });
      }
    }
  }

  // 3. Corrélations roulantes — paires candidates
  const pairs: [VariantId, VariantId][] = [
    ["V1", "V4"],
    ["V10", "V4"],
    ["V10", "V1"],
    ["V3", "V4"],
  ];
  const rollingCorrs = pairs.map(([a, b]) => rollingCorrelation(variants[a], variants[b], a, b));

  // Choix de la paire sur la décorrélation MESURÉE (stress d'abord, puis moyenne),
  // jamais sur le résultat final du portefeuille.
  const ranked = [...rollingCorrs]
    .filter((r) => r.stressMean !== null && r.nWindows >= 5)
    .sort((x, y) => (x.stressMean as number) - (y.stressMean as number));
  const best = ranked[0] ?? null;
  let portfolioDecorrelated: ExposureAnalysisResult["portfolioDecorrelated"] = null;
  if (best) {
    const [la, lb] = best.pair.split("×") as [VariantId, VariantId];
    const pf = blendPortfolio(variants[la], variants[lb]);
    const score = compositeScore(`${la}+${lb} 50/50`, pf, winsorCap);
    const sA = compositeScores.find((s) => s.id === la)?.score ?? null;
    const sB = compositeScores.find((s) => s.id === lb)?.score ?? null;
    portfolioDecorrelated = { pair: best.pair, n: pf.length, score, scoreA: sA, scoreB: sB };
  }

  return {
    computedAt: new Date().toISOString(),
    dataBiasNote:
      "DÉCOUVERTE — data/history/ biaisée vers les tokens chauds : borne optimiste. " +
      "Holdout data/track-unbiased/ jamais touché. Walk-forward 60/40 sur 5 jours = proxy faible.",
    winsorCap,
    compositeScores,
    breakerPrimary,
    breakerSensitivity,
    rollingCorrs,
    decorrelatedPair: best ? { pair: best.pair, stressMean: best.stressMean } : null,
    portfolioDecorrelated,
  };
}

function printExposure(r: ExposureAnalysisResult): void {
  console.log("=== EXPOSURE-REDUCTION (DÉCOUVERTE — borne optimiste) ===");
  console.log(`Cap winsorisation p99 : ${(r.winsorCap * 100).toFixed(1)} %`);
  console.log("\n--- Scores composites S = (E_w − λ_DD·DD − λ_σ·σ) × P_oos ---");
  console.log("    (veto : PF_w ≥ 1 ET médiane ≥ 0, sinon NO_TRADE quel que soit le rang)");
  const sorted = [...r.compositeScores].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  for (const s of sorted) {
    console.log(
      `${s.id} ${(VARIANT_LABELS as Record<string, string>)[s.id] ?? s.id} : n=${s.n}${s.conclusive ? "" : " (NON CONCLUANT)"}\n` +
        `    S=${s.score === null ? "n/a" : s.score.toFixed(5)} | E_w=${fmtP(s.Ew)} DD=${fmt2(s.DD)}×mise σ=${fmt2(s.sigma)} PF_w=${fmt2(s.pfW)} méd=${fmtP(s.medianRet)}\n` +
        `    WF: S_is=${s.scoreIS === null ? "n/a" : s.scoreIS.toFixed(5)} S_oos=${s.scoreOOS === null ? "n/a" : s.scoreOOS.toFixed(5)} I=${s.instability === null ? "n/a" : s.instability.toFixed(2)} P_oos=${s.pOos === null ? "n/a" : s.pOos.toFixed(2)} | actionnable=${s.actionable ? "OUI" : "NON"} (vetoPF=${s.vetoPF} vetoMed=${s.vetoMedian})`,
    );
  }

  console.log("\n--- H-HEDGE-EXPOSURE : disjoncteur (paramètres primaires K=30, WR<35 %) ---");
  for (const b of r.breakerPrimary) {
    const delays = b.detectionDelays.filter((d): d is number => d !== null);
    const undetected = b.detectionDelays.filter((d) => d === null).length;
    const newTriggers = delays.filter((d) => d > 0);
    const sProt = compositeScoreFromRets(`${b.baseId}+disjoncteur`, b.protectedRets, r.winsorCap);
    const sBase = r.compositeScores.find((s) => s.id === b.baseId);
    console.log(
      `${b.baseId} mode=${b.mode} : n=${b.nTotal} tradés=${b.nTraded} skippés=${b.nSkipped} suspensions=${b.haltEpisodes}\n` +
        `    E_w ${fmtP(b.EwBase)} → ${fmtP(b.EwProtected)} | DD ${fmt2(b.ddBase)} → ${fmt2(b.ddProtected)}×mise | PF_w ${fmt2(b.pfWBase)} → ${fmt2(b.pfWProtected)}\n` +
        `    Score composite : ${sBase?.score === null || sBase?.score === undefined ? "n/a" : sBase.score.toFixed(5)} → ${sProt.score === null ? "n/a" : sProt.score.toFixed(5)} | actionnable=${sProt.actionable ? "OUI" : "NON"}\n` +
        `    Faux positifs : ${b.missedWinners} gagnants ratés (${fmtP(b.missedPnL)} manqués) | Pertes évitées : ${b.avoidedLosers} trades (${fmtP(b.avoidedLoss)})\n` +
        `    Épisodes DD : ${b.ddEpisodes.length}, détectés ${delays.length}/${b.ddEpisodes.length} (dont déjà suspendus : ${b.alreadyHaltedCount}, non détectés : ${undetected}), délai médian des nouveaux déclenchements ${newTriggers.length ? median(newTriggers).toFixed(0) + " trades" : "n/a"}`,
    );
  }

  console.log("\n--- Sensibilité du disjoncteur (contrôle de robustesse — pas de sélection) ---");
  for (const s of r.breakerSensitivity) {
    console.log(
      `${s.baseId} ${s.mode} K=${s.windowK} WR<${s.haltWinRate} : E_w=${fmtP(s.EwProtected)} DD=${fmt2(s.ddProtected)}×mise skippés=${s.nSkipped} suspensions=${s.haltEpisodes}`,
    );
  }

  console.log("\n--- Décorrélation mesurée : corrélations roulantes (fenêtre 50, pas 10) ---");
  for (const c of r.rollingCorrs) {
    console.log(
      `${c.pair} : n=${c.n} fenêtres=${c.nWindows}\n` +
        `    P&L roulant : moy=${c.pnlMean === null ? "n/a" : c.pnlMean.toFixed(2)} min=${c.pnlMin === null ? "n/a" : c.pnlMin.toFixed(2)} max=${c.pnlMax === null ? "n/a" : c.pnlMax.toFixed(2)}\n` +
        `    DD roulant  : moy=${c.ddMean === null ? "n/a" : c.ddMean.toFixed(2)} min=${c.ddMin === null ? "n/a" : c.ddMin.toFixed(2)} max=${c.ddMax === null ? "n/a" : c.ddMax.toFixed(2)}\n` +
        `    Sous stress (DD_A > médiane) : moy=${c.stressMean === null ? "n/a" : c.stressMean.toFixed(2)} (n=${c.stressN})`,
    );
  }

  if (r.decorrelatedPair && r.portfolioDecorrelated) {
    const p = r.portfolioDecorrelated;
    console.log(
      `\n--- Portefeuille 50/50 — paire choisie sur décorrélation mesurée : ${r.decorrelatedPair.pair} (stress ρ=${r.decorrelatedPair.stressMean === null ? "n/a" : r.decorrelatedPair.stressMean.toFixed(2)}) ---`,
    );
    console.log(
      `${p.pair} : n=${p.n} S=${p.score.score === null ? "n/a" : p.score.score.toFixed(5)} (vs ${p.scoreA === null ? "n/a" : p.scoreA.toFixed(5)} / ${p.scoreB === null ? "n/a" : p.scoreB.toFixed(5)}) | E_w=${fmtP(p.score.Ew)} DD=${fmt2(p.score.DD)}×mise | actionnable=${p.score.actionable ? "OUI" : "NON"}`,
    );
  } else {
    console.log("\n--- Portefeuille : aucune paire mesurable comme décorrélée — pas de portefeuille justifié ---");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const result = runExposureAnalysis(rootDir);
  printExposure(result);
  console.log("\n--- JSON complet ---");
  console.log(JSON.stringify(result));
}
