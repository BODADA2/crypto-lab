/**
 * DOMAINE 2/5 — FLOW STRUCTURE : analyse discovery → calibration → holdout.
 *
 * Usage : npx tsx lab/predictive/flows/analyze.ts
 * Sortie : /tmp/flows-results.json (éphémère ; les tableaux durables vont
 * dans docs/predictive-flows-2026-09-28.md).
 *
 * Protocole :
 *  - Univers DISJOINTS par hash FNV (splitUniverse) : discovery (<50),
 *    calibration (50-74), holdout gelé (>=75). AUCUNE calibration sur holdout ;
 *    UNE SEULE mesure holdout, sur les variables verrouillées en calibration.
 *  - t0 = findT0 (liquidityUsd >= 20 000, priceUsd > 0).
 *  - Y = futureReturns sur [1h, 6h, 24h], prix nettoyés (aberrantMask).
 *  - Résultat principal AVEC les outliers valides ; sensibilité winsorisée p1/p99.
 *  - Données data/history/ biaisées vers tokens chauds => bornes OPTIMISTES.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenSnapshot } from "../../types.ts";
import {
  deciles,
  findT0,
  futureReturns,
  HORIZON_LABELS,
  HORIZONS_MS,
  splitUniverse,
} from "../universe.ts";
import {
  FEATURE_LABELS,
  FEATURE_NAMES,
  flowFeaturesAtT0,
  type FlowFeatures,
} from "./features.ts";
import {
  median,
  spearman,
} from "../universe.ts";
import {
  medianDiffBootstrapCI,
  spearmanBootstrapCI,
  spearmanP,
  summarize,
  winsorize,
} from "./stats.ts";

const DATA_DIR = path.resolve("data/history");

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
interface Row {
  mint: string;
  universe: "discovery" | "calibration" | "holdout";
  dexId: string | null;
  t0Date: string;
  feats: FlowFeatures;
  y: Record<string, number | null>;
}

function loadRows(): Row[] {
  const rows: Row[] = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    const mint = f.replace(/\.jsonl$/, "");
    const series: TokenSnapshot[] = [];
    for (const line of fs.readFileSync(path.join(DATA_DIR, f), "utf8").split("\n")) {
      const t = line.trim();
      if (t) series.push(JSON.parse(t) as TokenSnapshot);
    }
    if (series.length === 0) continue;
    const sorted = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const t0 = findT0(sorted);
    if (t0 < 0) continue;
    const feats = flowFeaturesAtT0(sorted, t0);
    const ys = futureReturns(sorted, [...HORIZONS_MS]);
    const y: Record<string, number | null> = {};
    for (let i = 0; i < HORIZONS_MS.length; i++) {
      const label = HORIZON_LABELS[i]!;
      const found = ys.find((r) => r.horizonMs === HORIZONS_MS[i]);
      y[label] = found ? found.ret : null;
    }
    rows.push({
      mint,
      universe: splitUniverse(mint),
      dexId: sorted[t0]!.dexId,
      t0Date: sorted[t0]!.fetchedAt,
      feats,
      y,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Analyse par variable x horizon
// ---------------------------------------------------------------------------
interface PairXY {
  x: number[];
  y: number[];
}

function pairs(rows: Row[], feat: keyof FlowFeatures, horizon: string): PairXY {
  const x: number[] = [];
  const y: number[] = [];
  for (const r of rows) {
    const xv = r.feats[feat];
    const yv = r.y[horizon];
    if (xv !== null && xv !== undefined && yv !== null && yv !== undefined) {
      x.push(xv);
      y.push(yv);
    }
  }
  return { x, y };
}

interface VarHorizonResult {
  feature: string;
  label: string;
  horizon: string;
  n: number;
  spearman: number | null;
  spearmanP: number | null;
  spearmanCI: [number, number] | null;
  winsorizedSpearman: number | null;
  decileMedians: (number | null)[];
  decileNs: number[];
  topMedian: number | null;
  bottomMedian: number | null;
  topBottomDiff: number | null;
  topBottomDiffCI: [number, number] | null;
  ySummary: ReturnType<typeof summarize>;
  // stabilité
  half1Spearman: number | null;
  half2Spearman: number | null;
  pumpSpearman: number | null;
  otherSpearman: number | null;
}

function analyzeVarHorizon(
  rows: Row[],
  feat: keyof FlowFeatures,
  horizon: string,
): VarHorizonResult {
  const { x, y } = pairs(rows, feat, horizon);
  const rho = spearman(x, y);
  const dec = x.length >= 30 ? deciles(x) : null;
  const decileYs: number[][] = Array.from({ length: 10 }, () => []);
  if (dec) {
    for (let i = 0; i < x.length; i++) decileYs[dec.bin(x[i]!)]!.push(y[i]!);
  }
  const decileMedians = decileYs.map((d) => median(d));
  const decileNs = decileYs.map((d) => d.length);
  const top = decileYs[9]!;
  const bottom = decileYs[0]!;
  const topMedian = median(top);
  const bottomMedian = median(bottom);
  const topBottomDiff =
    topMedian !== null && bottomMedian !== null ? topMedian - bottomMedian : null;
  const topBottomDiffCI =
    top.length >= 10 && bottom.length >= 10
      ? medianDiffBootstrapCI(top, bottom, 1000)
      : null;

  // Stabilité temporelle : deux moitiés par date t0.
  const byDate = [...rows]
    .filter((r) => {
      const xv = r.feats[feat];
      const yv = r.y[horizon];
      return xv !== null && xv !== undefined && yv !== null && yv !== undefined;
    })
    .sort((a, b) => a.t0Date.localeCompare(b.t0Date));
  const mid = Math.floor(byDate.length / 2);
  const h1 = byDate.slice(0, mid);
  const h2 = byDate.slice(mid);
  const half1 = pairs(h1, feat, horizon);
  const half2 = pairs(h2, feat, horizon);

  // Stabilité par cohorte : pumpswap vs autres.
  const pump = rows.filter((r) => r.dexId === "pumpswap");
  const other = rows.filter((r) => r.dexId !== "pumpswap");
  const pPump = pairs(pump, feat, horizon);
  const pOther = pairs(other, feat, horizon);

  const yw = winsorize(y);
  return {
    feature: String(feat),
    label: FEATURE_LABELS[feat],
    horizon,
    n: x.length,
    spearman: rho,
    spearmanP: rho !== null ? spearmanP(rho, x.length) : null,
    spearmanCI: spearmanBootstrapCI(x, y, 1000),
    winsorizedSpearman: spearman(x, yw),
    decileMedians,
    decileNs,
    topMedian,
    bottomMedian,
    topBottomDiff,
    topBottomDiffCI,
    ySummary: summarize(y),
    half1Spearman: spearman(half1.x, half1.y),
    half2Spearman: spearman(half2.x, half2.y),
    pumpSpearman: spearman(pPump.x, pPump.y),
    otherSpearman: spearman(pOther.x, pOther.y),
  };
}

// ---------------------------------------------------------------------------
// Verrouillage (critères déclarés, discovery -> calibration -> holdout)
// ---------------------------------------------------------------------------
interface LockDecision {
  feature: string;
  label: string;
  locked: boolean;
  reasons: string[];
  calRho: number | null;
  calP: number | null;
  calCI: [number, number] | null;
  promotedToHoldout: boolean;
  holdoutRho: number | null;
  holdoutP: number | null;
  holdoutCI: [number, number] | null;
}

function decide(
  disc: VarHorizonResult,
  cal: VarHorizonResult,
  holdoutRows: Row[],
): LockDecision {
  const reasons: string[] = [];
  let locked = false;
  if (disc.horizon !== "1h") {
    // Le verrouillage se fait sur l'horizon 1h (n maximal).
    return {
      feature: disc.feature,
      label: disc.label,
      locked: false,
      reasons: ["verrouillage évalué sur 1h uniquement"],
      calRho: cal.spearman,
      calP: cal.spearmanP,
      calCI: cal.spearmanCI,
      promotedToHoldout: false,
      holdoutRho: null,
      holdoutP: null,
      holdoutCI: null,
    };
  }
  const rho = disc.spearman;
  if (disc.n >= 100) reasons.push(`n=${disc.n} >= 100`);
  else reasons.push(`n=${disc.n} < 100 : insuffisant`);
  if (rho !== null && Math.abs(rho) >= 0.15)
    reasons.push(`|rho|=${Math.abs(rho).toFixed(3)} >= 0.15`);
  else reasons.push(`|rho|=${rho === null ? "null" : Math.abs(rho).toFixed(3)} < 0.15`);
  if (disc.spearmanP !== null && disc.spearmanP < 0.05)
    reasons.push(`p=${disc.spearmanP.toExponential(1)} < 0.05`);
  else reasons.push(`p=${disc.spearmanP === null ? "null" : disc.spearmanP.toExponential(1)} >= 0.05`);
  const s = (v: number | null) => (v === null ? 0 : Math.sign(v));
  const sr = s(rho);
  const stable =
    sr !== 0 &&
    s(disc.half1Spearman) === sr &&
    s(disc.half2Spearman) === sr &&
    s(disc.pumpSpearman) === sr &&
    s(disc.otherSpearman) === sr;
  reasons.push(
    stable
      ? "signe stable (2 moitiés temporelles + 2 cohortes dex)"
      : "signe INSTABLE entre moitiés/cohortes",
  );
  const decileOk =
    disc.topBottomDiff !== null &&
    disc.topBottomDiffCI !== null &&
    Math.sign(disc.topBottomDiff) === sr &&
    ((disc.topBottomDiffCI[0] > 0 && sr > 0) ||
      (disc.topBottomDiffCI[1] < 0 && sr < 0));
  reasons.push(
    decileOk
      ? "décile top vs bottom : écart même signe, IC95% exclut 0"
      : "décile top vs bottom : écart non concluant",
  );
  locked =
    disc.n >= 100 &&
    rho !== null &&
    Math.abs(rho) >= 0.15 &&
    disc.spearmanP !== null &&
    disc.spearmanP < 0.05 &&
    stable &&
    decileOk;

  // Calibration : signe préservé, p < 0.10 -> promotion holdout.
  const calS = cal.spearman;
  const promoted =
    locked &&
    calS !== null &&
    Math.sign(calS) === sr &&
    cal.spearmanP !== null &&
    cal.spearmanP < 0.10 &&
    cal.n >= 30;
  reasons.push(
    promoted
      ? `calibration OK (rho=${calS?.toFixed(3)}, p<0.10, n=${cal.n}) -> holdout`
      : `calibration non concluante (rho=${calS === null ? "null" : calS.toFixed(3)}, n=${cal.n})`,
  );

  let holdoutRho: number | null = null;
  let holdoutP: number | null = null;
  let holdoutCI: [number, number] | null = null;
  if (promoted) {
    const hp = pairs(
      holdoutRows,
      disc.feature as keyof FlowFeatures,
      disc.horizon,
    );
    holdoutRho = spearman(hp.x, hp.y);
    holdoutP = holdoutRho !== null ? spearmanP(holdoutRho, hp.x.length) : null;
    holdoutCI = spearmanBootstrapCI(hp.x, hp.y, 1000);
    reasons.push(`holdout: n=${hp.x.length}`);
  }

  return {
    feature: disc.feature,
    label: disc.label,
    locked,
    reasons,
    calRho: cal.spearman,
    calP: cal.spearmanP,
    calCI: cal.spearmanCI,
    promotedToHoldout: promoted,
    holdoutRho,
    holdoutP,
    holdoutCI,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const rows = loadRows();
  const byU = (u: Row["universe"]) => rows.filter((r) => r.universe === u);
  const disc = byU("discovery");
  const cal = byU("calibration");
  const hold = byU("holdout");

  // Couverture par horizon et univers.
  const coverage: Record<string, Record<string, number>> = {};
  for (const u of ["discovery", "calibration", "holdout"] as const) {
    coverage[u] = {};
    for (const h of HORIZON_LABELS) {
      coverage[u]![h] = byU(u).filter(
        (r) => r.y[h] !== null && r.y[h] !== undefined,
      ).length;
    }
  }

  // Résumé de Y (taux de base) par univers x horizon.
  const baseRates: Record<string, Record<string, ReturnType<typeof summarize>>> = {};
  for (const u of ["discovery", "calibration", "holdout"] as const) {
    baseRates[u] = {};
    for (const h of HORIZON_LABELS) {
      const ys = byU(u)
        .map((r) => r.y[h])
        .filter((v): v is number => v !== null && v !== undefined);
      baseRates[u]![h] = summarize(ys);
    }
  }

  const discResults: VarHorizonResult[] = [];
  const calResults: VarHorizonResult[] = [];
  for (const feat of FEATURE_NAMES) {
    for (const h of HORIZON_LABELS) {
      discResults.push(analyzeVarHorizon(disc, feat, h));
      calResults.push(analyzeVarHorizon(cal, feat, h));
    }
  }

  const calByKey = new Map(calResults.map((r) => [`${r.feature}|${r.horizon}`, r]));
  const decisions: LockDecision[] = [];
  for (const d of discResults) {
    const c = calByKey.get(`${d.feature}|${d.horizon}`)!;
    decisions.push(decide(d, c, hold));
  }

  const out = {
    meta: {
      date: new Date().toISOString(),
      source: "data/history (2926 mints), séries courtes biaisées tokens chauds => bornes OPTIMISTES",
      nMints: 2926,
      nWithT0: rows.length,
      nDiscovery: disc.length,
      nCalibration: cal.length,
      nHoldout: hold.length,
      structChgPreNA:
        "structChgPre null quand t0 est le premier snapshot (~87 % des mints)",
      outlierPolicy:
        "principal AVEC outliers valides (post-aberrantMask) ; sensibilité winsorisée p1/p99",
      lockCriteria:
        "1h: n>=100, |rho|>=0.15, p<0.05, signe stable (2 moitiés + 2 cohortes), décile top-bottom même signe IC95% excluant 0 ; calibration: signe préservé, p<0.10, n>=30",
    },
    coverage,
    baseRates,
    discovery: discResults,
    calibration: calResults,
    decisions,
  };
  fs.writeFileSync("/tmp/flows-results.json", JSON.stringify(out));
  console.log("OK rows:", rows.length, "-> /tmp/flows-results.json");
}

main();
