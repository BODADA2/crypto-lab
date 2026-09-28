/**
 * DÉCOMPOSITION ÉCONOMIQUE DE L'ESPÉRANCE NÉGATIVE — H-REF-MOM (V10).
 *
 * STOP à l'optimisation : ce module DIAGNOSTIQUE. Question centrale :
 * existe-t-il un edge brut entièrement détruit par les coûts (auquel cas le
 * problème est l'exécution / la structure de marché), ou n'y a-t-il déjà
 * aucun edge avant coûts ?
 *
 * Méthode : pour chaque trade V10 (entrée verticale, sortie scalp), on rejoue
 * la sortie UNE fois à coûts nuls (le chemin de sortie ne dépend que du prix,
 * jamais des coûts), puis on applique algébriquement chaque échelon
 * counterfactual. Aucun ré-échantillonnage, aucune calibration sur ces
 * données : pure comptabilité.
 *
 * Échelons (par trade) :
 *   brutIdéal  — entrée AU prix du signal (délai 0), zéro coût
 *   brutRéel   — entrée à t+1 (anti-lookahead réel), zéro coût
 *   fraisSeuls — brutRéel − frais 1,3 % aller-retour
 *   slipSeul   — brutRéel − slippage linéaire (size/liq, cap 3 %)
 *   net        — brutRéel − frais − slippage (modèle officiel du labo)
 *
 * Données : data/history/ (biaisée vers les tokens chauds → BORNE OPTIMISTE).
 * Holdout data/track-unbiased/ : jamais touché.
 */
import { join } from "node:path";
import { loadHistoryDir, estimateSlippage } from "./harness.ts";
import { simulateExit, type PricePoint } from "../signals/exit.ts";
import {
  findEntryVertical,
  mean,
  median,
  quantile,
  winsorize,
  bootstrapMeanCI,
  bootstrapMedianCI,
} from "./run-hedge-analysis.ts";
import type { TokenSnapshot } from "../types.ts";

export const DECOMP_FEES_RT = 0.013; // 1 % terminal + 0,3 % réseau/priorité
export const DECOMP_SLIP_CAP = 0.03; // politique de risque
export const DECOMP_REF_SIZE = 50; // ticket de référence ($)
export const TICKET_SIZES = [10, 25, 50, 100, 250, 500];
/** Seuil tick aberrant : variation ≥ 100× entre observations voisines. */
export const GLITCH_RATIO = 100;

export interface DecompTrade {
  mint: string;
  entryAt: string;
  /** Rendement prix seul, entrée à t+1 (zéro coût). */
  grossReal: number;
  /** Rendement prix seul, entrée au prix du signal (zéro coût). */
  grossIdeal: number;
  /** Slippage linéaire par jambe au ticket de référence. */
  slipIn: number;
  slipOut: number;
  entryLiq: number;
  exitLiq: number;
  exit: string;
  bars: number;
  /** Plus haute excursion favorable après l'entrée (prix seul). */
  mfe: number;
  /** Pire excursion adverse après l'entrée (prix seul). */
  mae: number;
  /** true si la barre d'entrée est un tick aberrant (décimales/glitch). */
  glitchEntry: boolean;
}

function toPricePoints(series: TokenSnapshot[]): PricePoint[] {
  return series.map((s) => ({ t: s.fetchedAt, price: s.priceUsd, liquidityUsd: s.liquidityUsd }));
}

function sortedSeries(raw: TokenSnapshot[]): TokenSnapshot[] {
  return [...raw].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
}

const ZERO_COSTS = { sizeUsd: DECOMP_REF_SIZE, feesRoundTrip: 0, maxSlippage: 0 };

/**
 * Détecte un tick aberrant « isolé » : le prix de la barre idx dévie d'au moins
 * GLITCH_RATIO× par rapport au voisin précédent ET au voisin suivant
 * (ex. 192 $ → 0,0038 $ → 192 $ : glitch décimal DexScreener).
 * Un effondrement permanent (mort réelle du token) n'est PAS un glitch :
 * le prix ne revient pas.
 */
export function isGlitchTick(series: TokenSnapshot[], idx: number): boolean {
  const p = series[idx]?.priceUsd ?? 0;
  if (!(p > 0)) return false;
  const prev = series[idx - 1]?.priceUsd ?? 0;
  const next = series[idx + 1]?.priceUsd ?? 0;
  if (!(prev > 0) || !(next > 0)) return false;
  const devPrev = p / prev <= 1 / GLITCH_RATIO || p / prev >= GLITCH_RATIO;
  const devNext = p / next <= 1 / GLITCH_RATIO || p / next >= GLITCH_RATIO;
  return devPrev && devNext;
}

function excursionsFrom(path: PricePoint[], entryIdx: number, exitIdx: number): { mfe: number; mae: number } {
  const entry = path[entryIdx]?.price ?? 0;
  let mfe = -Infinity;
  let mae = Infinity;
  for (let j = entryIdx + 1; j <= exitIdx && j < path.length; j++) {
    const p = path[j]?.price ?? 0;
    if (!(p > 0) || !(entry > 0)) continue;
    const r = p / entry - 1;
    if (r > mfe) mfe = r;
    if (r < mae) mae = r;
  }
  return { mfe: mfe === -Infinity ? 0 : mfe, mae: mae === Infinity ? 0 : mae };
}

/**
 * Construit les trades de décomposition pour la stratégie de référence V10
 * (entrée verticale chase ≥ 0,5, sortie scalp). La sortie est rejouée une fois
 * à coûts nuls ; tous les échelons en dérivent algébriquement.
 */
export function buildDecompTrades(seriesByMint: Map<string, TokenSnapshot[]>): DecompTrade[] {
  const out: DecompTrade[] = [];
  for (const [mint, raw] of seriesByMint) {
    const series = sortedSeries(raw);
    const spec = findEntryVertical(series);
    if (!spec) continue;
    const path = toPricePoints(series);
    const idxByTime = new Map(path.map((p, i) => [p.t, i]));
    try {
      const plan = simulateExit(path, spec.entryIdx, "scalp", ZERO_COSTS);
      const last = plan.fills[plan.fills.length - 1];
      if (!last) continue;
      const exitIdx = idxByTime.get(last.exitAt) ?? -1;
      if (exitIdx < 0) continue;
      // Échelon idéal : entrée au prix du signal (même logique de sortie).
      let grossIdeal = NaN;
      try {
        const planIdeal = simulateExit(path, spec.signalIdx, "scalp", ZERO_COSTS);
        grossIdeal = planIdeal.blendedGross;
      } catch {
        /* série inexploitable en entrée idéale */
      }
      const entry = series[spec.entryIdx] as TokenSnapshot;
      const exitBar = series[exitIdx] as TokenSnapshot;
      const { mfe, mae } = excursionsFrom(path, spec.entryIdx, exitIdx);
      out.push({
        mint,
        entryAt: entry.fetchedAt,
        grossReal: plan.blendedGross,
        grossIdeal,
        slipIn: estimateSlippage(DECOMP_REF_SIZE, entry.liquidityUsd, DECOMP_SLIP_CAP),
        slipOut: estimateSlippage(DECOMP_REF_SIZE, exitBar.liquidityUsd, DECOMP_SLIP_CAP),
        entryLiq: entry.liquidityUsd,
        exitLiq: exitBar.liquidityUsd,
        exit: last.exit,
        bars: last.bars,
        mfe,
        mae,
        glitchEntry: isGlitchTick(series, spec.entryIdx),
      });
    } catch {
      /* série inexploitable — comme le harnais canonique */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Échelons counterfactual (algébriques, par trade)
// ---------------------------------------------------------------------------

export function rungFeesOnly(t: DecompTrade): number {
  return (1 + t.grossReal) * (1 - DECOMP_FEES_RT) - 1;
}

export function rungSlipOnly(t: DecompTrade, sizeUsd: number): number {
  const si = estimateSlippage(sizeUsd, t.entryLiq, DECOMP_SLIP_CAP);
  const so = estimateSlippage(sizeUsd, t.exitLiq, DECOMP_SLIP_CAP);
  return (1 + t.grossReal) * (1 - si) * (1 - so) - 1;
}

export function rungNet(t: DecompTrade, sizeUsd: number): number {
  const si = estimateSlippage(sizeUsd, t.entryLiq, DECOMP_SLIP_CAP);
  const so = estimateSlippage(sizeUsd, t.exitLiq, DECOMP_SLIP_CAP);
  return (1 + t.grossReal) * (1 - si) * (1 - so) * (1 - DECOMP_FEES_RT) - 1;
}

/**
 * Variante EXPLORATOIRE (non validée) : loi en racine carrée de l'impact,
 * ancrée au modèle linéaire à 50 $ (même slippage à 50 $, croissance en
 * sqrt(size/50) au-delà). Cap 15 %. Sert uniquement à montrer à quelle vitesse
 * les coûts explosent si l'impact réel est sur-linéaire — le modèle linéaire
 * est une borne basse optimiste pour les gros tickets.
 */
export function sqrtSlip(linearSlipAt50: number, sizeUsd: number): number {
  return Math.min(0.15, linearSlipAt50 * Math.sqrt(sizeUsd / 50));
}

export function rungNetSqrt(t: DecompTrade, sizeUsd: number): number {
  const si = sqrtSlip(t.slipIn, sizeUsd);
  const so = sqrtSlip(t.slipOut, sizeUsd);
  return (1 + t.grossReal) * (1 - si) * (1 - so) * (1 - DECOMP_FEES_RT) - 1;
}

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------

export interface RungStats {
  n: number;
  meanRaw: number;
  meanWins: number;
  meanWinsCI: [number, number];
  median: number;
  medianCI: [number, number];
  winRate: number;
  profitFactor: number;
}

export function winsorizedMean(xs: number[]): number {
  if (!xs.length) return NaN;
  const cap = Math.max(Math.abs(quantile(xs, 0.99)), Math.abs(quantile(xs, 0.01)));
  return mean(winsorize(xs, cap));
}

export function rungStats(rets: number[]): RungStats {
  const n = rets.length;
  const wins = rets.filter((r) => r > 0);
  const sumPos = wins.reduce((a, b) => a + b, 0);
  const sumNeg = rets.filter((r) => r <= 0).reduce((a, b) => a + b, 0);
  return {
    n,
    meanRaw: mean(rets),
    meanWins: winsorizedMean(rets),
    meanWinsCI: bootstrapMeanCI(rets),
    median: median(rets),
    medianCI: bootstrapMedianCI(rets),
    winRate: wins.length / n,
    profitFactor: sumNeg < 0 ? sumPos / Math.abs(sumNeg) : wins.length ? Infinity : NaN,
  };
}

export interface LadderRow {
  rung: string;
  stats: RungStats;
}

/** Échelle counterfactual complète au ticket de référence (50 $). */
export function counterfactualLadder(trades: DecompTrade[]): LadderRow[] {
  const withIdeal = trades.filter((t) => Number.isFinite(t.grossIdeal));
  return [
    { rung: "brutIdéal (entrée au signal, zéro coût)", stats: rungStats(withIdeal.map((t) => t.grossIdeal)) },
    { rung: "brutRéel (entrée t+1, zéro coût)", stats: rungStats(trades.map((t) => t.grossReal)) },
    { rung: "fraisSeuls (t+1, frais 1,3 %)", stats: rungStats(trades.map(rungFeesOnly)) },
    { rung: "slipSeul (t+1, slippage linéaire)", stats: rungStats(trades.map((t) => rungSlipOnly(t, DECOMP_REF_SIZE))) },
    { rung: "net (t+1, frais + slippage)", stats: rungStats(trades.map((t) => rungNet(t, DECOMP_REF_SIZE))) },
  ];
}

export interface TicketRow {
  sizeUsd: number;
  meanNetLin: number;
  medianNetLin: number;
  meanNetSqrt: number;
  /** Part des trades où une jambe touche le cap de 3 % (modèle linéaire). */
  capHitRate: number;
  /** Part des trades où le ticket > 10 % de la liquidité d'entrée (probablement non exécutable). */
  unfillableRate: number;
  /** Coût moyen du slippage seul (linéaire), en points de rendement. */
  meanSlipDragLin: number;
}

/** Sensibilité au ticket : modèle linéaire officiel + variante sqrt exploratoire. */
export function ticketSensitivity(trades: DecompTrade[]): TicketRow[] {
  return TICKET_SIZES.map((size) => {
    const nets = trades.map((t) => rungNet(t, size));
    const sqrtNets = trades.map((t) => rungNetSqrt(t, size));
    const slipDrags = trades.map((t) => t.grossReal - rungSlipOnly(t, size));
    let capHit = 0;
    let unfill = 0;
    for (const t of trades) {
      const si = estimateSlippage(size, t.entryLiq, DECOMP_SLIP_CAP);
      const so = estimateSlippage(size, t.exitLiq, DECOMP_SLIP_CAP);
      if (si >= DECOMP_SLIP_CAP || so >= DECOMP_SLIP_CAP) capHit++;
      if (t.entryLiq > 0 && size / t.entryLiq > 0.1) unfill++;
    }
    return {
      sizeUsd: size,
      meanNetLin: winsorizedMean(nets),
      medianNetLin: median(nets),
      meanNetSqrt: winsorizedMean(sqrtNets),
      capHitRate: capHit / trades.length,
      unfillableRate: unfill / trades.length,
      meanSlipDragLin: mean(slipDrags),
    };
  });
}

export interface ExitBreakdown {
  exit: string;
  n: number;
  share: number;
  meanGross: number;
  medianGross: number;
}

/** Ventilation par type de sortie + coût du timing de sortie (MFE − réalisé). */
export function exitAnalysis(trades: DecompTrade[]): { byExit: ExitBreakdown[]; mfeGapMean: number; mfeGapMedian: number } {
  const groups = new Map<string, DecompTrade[]>();
  for (const t of trades) {
    const g = groups.get(t.exit) ?? [];
    g.push(t);
    groups.set(t.exit, g);
  }
  const byExit: ExitBreakdown[] = [...groups.entries()].map(([exit, ts]) => ({
    exit,
    n: ts.length,
    share: ts.length / trades.length,
    meanGross: winsorizedMean(ts.map((t) => t.grossReal)),
    medianGross: median(ts.map((t) => t.grossReal)),
  }));
  const gaps = trades.map((t) => t.mfe - t.grossReal);
  return { byExit, mfeGapMean: mean(gaps), mfeGapMedian: median(gaps) };
}

export interface SelectionRow {
  bucket: string;
  n: number;
  meanGrossWins: number;
  medianGross: number;
}

/** Biais de sélection : quartiles de liquidité d'entrée + terciles de « chaleur » (nb d'observations). */
export function selectionAnalysis(
  trades: DecompTrade[],
  obsCountByMint: Map<string, number>,
): { byLiq: SelectionRow[]; byHeat: SelectionRow[] } {
  const liqs = trades.map((t) => t.entryLiq).sort((a, b) => a - b);
  const q = (p: number) => liqs[Math.min(liqs.length - 1, Math.floor(p * liqs.length))] as number;
  const liqQs = [q(0.25), q(0.5), q(0.75)];
  const byLiq: SelectionRow[] = ["Q1", "Q2", "Q3", "Q4"].map((name, i) => {
    const ts = trades.filter((t) =>
      i === 0 ? t.entryLiq <= liqQs[0]! : i === 3 ? t.entryLiq > liqQs[2]! : t.entryLiq > liqQs[i - 1]! && t.entryLiq <= liqQs[i]!,
    );
    return {
      bucket: `liq-${name} (≤${Math.round(liqQs[Math.min(i, 2)] as number)}$)`,
      n: ts.length,
      meanGrossWins: winsorizedMean(ts.map((t) => t.grossReal)),
      medianGross: ts.length ? median(ts.map((t) => t.grossReal)) : NaN,
    };
  });
  const heats = trades.map((t) => obsCountByMint.get(t.mint) ?? 0).sort((a, b) => a - b);
  const hq = (p: number) => heats[Math.min(heats.length - 1, Math.floor(p * heats.length))] as number;
  const byHeat: SelectionRow[] = ["froid", "tiède", "chaud"].map((name, i) => {
    const lo = i === 0 ? -Infinity : hq(i / 3);
    const hi = i === 2 ? Infinity : hq((i + 1) / 3);
    const ts = trades.filter((t) => {
      const h = obsCountByMint.get(t.mint) ?? 0;
      return h > lo && h <= hi;
    });
    return {
      bucket: `chaleur-${name}`,
      n: ts.length,
      meanGrossWins: winsorizedMean(ts.map((t) => t.grossReal)),
      medianGross: ts.length ? median(ts.map((t) => t.grossReal)) : NaN,
    };
  });
  return { byLiq, byHeat };
}

// ---------------------------------------------------------------------------
// Univers disjoints : découverte / calibration / validation (aucun mint commun)
// ---------------------------------------------------------------------------

export type UniverseId = "decouverte" | "calibration" | "validation";

export function splitDisjointUniverses(seriesByMint: Map<string, TokenSnapshot[]>): Record<UniverseId, string[]> {
  const mints = [...seriesByMint.entries()]
    .map(([mint, s]) => ({ mint, first: sortedSeries(s)[0]?.fetchedAt ?? "" }))
    .sort((a, b) => a.first.localeCompare(b.first))
    .map((e) => e.mint);
  const k1 = Math.floor(mints.length / 3);
  const k2 = Math.floor((2 * mints.length) / 3);
  return {
    decouverte: mints.slice(0, k1),
    calibration: mints.slice(k1, k2),
    validation: mints.slice(k2),
  };
}

export interface UniverseResult {
  universe: UniverseId;
  nMints: number;
  nTrades: number;
  grossIdealWins: number;
  grossRealWins: number;
  netWins: number;
  medianNet: number;
}

export function disjointUniverseAnalysis(seriesByMint: Map<string, TokenSnapshot[]>): UniverseResult[] {
  const split = splitDisjointUniverses(seriesByMint);
  return (Object.keys(split) as UniverseId[]).map((u) => {
    const sub = new Map<string, TokenSnapshot[]>();
    for (const m of split[u]) {
      const s = seriesByMint.get(m);
      if (s) sub.set(m, s);
    }
    const trades = buildDecompTrades(sub);
    const nets = trades.map((t) => rungNet(t, DECOMP_REF_SIZE));
    const ideal = trades.filter((t) => Number.isFinite(t.grossIdeal)).map((t) => t.grossIdeal);
    return {
      universe: u,
      nMints: sub.size,
      nTrades: trades.length,
      grossIdealWins: winsorizedMean(ideal),
      grossRealWins: winsorizedMean(trades.map((t) => t.grossReal)),
      netWins: winsorizedMean(nets),
      medianNet: trades.length ? median(nets) : NaN,
    };
  });
}

// ---------------------------------------------------------------------------
// Forensique des ticks aberrants
// ---------------------------------------------------------------------------

export interface GlitchReport {
  nTrades: number;
  nGlitchEntries: number;
  glitchMints: string[];
  /** Contribution des trades sur tick aberrant à la moyenne brute (points). */
  glitchMeanContribution: number;
  meanWinsWithGlitch: number;
  meanWinsWithoutGlitch: number;
  medianWithGlitch: number;
  medianWithoutGlitch: number;
}

export function glitchForensics(trades: DecompTrade[]): GlitchReport {
  const nets = trades.map((t) => rungNet(t, DECOMP_REF_SIZE));
  const clean = trades.filter((t) => !t.glitchEntry);
  const cleanNets = clean.map((t) => rungNet(t, DECOMP_REF_SIZE));
  const glitchNets = trades.filter((t) => t.glitchEntry).map((t) => rungNet(t, DECOMP_REF_SIZE));
  const glitchSum = glitchNets.reduce((a, b) => a + b, 0);
  return {
    nTrades: trades.length,
    nGlitchEntries: trades.filter((t) => t.glitchEntry).length,
    glitchMints: [...new Set(trades.filter((t) => t.glitchEntry).map((t) => t.mint))],
    glitchMeanContribution: trades.length ? glitchSum / trades.length : 0,
    meanWinsWithGlitch: winsorizedMean(nets),
    meanWinsWithoutGlitch: winsorizedMean(cleanNets),
    medianWithGlitch: median(nets),
    medianWithoutGlitch: clean.length ? median(cleanNets) : NaN,
  };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type EdgeVerdict = "NO_EVIDENCE_OF_EDGE" | "EDGE_BRUT_DETRUIT_PAR_COUTS" | "MIXTE_A_INTERPRETER";

export function edgeVerdict(ladder: LadderRow[]): { verdict: EdgeVerdict; detail: string } {
  const byId = new Map(ladder.map((r) => [r.rung, r.stats]));
  const ideal = byId.get("brutIdéal (entrée au signal, zéro coût)")!;
  const real = byId.get("brutRéel (entrée t+1, zéro coût)")!;
  const net = byId.get("net (t+1, frais + slippage)")!;
  // Un « edge brut » n'existe que s'il est SIGNIFICATIVEMENT positif à l'échelon
  // idéal (borne supérieure, exécution parfaite, zéro coût). Sinon, même dans le
  // meilleur des mondes, les données ne rejettent pas « pas d'edge ».
  const idealSignificant = ideal.meanWinsCI[0] > 0;
  if (idealSignificant && real.meanWins > 0 && net.meanWins < 0) {
    return {
      verdict: "EDGE_BRUT_DETRUIT_PAR_COUTS",
      detail:
        `Edge brut significativement positif à exécution idéale (${pct(ideal.meanWins)}, IC95% ` +
        `[${pct(ideal.meanWinsCI[0])} ; ${pct(ideal.meanWinsCI[1])}]), entièrement détruit par les coûts ` +
        `(net ${pct(net.meanWins)}). Problème d'exécution / structure de marché, pas de signal.`,
    };
  }
  return {
    verdict: "NO_EVIDENCE_OF_EDGE",
    detail:
      `Même à l'échelon le plus favorable (entrée au prix du signal, zéro coût), l'espérance ` +
      `winsorisée (${pct(ideal.meanWins)}, IC95% [${pct(ideal.meanWinsCI[0])} ; ${pct(ideal.meanWinsCI[1])}]) ` +
      `n'est pas significativement positive et la médiane est négative (${pct(ideal.median)}). ` +
      `Tous les échelons réalisables sont significativement négatifs (brut t+1 : ${pct(real.meanWins)} ` +
      `IC95% [${pct(real.meanWinsCI[0])} ; ${pct(real.meanWinsCI[1])}] ; net : ${pct(net.meanWins)}). ` +
      `Il n'y a pas d'edge brut à détruire : le problème n'est pas l'exécution.`,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(2)} %`;

// ---------------------------------------------------------------------------
// Runner principal
// ---------------------------------------------------------------------------

export interface DecompositionReport {
  meta: { mints: number; ticks: number; trades: number; date: string; note: string };
  ladder: Array<LadderRow & { meanRaw: number }>;
  gaps: { delaiEntree: number; frais: number; slippage: number; driftIntrinseque: number };
  tickets: TicketRow[];
  exits: { byExit: ExitBreakdown[]; mfeGapMean: number; mfeGapMedian: number };
  selection: { byLiq: SelectionRow[]; byHeat: SelectionRow[] };
  universes: UniverseResult[];
  glitch: GlitchReport;
  verdict: { verdict: EdgeVerdict; detail: string };
}

export function runDecomposition(rootDir: string): DecompositionReport {
  const seriesByMint = loadHistoryDir(join(rootDir, "data", "history"));
  let ticks = 0;
  const obsCountByMint = new Map<string, number>();
  for (const [m, s] of seriesByMint) {
    ticks += s.length;
    obsCountByMint.set(m, s.length);
  }
  const trades = buildDecompTrades(seriesByMint);
  const ladder = counterfactualLadder(trades);
  const byId = new Map(ladder.map((r) => [r.rung, r.stats]));
  const g = (id: string) => byId.get(id)!;
  const gaps = {
    driftIntrinseque: g("brutRéel (entrée t+1, zéro coût)").meanWins,
    delaiEntree: g("brutIdéal (entrée au signal, zéro coût)").meanWins - g("brutRéel (entrée t+1, zéro coût)").meanWins,
    frais: g("brutRéel (entrée t+1, zéro coût)").meanWins - g("fraisSeuls (t+1, frais 1,3 %)").meanWins,
    slippage: g("brutRéel (entrée t+1, zéro coût)").meanWins - g("slipSeul (t+1, slippage linéaire)").meanWins,
  };
  return {
    meta: {
      mints: seriesByMint.size,
      ticks,
      trades: trades.length,
      date: new Date().toISOString().slice(0, 10),
      note: "DONNÉES data/history/ BIAISÉES vers les tokens chauds : toute mesure est une BORNE OPTIMISTE. Holdout data/track-unbiased/ jamais touché.",
    },
    ladder: ladder.map((r) => ({ ...r, meanRaw: r.stats.meanRaw })),
    gaps,
    tickets: ticketSensitivity(trades),
    exits: exitAnalysis(trades),
    selection: selectionAnalysis(trades, obsCountByMint),
    universes: disjointUniverseAnalysis(seriesByMint),
    glitch: glitchForensics(trades),
    verdict: edgeVerdict(ladder),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rep = runDecomposition(process.cwd());
  const p = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "n/a");
  console.log("=== DÉCOMPOSITION ESPÉRANCE — H-REF-MOM (V10) ===");
  console.log(`mints=${rep.meta.mints} ticks=${rep.meta.ticks} trades=${rep.meta.trades}`);
  console.log("--- Échelle counterfactual (moyenne winsorisée) ---");
  for (const r of rep.ladder) console.log(`  ${r.rung}: ${p(r.stats.meanWins)} (médiane ${p(r.stats.median)}, brut ${p(r.meanRaw)})`);
  console.log("--- Gaps (points winsorisés) ---");
  console.log(`  drift intrinsèque: ${p(rep.gaps.driftIntrinseque)} | délai entrée: ${p(rep.gaps.delaiEntree)} | frais: ${p(rep.gaps.frais)} | slippage: ${p(rep.gaps.slippage)}`);
  console.log("--- Tickets ---");
  for (const t of rep.tickets) console.log(`  $${t.sizeUsd}: net_lin ${p(t.meanNetLin)} net_sqrt ${p(t.meanNetSqrt)} capHit ${(t.capHitRate*100).toFixed(1)}% unfillable ${(t.unfillableRate*100).toFixed(1)}%`);
  console.log("--- Univers disjoints ---");
  for (const u of rep.universes) console.log(`  ${u.universe}: n=${u.nTrades} idéal ${p(u.grossIdealWins)} brut ${p(u.grossRealWins)} net ${p(u.netWins)}`);
  console.log(`--- Glitch: ${rep.glitch.nGlitchEntries}/${rep.glitch.nTrades} trades, contribution moyenne ${p(rep.glitch.glitchMeanContribution)}`);
  console.log(`VERDICT: ${rep.verdict.verdict} — ${rep.verdict.detail}`);
  console.log(JSON.stringify(rep));
}
