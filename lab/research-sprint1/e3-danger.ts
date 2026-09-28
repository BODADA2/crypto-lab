/**
 * SPRINT 1 — E3 : Danger baseline (famille G).
 *
 * HYPOTHÈSE H-S1-E3 : « Le danger (P_DD50_24h, binaire) est plus prédictible
 * que le rendement (Y) depuis les mêmes features pré-t0 les plus simples
 * (liqT0, turnoverH1, turnoverM5) : |ρ(danger)| > |ρ(rendement)|. »
 *
 * Méthode : Spearman(feature, dd50_24h∈{0,1}) vs Spearman(feature, y6h) et
 * (feature, y1h) — même univers discovery, mêmes tokens quand possible
 * (paires appariées) ; IC95 % bootstrap de la différence ||ρ_danger|−|ρ_Y||.
 * Stabilité : cohortes dex + temps. AUCUNE stratégie construite.
 */
import { writeFileSync } from "node:fs";
import {
  loadT0Rows,
  spearman,
  spearmanP,
  median,
} from "./common.ts";

const OUT = "research/results/exp-e3-danger.json";

interface RhoRes {
  n: number;
  rho: number | null;
  p: number | null;
  ci95: [number, number] | null;
}

function bootstrapSpearmanCI(
  xs: number[],
  ys: number[],
  reps = 2000,
  seed = 11,
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

function rhoOf(xs: number[], ys: number[]): RhoRes {
  const n = xs.length;
  if (n < 30) return { n, rho: null, p: null, ci95: null };
  const r = spearman(xs, ys);
  if (r == null) return { n, rho: null, p: null, ci95: null };
  return { n, rho: r, p: spearmanP(r, n), ci95: bootstrapSpearmanCI(xs, ys) };
}

/**
 * IC95 % bootstrap de la différence appariée ||ρ_danger| − |ρ_Y||.
 * Positif = le danger est plus prédictible que le rendement.
 */
function bootstrapAbsDiff(
  xs: number[],
  danger01: number[],
  y: number[],
  reps = 2000,
  seed = 21,
): [number, number] | null {
  if (xs.length < 30) return null;
  let s = seed;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const diffs: number[] = [];
  for (let r = 0; r < reps; r++) {
    const bx: number[] = [];
    const bd: number[] = [];
    const by: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const j = Math.floor(rnd() * xs.length);
      bx.push(xs[j]!);
      bd.push(danger01[j]!);
      by.push(y[j]!);
    }
    const rd = spearman(bx, bd);
    const ry = spearman(bx, by);
    if (rd != null && ry != null) diffs.push(Math.abs(rd) - Math.abs(ry));
  }
  if (diffs.length < 100) return null;
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(0.025 * diffs.length)]!, diffs[Math.floor(0.975 * diffs.length)]!];
}

interface FeatureRes {
  feature: string;
  n: number;
  baseRate_dd50: number | null;
  rho_danger: RhoRes;
  rho_y1h: RhoRes;
  rho_y6h: RhoRes;
  /** Différence ||ρ_danger| − |ρ_y6h|| sur tokens appariés. */
  diff_abs_danger_minus_y6h: { n: number; diff: number | null; ci95: [number, number] | null };
  diff_abs_danger_minus_y1h: { n: number; diff: number | null; ci95: [number, number] | null };
}

function main(): void {
  const rows = loadT0Rows("discovery");
  const feats: Array<{
    name: string;
    get: (r: (typeof rows)[number]) => number | null;
  }> = [
    { name: "liqT0", get: (r) => (r.liqT0 > 0 ? Math.log2(r.liqT0) : null) },
    { name: "turnoverH1", get: (r) => r.turnoverH1 },
    { name: "turnoverM5", get: (r) => r.turnoverM5 },
  ];

  const results: FeatureRes[] = [];
  for (const f of feats) {
    // Danger : tokens avec dd50_24h non-null et feature non-null.
    const dRows = rows.filter((r) => r.dd50_24h != null && f.get(r) != null && Number.isFinite(f.get(r)!));
    const xsD = dRows.map((r) => f.get(r)!);
    const danger01: number[] = dRows.map((r) => (r.dd50_24h! ? 1 : 0));
    const rhoDanger = rhoOf(xsD, danger01);
    const baseRate = dRows.length > 0 ? danger01.reduce((a, b) => a + b, 0) / danger01.length : null;

    // Rendement : mêmes tokens appariés (subset avec y non-null) pour la comparaison.
    const paired6 = dRows.filter((r) => r.y6h != null);
    const xsP6 = paired6.map((r) => f.get(r)!);
    const rhoY6 = rhoOf(xsP6, paired6.map((r) => r.y6h!));
    const paired1 = dRows.filter((r) => r.y1h != null);
    const xsP1 = paired1.map((r) => f.get(r)!);
    const rhoY1 = rhoOf(xsP1, paired1.map((r) => r.y1h!));

    const diff6 =
      rhoDanger.rho != null && rhoY6.rho != null
        ? {
            n: paired6.length,
            diff: Math.abs(rhoDanger.rho) - Math.abs(rhoY6.rho),
            ci95: bootstrapAbsDiff(xsP6, paired6.map((r) => (r.dd50_24h! ? 1 : 0)), paired6.map((r) => r.y6h!)),
          }
        : { n: paired6.length, diff: null, ci95: null };
    const diff1 =
      rhoDanger.rho != null && rhoY1.rho != null
        ? {
            n: paired1.length,
            diff: Math.abs(rhoDanger.rho) - Math.abs(rhoY1.rho),
            ci95: bootstrapAbsDiff(xsP1, paired1.map((r) => (r.dd50_24h! ? 1 : 0)), paired1.map((r) => r.y1h!)),
          }
        : { n: paired1.length, diff: null, ci95: null };

    results.push({
      feature: f.name,
      n: dRows.length,
      baseRate_dd50: baseRate,
      rho_danger: rhoDanger,
      rho_y1h: rhoY1,
      rho_y6h: rhoY6,
      diff_abs_danger_minus_y6h: diff6,
      diff_abs_danger_minus_y1h: diff1,
    });
  }

  // Stabilité : cohortes dex + temps, métrique = ρ(turnoverH1, danger).
  const dexGroup = (d: string | null) =>
    d === "pumpswap" ? "pumpswap" : d === "raydium" ? "raydium" : "other";
  const cohort: Record<string, RhoRes> = {};
  for (const g of ["pumpswap", "raydium", "other"]) {
    const dRows = rows.filter(
      (r) => dexGroup(r.dexId) === g && r.dd50_24h != null && r.turnoverH1 != null,
    );
    cohort[g] = rhoOf(
      dRows.map((r) => r.turnoverH1!),
      dRows.map((r) => (r.dd50_24h! ? 1 : 0)),
    );
  }
  const days = rows.map((r) => r.t0day).sort();
  const midDay = days[Math.floor(days.length / 2)]!;
  const timeStab: Record<string, RhoRes> = {};
  for (const [name, pred] of [
    [`first_half_<=_${midDay}`, (r: (typeof rows)[number]) => r.t0day <= midDay],
    [`second_half_>_${midDay}`, (r: (typeof rows)[number]) => r.t0day > midDay],
  ] as const) {
    const dRows = rows.filter((r) => pred(r) && r.dd50_24h != null && r.turnoverH1 != null);
    timeStab[name] = rhoOf(
      dRows.map((r) => r.turnoverH1!),
      dRows.map((r) => (r.dd50_24h! ? 1 : 0)),
    );
  }

  const result = {
    experiment: "E3",
    hypothesis_id: "H-S1-E3",
    universe: "discovery",
    question: "Le danger (P_DD50_24h) est-il plus prédictible que le rendement ?",
    leakage_status: "PASS",
    leakage_detail:
      "Features à t0 (≤ t0ms : liqT0, turnover via volume/liquidité du snapshot t0). " +
      "Labels dd50_24h / y calculés post-t0 avec aberrantMask (même règle que labels.ts, mint SKHY exclu). " +
      "Spearman binaire = corrélation de rang point-bisériale, standard. AUCUNE lecture du holdout.",
    data_bias: "data/history/ biaisée vers les tokens chauds : borne OPTIMISTE.",
    features: results,
    cohort_stability_turnoverH1_danger: cohort,
    time_stability_turnoverH1_danger: timeStab,
    median_turnoverH1_discovery: median(
      rows.map((r) => r.turnoverH1).filter((v): v is number => v != null && Number.isFinite(v)),
    ),
    cost_sensitivity: "non évaluée (aucune stratégie construite)",
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  for (const fr of results) {
    console.log(
      `${fr.feature}: n=${fr.n} baseDD50=${fr.baseRate_dd50?.toFixed(3)} |ρdanger|=${fr.rho_danger.rho != null ? Math.abs(fr.rho_danger.rho).toFixed(3) : "?"} ` +
        `|ρy6h|=${fr.rho_y6h.rho != null ? Math.abs(fr.rho_y6h.rho).toFixed(3) : "?"} diff=${fr.diff_abs_danger_minus_y6h.diff?.toFixed(3)} ` +
        `CI=[${fr.diff_abs_danger_minus_y6h.ci95?.map((v) => v.toFixed(3)).join(",")}]`,
    );
  }
  console.log(`→ ${OUT}`);
}

main();
