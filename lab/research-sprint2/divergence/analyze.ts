/**
 * SPRINT 2A — runners K (divergence), O (anomaly) et BONUS (glitch scan).
 *
 * Usage (depuis la racine du repo) :
 *   npx tsx lab/research-sprint2/divergence/analyze.ts [k|o|glitch|all]
 *
 * Règles : discovery uniquement (hash<50), SKHY exclu, lecture seule sur
 * data/, AUCUNE stratégie construite, holdout (hash≥75) JAMAIS lu —
 * sauf pour le scan glitch (diagnostic data-quality uniquement, aucune
 * mesure prédictive sur le holdout ; déclaré dans le rapport).
 */
import { writeFileSync } from "node:fs";
import { aberrantMask, deciles, median, spearman, bootstrapCI, splitUniverse } from "../../predictive/universe.ts";
import { spearmanP } from "../../research-sprint1/common.ts";
import { readSeries, listHistoryMints } from "../../research-sprint1/common.ts";
import {
  loadDivergenceRows,
  labelsFrom,
  SKHY_MINT,
  type DivergenceRow,
} from "./features.ts";
import { computeAnomaly, populationRobustZ } from "./anomaly.ts";

const OUT_K = "research/results/res-s2a-divergence.json";
const OUT_O = "research/results/res-s2a-anomaly.json";
const OUT_G = "research/results/res-s2a-glitchscan.json";

/* ------------------------------------------------------------------ */

interface TargetSet {
  y1h: number | null;
  y6h: number | null;
  y24h: number | null;
  ddMax24h: number | null;
  dd50: number | null; // 1/0
}

function targetsFor(r: DivergenceRow): TargetSet {
  const s = readSeries(r.mint);
  if (!s) return { y1h: null, y6h: null, y24h: null, ddMax24h: null, dd50: null };
  const t0 = s.findIndex(
    (x) => x.priceUsd > 0 && x.liquidityUsd >= 20000,
  );
  if (t0 < 0) return { y1h: null, y6h: null, y24h: null, ddMax24h: null, dd50: null };
  // K2 : labels à partir du tick d'observation (featMs) ; sinon depuis t0.
  const fromMs = r.featMs;
  const entry = r.featPrice;
  const l = labelsFrom(s, fromMs, entry);
  return {
    y1h: l.y1h,
    y6h: l.y6h,
    y24h: l.y24h,
    ddMax24h: l.ddMax24h,
    dd50: l.dd50_24h == null ? null : l.dd50_24h ? 1 : 0,
  };
}

function targetsT0(r: DivergenceRow): TargetSet {
  const s = readSeries(r.mint);
  if (!s) return { y1h: null, y6h: null, y24h: null, ddMax24h: null, dd50: null };
  const t0 = s.findIndex((x) => x.priceUsd > 0 && x.liquidityUsd >= 20000);
  if (t0 < 0) return { y1h: null, y6h: null, y24h: null, ddMax24h: null, dd50: null };
  const l = labelsFrom(s, r.t0ms, s[t0]!.priceUsd);
  return {
    y1h: l.y1h,
    y6h: l.y6h,
    y24h: l.y24h,
    ddMax24h: l.ddMax24h,
    dd50: l.dd50_24h == null ? null : l.dd50_24h ? 1 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Statistiques génériques                                            */
/* ------------------------------------------------------------------ */

interface AssocResult {
  feature: string;
  target: string;
  n: number;
  spearman: number | null;
  p: number | null;
  /** Moyenne du target par décile (D1..D10), nulls exclus par paire. */
  decileMeans: (number | null)[];
  d1: { mean: number | null; ci: [number, number] | null; n: number };
  d10: { mean: number | null; ci: [number, number] | null; n: number };
  /** D10 − D1 (extrêmes de la feature). */
  diffD10D1: number | null;
  ciDiff: [number, number] | null;
}

/** IC95% bootstrap de la différence de moyennes (groupes indépendants). */
function bootstrapDiffCI(
  a: number[],
  b: number[],
  reps = 2000,
  seed = 7,
): [number, number] | null {
  if (a.length < 10 || b.length < 10) return null;
  let s = seed;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const diffs: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sa = 0;
    for (let i = 0; i < a.length; i++) sa += a[Math.floor(rnd() * a.length)]!;
    let sb = 0;
    for (let i = 0; i < b.length; i++) sb += b[Math.floor(rnd() * b.length)]!;
    diffs.push(sa / a.length - sb / b.length);
  }
  diffs.sort((x, y) => x - y);
  return [diffs[Math.floor(0.025 * reps)]!, diffs[Math.floor(0.975 * reps)]!];
}

function testAssociation(
  feature: string,
  target: string,
  pairs: [number, number][],
): AssocResult {
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const n = pairs.length;
  const r = n >= 3 ? spearman(xs, ys) : null;
  const p = r == null ? null : spearmanP(r, n);
  const decileMeans: (number | null)[] = new Array(10).fill(null);
  let d1 = { mean: null as number | null, ci: null as [number, number] | null, n: 0 };
  let d10 = { mean: null as number | null, ci: null as [number, number] | null, n: 0 };
  let diffD10D1: number | null = null;
  let ciDiff: [number, number] | null = null;
  if (n >= 30) {
    const dz = deciles(xs);
    const bins: number[][] = Array.from({ length: 10 }, () => []);
    pairs.forEach(([x, y]) => bins[dz.bin(x)]!.push(y));
    bins.forEach((b, i) => {
      decileMeans[i] = b.length > 0 ? b.reduce((a, v) => a + v, 0) / b.length : null;
    });
    const g1 = bins[0]!;
    const g10 = bins[9]!;
    d1 = {
      mean: decileMeans[0] ?? null,
      ci: bootstrapCI(g1),
      n: g1.length,
    };
    d10 = {
      mean: decileMeans[9] ?? null,
      ci: bootstrapCI(g10),
      n: g10.length,
    };
    if (d1.mean != null && d10.mean != null) {
      diffD10D1 = d10.mean - d1.mean;
      ciDiff = bootstrapDiffCI(g10, g1);
    }
  }
  return { feature, target, n, spearman: r, p, decileMeans, d1, d10, diffD10D1, ciDiff };
}

interface BinaryAssoc {
  feature: string;
  target: string;
  nPos: number;
  nNeg: number;
  meanPos: number | null;
  meanNeg: number | null;
  diff: number | null;
  ciDiff: [number, number] | null;
}

function testBinary(
  feature: string,
  target: string,
  pos: number[],
  neg: number[],
): BinaryAssoc {
  const meanPos = pos.length > 0 ? pos.reduce((a, b) => a + b, 0) / pos.length : null;
  const meanNeg = neg.length > 0 ? neg.reduce((a, b) => a + b, 0) / neg.length : null;
  const diff = meanPos != null && meanNeg != null ? meanPos - meanNeg : null;
  return {
    feature,
    target,
    nPos: pos.length,
    nNeg: neg.length,
    meanPos,
    meanNeg,
    diff,
    ciDiff: diff != null ? bootstrapDiffCI(pos, neg) : null,
  };
}

/* ------------------------------------------------------------------ */
/* K — DIVERGENCE                                                       */
/* ------------------------------------------------------------------ */

const TARGETS = ["y1h", "y6h", "y24h", "ddMax24h", "dd50"] as const;

function runK(): Record<string, unknown> {
  const rows = loadDivergenceRows();
  const t0labels = new Map<string, TargetSet>(rows.map((r) => [r.mint, targetsT0(r)]));
  const featLabels = new Map<string, TargetSet>(rows.map((r) => [r.mint, targetsFor(r)]));

  const cont: AssocResult[] = [];
  const bin: BinaryAssoc[] = [];

  // Population discovery pour les z de K3/K5.
  const mcapPop = rows.map((r) => r.logMcapLiq).filter((v): v is number => v != null);
  const vptPop = rows.map((r) => r.logVolPerTrade).filter((v): v is number => v != null);

  const contFeatures: { name: string; get: (r: DivergenceRow) => number | null; signed?: boolean }[] = [
    {
      name: "absZ_logMcapLiq",
      get: (r) => {
        const z = r.logMcapLiq != null ? populationRobustZ(r.logMcapLiq, mcapPop) : null;
        return z == null ? null : Math.abs(z);
      },
    },
    {
      name: "z_logMcapLiq_signe",
      get: (r) => (r.logMcapLiq != null ? populationRobustZ(r.logMcapLiq, mcapPop) : null),
    },
    {
      name: "frictionH1",
      get: (r) => (r.frictionH1 != null && Number.isFinite(r.frictionH1) ? r.frictionH1 : null),
    },
    {
      name: "absZ_logVolPerTrade",
      get: (r) => {
        const z = r.logVolPerTrade != null ? populationRobustZ(r.logVolPerTrade, vptPop) : null;
        return z == null ? null : Math.abs(z);
      },
    },
    {
      name: "z_logVolPerTrade_signe",
      get: (r) => (r.logVolPerTrade != null ? populationRobustZ(r.logVolPerTrade, vptPop) : null),
    },
  ];

  for (const f of contFeatures) {
    for (const t of TARGETS) {
      const pairs: [number, number][] = [];
      for (const r of rows) {
        const x = f.get(r);
        const y = t0labels.get(r.mint)![t];
        if (x != null && y != null) pairs.push([x, y]);
      }
      cont.push(testAssociation(f.name, `t0:${t}`, pairs));
    }
  }

  // Features binaires : K1 (labels t0), K2 (labels depuis featMs).
  for (const t of TARGETS) {
    const pos1: number[] = [];
    const neg1: number[] = [];
    const pos2: number[] = [];
    const neg2: number[] = [];
    for (const r of rows) {
      const y1 = t0labels.get(r.mint)![t];
      if (y1 != null && r.mismatchPre != null) (r.mismatchPre === 1 ? pos1 : neg1).push(y1);
      const y2 = featLabels.get(r.mint)![t];
      if (y2 != null && r.mismatchPost != null) (r.mismatchPost === 1 ? pos2 : neg2).push(y2);
    }
    bin.push(testBinary("mismatchPre(incoh_vs_coh)", `t0:${t}`, pos1, neg1));
    bin.push(testBinary("mismatchPost(incoh_vs_coh)", `feat:${t}`, pos2, neg2));
  }

  // Stabilité : cohortes dex + moitiés temporelles (Spearman, features continues).
  const stability: Record<string, unknown> = {};
  const dexGroups: Record<string, DivergenceRow[]> = {};
  for (const r of rows) {
    const d = r.dexId ?? "unknown";
    const key = d === "pumpswap" ? "pumpswap" : d === "raydium" ? "raydium" : "other";
    (dexGroups[key] ??= []).push(r);
  }
  const sorted = [...rows].sort((a, b) => a.t0ms - b.t0ms);
  const halves = {
    first: sorted.slice(0, Math.floor(sorted.length / 2)),
    second: sorted.slice(Math.floor(sorted.length / 2)),
  };
  for (const f of contFeatures) {
    const entry: Record<string, unknown> = {};
    for (const [gk, group] of Object.entries({ ...dexGroups, ...halves })) {
      const sub: Record<string, { n: number; spearman: number | null; p: number | null }> = {};
      for (const t of ["y1h", "y6h", "ddMax24h", "dd50"] as const) {
        const pairs: [number, number][] = [];
        for (const r of group) {
          const x = f.get(r);
          const y = t0labels.get(r.mint)![t];
          if (x != null && y != null) pairs.push([x, y]);
        }
        const rr = pairs.length >= 3 ? spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null;
        sub[t] = { n: pairs.length, spearman: rr, p: rr == null ? null : spearmanP(rr, pairs.length) };
      }
      entry[gk] = sub;
    }
    stability[f.name] = entry;
  }

  // Couverture des features.
  const coverage = {
    nRows: rows.length,
    mismatchPre: rows.filter((r) => r.mismatchPre != null).length,
    mismatchPost: rows.filter((r) => r.mismatchPost != null).length,
    logMcapLiq: mcapPop.length,
    frictionH1: rows.filter((r) => r.frictionH1 != null).length,
    logVolPerTrade: vptPop.length,
    lagMinPostMedian: median(
      rows.map((r) => r.lagMinPost).filter((v): v is number => v != null),
    ),
  };

  return {
    family: "K",
    name: "DIVERGENCE_FEATURES",
    universe: "discovery",
    leakage: "PASS — K1 100% pré-t0 ; K2 labels recalculés depuis le tick d'observation (aucun chevauchement) ; K3/K4/K5 mesurés à t0. Holdout jamais lu.",
    bias: "Tokens chauds → borne OPTIMISTE déclarée.",
    coverage,
    continuous: cont,
    binary: bin,
    stability,
  };
}

/* ------------------------------------------------------------------ */
/* O — ANOMALY                                                          */
/* ------------------------------------------------------------------ */

function runO(): Record<string, unknown> {
  const rows = loadDivergenceRows();
  const anoms = computeAnomaly(rows);
  const t0labels = new Map<string, TargetSet>(rows.map((r) => [r.mint, targetsT0(r)]));

  const feats: { name: string; get: (a: (typeof anoms)[number]) => number | null }[] = [
    { name: "ANOMALY", get: (a) => a.anomaly },
    { name: "absZ_liq", get: (a) => (a.zLiq == null ? null : Math.abs(a.zLiq)) },
    { name: "absZ_turn", get: (a) => (a.zTurn == null ? null : Math.abs(a.zTurn)) },
    { name: "absZ_velo", get: (a) => (a.zVelo == null ? null : Math.abs(a.zVelo)) },
    { name: "z_liq_signe", get: (a) => a.zLiq },
    { name: "z_turn_signe", get: (a) => a.zTurn },
    { name: "z_velo_signe", get: (a) => a.zVelo },
  ];

  const results: AssocResult[] = [];
  for (const f of feats) {
    for (const t of TARGETS) {
      const pairs: [number, number][] = [];
      for (const a of anoms) {
        const x = f.get(a);
        const y = t0labels.get(a.mint)![t];
        if (x != null && y != null) pairs.push([x, y]);
      }
      results.push(testAssociation(f.name, `t0:${t}`, pairs));
    }
  }

  // Stabilité cohortes dex + moitiés temporelles (ANOMALY composite).
  const dexGroups: Record<string, (typeof anoms)[number][]> = {};
  for (const a of anoms) {
    const d = a.dexId ?? "unknown";
    const key = d === "pumpswap" ? "pumpswap" : d === "raydium" ? "raydium" : "other";
    (dexGroups[key] ??= []).push(a);
  }
  const byTime = [...anoms].sort((a, b) => {
    const ra = rows.find((r) => r.mint === a.mint)!;
    const rb = rows.find((r) => r.mint === b.mint)!;
    return ra.t0ms - rb.t0ms;
  });
  const halves = {
    first: byTime.slice(0, Math.floor(byTime.length / 2)),
    second: byTime.slice(Math.floor(byTime.length / 2)),
  };
  const stability: Record<string, unknown> = {};
  for (const [gk, group] of Object.entries({ ...dexGroups, ...halves })) {
    const sub: Record<string, { n: number; spearman: number | null; p: number | null }> = {};
    for (const t of ["y1h", "y6h", "ddMax24h", "dd50"] as const) {
      const pairs: [number, number][] = [];
      for (const a of group) {
        const x = a.anomaly;
        const y = t0labels.get(a.mint)![t];
        if (x != null && y != null) pairs.push([x, y]);
      }
      const rr = pairs.length >= 3 ? spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null;
      sub[t] = { n: pairs.length, spearman: rr, p: rr == null ? null : spearmanP(rr, pairs.length) };
    }
    stability[gk] = sub;
  }

  return {
    family: "O",
    name: "ANOMALY_SCORE",
    universe: "discovery",
    leakage: "PASS — régime = jour calendaire t0, leave-one-out ; features ≤ t0ms ; labels post-t0 nettoyés. Holdout jamais lu.",
    bias: "Tokens chauds → borne OPTIMISTE déclarée.",
    coverage: {
      nRows: rows.length,
      anomaly: anoms.filter((a) => a.anomaly != null).length,
      zLiq: anoms.filter((a) => a.zLiq != null).length,
      zTurn: anoms.filter((a) => a.zTurn != null).length,
      zVelo: anoms.filter((a) => a.zVelo != null).length,
    },
    results,
    stability,
    note: "ANOMALY ≠ OPPORTUNITY par défaut : les deux directions sont lues dans les déciles (D10 = forte anomalie).",
  };
}

/* ------------------------------------------------------------------ */
/* BONUS — scan systématique des ticks aberrants (M-003)                */
/* ------------------------------------------------------------------ */

function runGlitch(): Record<string, unknown> {
  // Diagnostic data-quality : tous les univers scannés (le holdout n'est
  // utilisé pour AUCUNE mesure prédictive — déclaré).
  const files = listHistoryMints();
  let nTicks = 0;
  let nMasked = 0;
  let nMintsAffected = 0;
  const byMint: { mint: string; n: number; maxRatio: number }[] = [];
  const ratios: number[] = [];
  for (const mint of files) {
    if (mint === SKHY_MINT) continue; // cas connu, exclu du comptage
    const s = readSeries(mint);
    if (!s) continue;
    const mask = aberrantMask(s);
    let c = 0;
    let maxR = 0;
    for (let i = 0; i < s.length; i++) {
      nTicks++;
      if (!mask[i]) continue;
      c++;
      nMasked++;
      const p = s[i]!.priceUsd;
      const pl = s[i - 1]!.priceUsd;
      const pr = s[i + 1]!.priceUsd;
      const r = Math.max(p / Math.min(pl, pr), Math.max(pl, pr) / p);
      ratios.push(r);
      if (r > maxR) maxR = r;
    }
    if (c > 0) {
      nMintsAffected++;
      byMint.push({ mint, n: c, maxRatio: maxR });
    }
  }
  ratios.sort((a, b) => a - b);
  const q = (p: number) => (ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))] : null);

  // Impact sur les labels discovery : avec vs sans nettoyage.
  let nChanged = 0;
  let nChecked = 0;
  let sumAbsDeltaY1h = 0;
  let nDeltaY1h = 0;
  let dd50Flips = 0;
  let signFlipsY1h = 0;
  for (const mint of files) {
    if (mint === SKHY_MINT) continue;
    // discovery uniquement pour la mesure d'impact
    if (splitUniverse(mint) !== "discovery") continue;
    const s = readSeries(mint);
    if (!s) continue;
    const t0 = s.findIndex((x) => x.priceUsd > 0 && x.liquidityUsd >= 20000);
    if (t0 < 0) continue;
    const mask = aberrantMask(s);
    if (!mask.some(Boolean)) continue;
    nChecked++;
    const clean = labelsFrom(s, Date.parse(s[t0]!.fetchedAt), s[t0]!.priceUsd);
    // Version « sale » : même calcul sans masque — réimplémenté inline.
    const dirty = labelsFromDirty(s, Date.parse(s[t0]!.fetchedAt), s[t0]!.priceUsd);
    let changed = false;
    for (const k of ["y1h", "y6h", "ddMax24h"] as const) {
      const a = clean[k];
      const b = dirty[k];
      if (a == null || b == null) continue;
      if (Math.abs(a - b) > 1e-12) changed = true;
      if (k === "y1h") {
        sumAbsDeltaY1h += Math.abs(a - b);
        nDeltaY1h++;
        if (Math.sign(a) !== Math.sign(b) && a !== 0 && b !== 0) signFlipsY1h++;
      }
    }
    if ((clean.dd50_24h ?? null) !== (dirty.dd50_24h ?? null)) {
      changed = true;
      if (clean.dd50_24h != null && dirty.dd50_24h != null) dd50Flips++;
    }
    if (changed) nChanged++;
  }

  byMint.sort((a, b) => b.n - a.n);
  return {
    family: "BONUS",
    name: "GLITCH_SCAN_M003",
    scope: "data/history complet (2926 séries) — diagnostic data-quality ; holdout scanné mais AUCUNE mesure prédictive dessus.",
    prevalence: {
      nFiles: files.length,
      nTicks,
      nMaskedTicks: nMasked,
      pctTicks: nTicks ? nMasked / nTicks : 0,
      nMintsAffected,
      pctMints: files.length ? nMintsAffected / files.length : 0,
      ratioP50: q(0.5),
      ratioP90: q(0.9),
      ratioMax: ratios.length ? ratios[ratios.length - 1] : null,
    },
    topMints: byMint.slice(0, 20),
    labelImpactDiscovery: {
      nChecked,
      nChanged,
      meanAbsDeltaY1h: nDeltaY1h ? sumAbsDeltaY1h / nDeltaY1h : null,
      signFlipsY1h,
      dd50Flips,
    },
    limitation: "aberrantMask ne détecte que les ticks intérieurs (voisins des deux côtés) ; premier/dernier tick non vérifiables.",
  };
}

/** Variante « sale » de labelsFrom : sans masque aberrant (mesure d'impact). */
function labelsFromDirty(s: { fetchedAt: string; priceUsd: number }[], fromMs: number, entryPrice: number) {
  const H = [3_600_000, 6 * 3_600_000, 24 * 3_600_000];
  const rets = new Map<number, number>();
  for (const h of H) {
    const target = fromMs + h;
    for (let i = 0; i < s.length; i++) {
      const t = Date.parse(s[i]!.fetchedAt);
      if (t <= fromMs || t < target) continue;
      if (s[i]!.priceUsd <= 0) continue;
      rets.set(h, s[i]!.priceUsd / entryPrice - 1);
      break;
    }
  }
  const w: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const t = Date.parse(s[i]!.fetchedAt);
    if (t <= fromMs || t > fromMs + 24 * 3_600_000) continue;
    if (s[i]!.priceUsd <= 0) continue;
    w.push(s[i]!.priceUsd / entryPrice - 1);
  }
  const ddMax24h = w.length >= 3 ? Math.min(...w) : null;
  return {
    y1h: rets.get(H[0]!) ?? null,
    y6h: rets.get(H[1]!) ?? null,
    y24h: rets.get(H[2]!) ?? null,
    ddMax24h,
    dd50_24h: ddMax24h == null ? null : ddMax24h <= -0.5,
  };
}

/* ------------------------------------------------------------------ */

function main(): void {
  const which = process.argv[2] ?? "all";
  if (which === "k" || which === "all") {
    const r = runK();
    writeFileSync(OUT_K, JSON.stringify(r, null, 2));
    console.log("K écrit:", OUT_K);
  }
  if (which === "o" || which === "all") {
    const r = runO();
    writeFileSync(OUT_O, JSON.stringify(r, null, 2));
    console.log("O écrit:", OUT_O);
  }
  if (which === "glitch" || which === "all") {
    const r = runGlitch();
    writeFileSync(OUT_G, JSON.stringify(r, null, 2));
    console.log("BONUS écrit:", OUT_G);
  }
}

main();
