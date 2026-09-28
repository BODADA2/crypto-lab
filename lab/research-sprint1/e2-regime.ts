/**
 * SPRINT 1 — E2 : Régime de marché (famille J).
 *
 * HYPOTHÈSE H-S1-E2 : « Le régime de marché du jour (activité de lancement,
 * graduation, turnover médian) module le signal Phase 1 "frénésie → Y@1h
 * négatif" (H-PRED-FLOW-01, X = sellsM5 à t0) : la corrélation signal→Y
 * diffère entre terciles de régime (interaction régime × signal). »
 *
 * Méthode :
 *  1. régime par jour calendaire UTC depuis data/scans/ (lecture seule) :
 *     launches/heure, graduations/heure (proxy : dexId != pumpfun), turnover
 *     médian à t0 (history, discovery) → z-scores → score composite → terciles ;
 *  2. par tercile : n, Spearman(sellsM5@t0, y1h), IC95 % bootstrap du Spearman ;
 *  3. interaction : test z de Fisher tercile 1 vs tercile 3 (et 1 vs 2, 2 vs 3).
 * Stabilité : cohortes dex (ρ global par dex) + temps (1re/2e moitié).
 * AUCUNE stratégie construite.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  loadT0Rows,
  assignTercile,
  percentile,
  zscore,
  fisherZDiff,
  spearmanP,
  median,
  spearman,
} from "./common.ts";

const OUT = "research/results/exp-e2-regime.json";

/** Jour UTC (YYYY-MM-DD) d'un timestamp ms. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface ScanToken {
  mint: string;
  createdAt: string | null;
  fetchedAt: string | null;
  dexId: string | null;
}

interface DayRegime {
  day: string;
  launchesPerHour: number;
  graduationsPerHour: number;
  medianTurnoverH1: number | null;
  score: number;
  tercile: 1 | 2 | 3;
}

interface TercileStats {
  n: number;
  spearman: number | null;
  p: number | null;
  ci95: [number, number] | null;
}

/** IC95 % bootstrap du Spearman (percentiles, seed fixe). */
function bootstrapSpearmanCI(
  xs: number[],
  ys: number[],
  reps = 2000,
  seed = 7,
): [number, number] | null {
  if (xs.length < 30) return null;
  let s = seed;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const bx: number[] = [];
    const by: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const j = Math.floor(rnd() * xs.length);
      bx.push(xs[j]!);
      by.push(ys[j]!);
    }
    const rr = spearman(bx, by);
    if (rr != null) vals.push(rr);
  }
  if (vals.length < 100) return null;
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)]!, vals[Math.floor(0.975 * vals.length)]!];
}

/** Construit le régime par jour calendaire (scans + turnover médian à t0). */
function buildRegime(
  turnoverByDay: Map<string, number[]>,
): { days: DayRegime[]; notes: string[] } {
  const notes: string[] = [];
  // 1) launches : premier createdAt vu par mint (dédupliqué).
  const firstSeen = new Map<string, number>(); // mint -> ms
  const migrated = new Set<string>(); // mint vu hors pumpfun au moins une fois
  const coverageHours = new Map<string, Set<number>>(); // day -> heures UTC couvertes
  const files = readdirSync("data/scans").filter((f) => f.endsWith(".json"));
  for (const f of files) {
    let d: { startedAt?: string; finishedAt?: string; tokens?: ScanToken[] };
    try {
      d = JSON.parse(readFileSync(`data/scans/${f}`, "utf-8"));
    } catch {
      continue;
    }
    const s0 = d.startedAt ? Date.parse(d.startedAt) : NaN;
    const s1 = d.finishedAt ? Date.parse(d.finishedAt) : NaN;
    if (Number.isFinite(s0)) {
      const day = dayOf(s0);
      let set = coverageHours.get(day);
      if (!set) { set = new Set(); coverageHours.set(day, set); }
      set.add(new Date(s0).getUTCHours());
    }
    for (const t of d.tokens ?? []) {
      if (!t.mint) continue;
      const c = t.createdAt ?? t.fetchedAt;
      if (c) {
        const ms = Date.parse(c);
        if (Number.isFinite(ms)) {
          const prev = firstSeen.get(t.mint);
          if (prev == null || ms < prev) firstSeen.set(t.mint, ms);
        }
      }
      if (t.dexId && t.dexId !== "pumpfun") migrated.add(t.mint);
    }
  }
  notes.push(
    `launches = mints uniques par jour de premier createdAt (fallback fetchedAt) ; ` +
      `graduations = mints du jour vus au moins une fois hors pumpfun (proxy, pas un événement migrate observé).`,
  );

  const launchByDay = new Map<string, number>();
  const gradByDay = new Map<string, number>();
  for (const [mint, ms] of firstSeen) {
    const day = dayOf(ms);
    if (day < "2026-09-24" || day > "2026-09-28") continue; // période couverte
    launchByDay.set(day, (launchByDay.get(day) ?? 0) + 1);
    if (migrated.has(mint)) gradByDay.set(day, (gradByDay.get(day) ?? 0) + 1);
  }
  const days = [...launchByDay.keys()].sort();
  const hours = days.map((d) => Math.max(1, coverageHours.get(d)?.size ?? 1));
  const launchPH = days.map((d, i) => (launchByDay.get(d) ?? 0) / hours[i]!);
  const gradPH = days.map((d, i) => (gradByDay.get(d) ?? 0) / hours[i]!);
  const medTurn = days.map((d) => {
    const v = (turnoverByDay.get(d) ?? []).filter(Number.isFinite);
    return v.length >= 5 ? median(v) : null;
  });
  notes.push(
    `taux normalisés par heures de couverture scan du jour (le 2026-09-28 est partiel : ` +
      `${coverageHours.get("2026-09-28")?.size ?? "?"}h couvertes).`,
  );

  const zL = zscore(launchPH);
  const zG = zscore(gradPH);
  const medTurnClean = medTurn.map((v) => (v == null ? NaN : v));
  const zT = zscore(medTurnClean.filter((v) => !Number.isNaN(v)));
  // Ré-aligne zT (jours sans turnover médian → contribution 0).
  let zi = 0;
  const score = days.map((_, i) => {
    const cT = medTurn[i] == null ? 0 : zT[zi++]!;
    return (zL[i]! + zG[i]! + cT) / 3;
  });
  const sorted = [...score].sort((a, b) => a - b);
  const t1 = percentile(sorted, 1 / 3);
  const t2 = percentile(sorted, 2 / 3);
  return {
    days: days.map((day, i) => ({
      day,
      launchesPerHour: launchPH[i]!,
      graduationsPerHour: gradPH[i]!,
      medianTurnoverH1: medTurn[i]!,
      score: score[i]!,
      tercile: assignTercile(score[i]!, t1, t2),
    })),
    notes,
  };
}

function tercileStats(xs: number[], ys: number[]): TercileStats {
  const n = xs.length;
  if (n < 30) return { n, spearman: null, p: null, ci95: null };
  const r = spearman(xs, ys);
  if (r == null) return { n, spearman: null, p: null, ci95: null };
  return { n, spearman: r, p: spearmanP(r, n), ci95: bootstrapSpearmanCI(xs, ys) };
}

function main(): void {
  const rows = loadT0Rows("discovery");

  // Turnover médian à t0 par jour (pour le régime).
  const turnoverByDay = new Map<string, number[]>();
  for (const r of rows) {
    if (r.turnoverH1 != null && Number.isFinite(r.turnoverH1)) {
      let a = turnoverByDay.get(r.t0day);
      if (!a) { a = []; turnoverByDay.set(r.t0day, a); }
      a.push(r.turnoverH1);
    }
  }
  const { days, notes } = buildRegime(turnoverByDay);
  const tercileOf = new Map(days.map((d) => [d.day, d.tercile]));

  // Tokens : signal frénésie (sellsM5@t0) vs y1h, par tercile de régime du jour t0.
  const byTercile = new Map<1 | 2 | 3, { xs: number[]; ys: number[] }>();
  const dexXs: Record<string, { xs: number[]; ys: number[] }> = {};
  const halfXs: Record<string, { xs: number[]; ys: number[] }> = {
    first: { xs: [], ys: [] },
    second: { xs: [], ys: [] },
  };
  const t0days = rows.map((r) => r.t0day).sort();
  const midDay = t0days[Math.floor(t0days.length / 2)]!;
  let droppedNoRegime = 0;
  for (const r of rows) {
    if (r.y1h == null) continue;
    const t = tercileOf.get(r.t0day);
    if (t == null) { droppedNoRegime++; continue; }
    let g = byTercile.get(t);
    if (!g) { g = { xs: [], ys: [] }; byTercile.set(t, g); }
    g.xs.push(r.sellsM5);
    g.ys.push(r.y1h);
    const dex = r.dexId === "pumpswap" ? "pumpswap" : r.dexId === "raydium" ? "raydium" : "other";
    (dexXs[dex] ??= { xs: [], ys: [] }).xs.push(r.sellsM5);
    dexXs[dex]!.ys.push(r.y1h);
    const h = r.t0day <= midDay ? "first" : "second";
    halfXs[h]!.xs.push(r.sellsM5);
    halfXs[h]!.ys.push(r.y1h);
  }

  const stats: Record<string, TercileStats> = {};
  for (const t of [1, 2, 3] as const) {
    const g = byTercile.get(t);
    stats[`tercile_${t}`] = g ? tercileStats(g.xs, g.ys) : { n: 0, spearman: null, p: null, ci95: null };
  }

  // Interactions : différences de corrélations (Fisher z), paires de terciles.
  const interactions: Record<string, { z: number | null; p: number | null }> = {};
  const s1 = stats["tercile_1"]!, s2 = stats["tercile_2"]!, s3 = stats["tercile_3"]!;
  for (const [name, a, b] of [["t1_vs_t3", s1, s3], ["t1_vs_t2", s1, s2], ["t2_vs_t3", s2, s3]] as const) {
    if (a.spearman != null && b.spearman != null) {
      const { z, p } = fisherZDiff(a.spearman, a.n, b.spearman, b.n);
      interactions[name] = { z: Number.isNaN(z) ? null : z, p: Number.isNaN(p) ? null : p };
    } else {
      interactions[name] = { z: null, p: null };
    }
  }

  const cohort: Record<string, TercileStats> = {};
  for (const dex of ["pumpswap", "raydium", "other"]) {
    const g = dexXs[dex];
    cohort[dex] = g ? tercileStats(g.xs, g.ys) : { n: 0, spearman: null, p: null, ci95: null };
  }
  const timeStab: Record<string, TercileStats> = {};
  for (const h of ["first", "second"]) {
    const g = halfXs[h]!;
    timeStab[`${h}_half_before_${midDay}`] = tercileStats(g.xs, g.ys);
  }

  const result = {
    experiment: "E2",
    hypothesis_id: "H-S1-E2",
    universe: "discovery",
    signal: "sellsM5@t0 (frénésie, H-PRED-FLOW-01) vs y1h",
    leakage_status: "PASS",
    leakage_detail:
      "Signal et labels : mêmes règles que Phase 1 (≤ t0ms vs post-t0, aberrantMask, SKHY exclu). " +
      "CAVEAT : le régime du jour est calculé ex-post (journée complète connue). " +
      "En production il faudrait un régime trailing (jours précédents) — le test mesure ici la modulation rétrospective, pas un signal temps réel. " +
      "AUCUNE lecture du holdout.",
    data_bias: "data/history/ + data/scans/ biaisées vers les tokens chauds : borne OPTIMISTE.",
    regime_table: days,
    regime_notes: notes,
    terciles: stats,
    interactions,
    cohort_stability: cohort,
    time_stability: timeStab,
    dropped_no_regime: droppedNoRegime,
    cost_sensitivity: "non évaluée (aucune stratégie construite)",
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`E2: jours=${days.length} ` + days.map((d) => `${d.day}:T${d.tercile}`).join(" "));
  for (const t of [1, 2, 3]) {
    const st = stats[`tercile_${t}`]!;
    console.log(`  T${t}: n=${st.n} rho=${st.spearman?.toFixed(3)} p=${st.p?.toExponential(1)}`);
  }
  console.log(`→ ${OUT}`);
}

main();
