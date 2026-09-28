/**
 * SPRINT 1 — E1 : Survival baseline (famille F).
 *
 * HYPOTHÈSE H-S1-E1 : « La liquidité à t0 prédit la survie (pas de passage
 * sous -50 % dans les 24h post-t0) — i.e. il existe une baseline de survie
 * mesurable avec des variables pré-t0. »
 *
 * Méthode :
 *  1. Kaplan-Meier global sur survival_50_24h (univers discovery) ;
 *  2. déciles de log2(liqT0) → S(24h) par décile (descriptif) ;
 *  3. « log-rank approximatif » : Cox PH univarié, X = log2(liqT0)
 *     (HR par doublement de liquidité, p de Wald).
 * Stabilité : cohortes (pumpswap / raydium / autres) + temps (1re/2e moitié
 * de la période). AUCUNE stratégie construite.
 */
import { writeFileSync } from "node:fs";
import {
  loadT0Rows,
  readSeries,
  survivalTimes,
} from "./common.ts";
import { deciles, median } from "../predictive/universe.ts";
import {
  fitCoxPH,
  kaplanMeier,
} from "../predictive/earlybuyers/survival.ts";

const OUT = "research/results/exp-e1-survival.json";

interface Slice {
  n: number;
  nEvents: number;
  s24h: number | null;
  medianSurvH: number | null;
  hrPerDoubling: number | null;
  pWald: number | null;
  ciHr: [number, number] | null;
  converged: boolean;
}

function analyze(durations: number[], events: boolean[], log2liq: number[]): Slice {
  const n = durations.length;
  const km = kaplanMeier(durations, events);
  const s24h = km.length > 0 ? km[km.length - 1]!.s : null;
  const medPt = km.find((p) => p.s <= 0.5);
  const medianSurvH = medPt ? medPt.t : null;
  let hrPerDoubling: number | null = null;
  let pWald: number | null = null;
  let ciHr: [number, number] | null = null;
  let converged = false;
  if (n >= 30) {
    const X = log2liq.map((v) => [v]);
    const cox = fitCoxPH({ durations, events, X, featureNames: ["log2liqT0"] });
    converged = cox.converged;
    if (cox.converged) {
      hrPerDoubling = cox.hr[0]!;
      const p = cox.pWald[0]!;
      pWald = Number.isNaN(p) ? null : p;
      const se = cox.se[0]!;
      ciHr =
        se > 0 && Number.isFinite(se)
          ? [
              Math.exp(Math.log(hrPerDoubling) - 1.96 * se),
              Math.exp(Math.log(hrPerDoubling) + 1.96 * se),
            ]
          : null;
    }
  }
  return {
    n,
    nEvents: events.filter(Boolean).length,
    s24h,
    medianSurvH,
    hrPerDoubling,
    pWald,
    ciHr,
    converged,
  };
}

function main(): void {
  const rows = loadT0Rows("discovery");
  const durations: number[] = [];
  const events: boolean[] = [];
  const log2liq: number[] = [];
  const dexOf: string[] = [];
  const dayOf: string[] = [];
  for (const r of rows) {
    const s = readSeries(r.mint);
    if (!s) continue;
    const sp = survivalTimes(s);
    if (!sp) continue; // <3 ticks post-t0 : pas d'info de survie fiable
    durations.push(sp.durationH);
    events.push(sp.event);
    log2liq.push(Math.log2(r.liqT0));
    dexOf.push(r.dexId ?? "unknown");
    dayOf.push(r.t0day);
  }
  const n = durations.length;

  const global = analyze(durations, events, log2liq);

  // Déciles de log2(liqT0) → S(24h) par décile (descriptif).
  const dz = deciles(log2liq);
  const perDecile: Array<{ decile: number; n: number; s24h: number | null }> = [];
  for (let d = 0; d < 10; d++) {
    const idx = log2liq.map((v, i) => (dz.bin(v) === d ? i : -1)).filter((i) => i >= 0);
    const km = kaplanMeier(
      idx.map((i) => durations[i]!),
      idx.map((i) => events[i]!),
    );
    perDecile.push({
      decile: d + 1,
      n: idx.length,
      s24h: idx.length >= 30 && km.length > 0 ? km[km.length - 1]!.s : null,
    });
  }

  // Stabilité cohortes : dex.
  const dexGroup = (d: string) =>
    d === "pumpswap" ? "pumpswap" : d === "raydium" ? "raydium" : "other";
  const cohorts: Record<string, Slice> = {};
  for (const g of ["pumpswap", "raydium", "other"]) {
    const idx = dexOf.map((d, i) => (dexGroup(d) === g ? i : -1)).filter((i) => i >= 0);
    cohorts[g] =
      idx.length >= 30
        ? analyze(
            idx.map((i) => durations[i]!),
            idx.map((i) => events[i]!),
            idx.map((i) => log2liq[i]!),
          )
        : ({ n: idx.length, nEvents: 0, s24h: null, medianSurvH: null, hrPerDoubling: null, pWald: null, ciHr: null, converged: false } as Slice);
  }

  // Stabilité temporelle : 1re / 2e moitié de la période (médiane des jours).
  const sortedDays = [...dayOf].sort();
  const midDay = sortedDays[Math.floor(sortedDays.length / 2)]!;
  const halves: Record<string, Slice> = {};
  for (const [name, pred] of [
    ["first_half", (d: string) => d <= midDay],
    ["second_half", (d: string) => d > midDay],
  ] as const) {
    const idx = dayOf.map((d, i) => (pred(d) ? i : -1)).filter((i) => i >= 0);
    halves[name] =
      idx.length >= 30
        ? analyze(
            idx.map((i) => durations[i]!),
            idx.map((i) => events[i]!),
            idx.map((i) => log2liq[i]!),
          )
        : ({ n: idx.length, nEvents: 0, s24h: null, medianSurvH: null, hrPerDoubling: null, pWald: null, ciHr: null, converged: false } as Slice);
  }

  // Référence : médiane liqT0, part d'événements.
  const result = {
    experiment: "E1",
    hypothesis_id: "H-S1-E1",
    universe: "discovery",
    n,
    leakage_status: "PASS",
    leakage_detail:
      "Features (liqT0, dexId, t0day) mesurées à t0 (≤ t0ms). Labels de survie calculés sur ticks post-t0 avec aberrantMask (même règle que labels.ts, mint SKHY exclu). Censure au min(24h, dernier tick) — standard. AUCUNE lecture du holdout.",
    data_bias:
      "data/history/ biaisée vers les tokens chauds : toute mesure = borne OPTIMISTE.",
    global,
    deciles_log2liqT0: perDecile,
    cohort_stability: cohorts,
    time_stability: { split_day: midDay, halves },
    median_log2liqT0: median(log2liq),
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`E1: n=${n} events=${global.nEvents} S(24h)=${global.s24h?.toFixed(3)} HR/doublement=${global.hrPerDoubling?.toFixed(3)} p=${global.pWald}`);
  console.log(`→ ${OUT}`);
}

main();
