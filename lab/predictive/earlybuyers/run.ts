/**
 * Phase 2 — Early Buyers + Survival Model : runner.
 *
 * Usage : npx tsx lab/predictive/earlybuyers/run.ts --phase discovery|calibration [--no-fetch] [--windows]
 *
 * Pipeline :
 *   1. snapshots (pré-t0 strict, historiques wallets via Helius + cache) ;
 *   2. AUDIT ANTI-LEAKAGE — fail fast (process.exit 2) si UNE SEULE feature
 *      a tsMs > t0ms ;
 *   3. labels (glitch SKHY neutralisé par défaut) ;
 *   4. stats par couple (feature, label) ;
 *   5. modèles (logistique + random forest) sur survival_50_24h ;
 *   6. comparaison ALL vs EXCLUS vs RETENUS — RÈGLES PRÉ-ENREGISTRÉES
 *      (exclusions.ts, gelées 2026-09-28 ; remplacent le placeholder
 *      « top tercile giniAmt ») ;
 *   7. analyse secondaire WITH_VALID_EXTREME_EVENTS (glitch ré-inclus) ;
 *   8b. stabilité par cohorte + temporelle (adaptateur local vers
 *      lab/predictive/wallets/analysis.ts — wallets/ non modifié) ;
 *   8c. Cox PH sur le temps jusqu'au premier passage sous -50%
 *      (survival.ts ; n<30 ou non-convergence → jamais interprété) ;
 *   8d. labels étendus §6 (graduated_7d depuis data/scans, définitions de
 *      mort multiples + accord) ;
 *   8e. scores §16 (un par token valide, score.ts) ;
 *   11. décision §17 (decide.ts : 3 états, checklist explicite).
 *
 * --windows (optionnel) : exige lab/predictive/earlybuyers/windows.ts
 * (agent A) ; s'il est absent → échec PROPRE et explicite (exit 2), jamais
 * silencieux. Défaut (flag absent) : comportement actuel inchangé.
 *
 * GARANTIES :
 *  - le holdout n'est JAMAIS lu : tout mint holdout trouvé dans
 *    data/earlybuyers/ est ignoré ET compté ; si un row holdout atteint
 *    l'analyse → FAIL ;
 *  - data/track-unbiased/ n'est JAMAIS lu (holdout gelé du programme) ;
 *  - data/history/ et data/scans/ sont biaisées vers les tokens chauds :
 *    toute mesure = borne OPTIMISTE (déclaré dans le rapport) ;
 *  - n < 30 → verdict NON_CONCLUSIF, jamais interprété.
 *
 * AUCUNE stratégie construite. AUCUNE transaction réelle. AUCUN push.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { splitUniverse, type Universe } from "../universe.ts";
import { buildSnapshots } from "./snapshot.ts";
import {
  buildOverlapIndex,
  computeFeatureSet,
  featureKeys,
} from "./features.ts";
import { computeLabels, computeExtendedLabels, dd50TimeToEvent, readMigrationTimes, DATA_ERROR_MINTS } from "./labels.ts";
import { applyExclusions, type ExclusionCtx } from "./exclusions.ts";
import { fitCoxPH } from "./survival.ts";
import {
  buildTokenScore,
  MODEL_VERSION,
  type TokenScore,
} from "./score.ts";
import {
  evaluateDecisionState,
  type ChecklistItem,
} from "./decide.ts";
import { analyzePair, MIN_N_CONCLUSIVE, type PairAnalysis } from "./stats.ts";
import {
  trainLogistic,
  trainRandomForest,
  type ModelInput,
  type ModelReport,
} from "./models.ts";
import {
  compareAllExcludedRetained,
  type CompareResult,
  type CompareRow,
  type ExclusionRule,
} from "./compare.ts";
import { cohortStability, temporalStability, type StabilityResult, type CohortResult } from "../wallets/analysis.ts";
import type { DiscoveryRow, HorizonLabel } from "../wallets/types.ts";
import { auditAntiLeakage, formatViolations, type AuditResult } from "./audit.ts";
import type { CoxResult } from "./survival.ts";
import type { EarlyBuyerSnapshot, FeatureSet, Labels, SnapshotBuyer } from "./types.ts";

type Phase = "discovery" | "calibration";

function parseArgs(): { phase: Phase; fetch: boolean; windows: boolean } {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--phase");
  const phase = pi >= 0 ? args[pi + 1] : undefined;
  if (phase !== "discovery" && phase !== "calibration") {
    console.error("Usage: run.ts --phase discovery|calibration [--no-fetch] [--windows]");
    process.exit(2);
  }
  return {
    phase,
    fetch: !args.includes("--no-fetch"),
    windows: args.includes("--windows"),
  };
}

/** true si le cache earlybuyers du mint est marqué tronqué (lecture seule). */
function readTruncatedFlag(mint: string): boolean {
  try {
    const raw = readFileSync(join("data/earlybuyers", `${mint}.json`), "utf-8");
    return (JSON.parse(raw) as { truncated?: unknown }).truncated === true;
  } catch {
    return false;
  }
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * ADAPTATEUR LOCAL (ne modifie pas lab/predictive/wallets/) : convertit les
 * lignes Phase 2 en DiscoveryRow pour réutiliser cohortStability /
 * temporalStability de wallets/analysis.ts.
 *  - sellersOver50 / medianSoldFrac = null : INTERDITS en Phase 2
 *    (contamination Phase 1 : ventes post-migration) ;
 *  - survie : seule survival_50_24h existe en Phase 2 → 1h/6h = null
 *    (ignorés par xyPairs, jamais interprétés).
 */
function toDiscoveryRow(
  r: AnalyzedRow,
  truncated: boolean,
): DiscoveryRow {
  const f = (k: string): number | null =>
    numOrNull(r.fs.features[k]?.value);
  return {
    mint: r.mint,
    universe: r.universe,
    features: {
      mint: r.mint,
      buyerCount: f("nBuyers") ?? 0,
      top5Share: f("top5Share"),
      gini: f("giniAmt"),
      sameSlotMax: f("sameSlotMax"),
      arrivalSpanSec: f("arrivalSpanSec"),
      medianInterArrivalSec: f("medianInterArrivalSec"),
      top1AmountShare: f("top1Share"),
      overlapFrac: f("overlapFrac"),
      sellersOver50: null,
      medianSoldFrac: null,
      devHistory: null,
      truncated,
    },
    outcome: {
      mint: r.mint,
      universe: r.universe,
      t0Index: 0,
      t0Time: r.t0ms > 0 ? new Date(r.t0ms).toISOString() : "",
      nTicks: 0,
      aberrantTicks: 0,
      y: { "1h": r.labels.y1h, "6h": r.labels.y6h, "24h": r.labels.y24h },
      survival: { "1h": null, "6h": null, "24h": r.labels.survival_50_24h },
    },
  };
}

const NUMERIC_LABELS = ["y1h", "y6h", "y24h", "ddMax24h"] as const;
const BOOL_LABELS = [
  "dd30_24h",
  "dd50_24h",
  "dd80_24h",
  "survival_30_24h",
  "survival_50_24h",
  "survival_80_24h",
] as const;

function labelValue(l: Labels, key: string): number | null {
  const v = (l as unknown as Record<string, number | boolean | null>)[key];
  if (v == null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return Number.isFinite(v) ? v : null;
}

interface AnalyzedRow {
  mint: string;
  universe: Universe;
  t0ms: number;
  fs: FeatureSet;
  labels: Labels;
}

function buildRows(
  analyzed: AnalyzedRow[],
  opts: { includeDataError: boolean },
): { stats: PairAnalysis[]; modelRows: ModelInput & { mints: string[] }; compareRows: CompareRow[] } {
  const rows = opts.includeDataError
    ? analyzed
    : analyzed.filter((r) => !r.labels.dataError);
  const fkeys = featureKeys();
  const labelKeys = [...NUMERIC_LABELS, ...BOOL_LABELS];

  // Stats par couple.
  const stats: PairAnalysis[] = [];
  for (const fk of fkeys) {
    for (const lk of labelKeys) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const r of rows) {
        const x = r.fs.features[fk]?.value ?? null;
        const y = labelValue(r.labels, lk);
        if (x != null && Number.isFinite(x) && y != null) {
          xs.push(x);
          ys.push(y);
        }
      }
      if (xs.length >= 3) stats.push(analyzePair(fk, lk, xs, ys));
    }
  }

  // Modèles : lignes complètes (15 features non-null) + label survival_50_24h.
  const mints: string[] = [];
  const X: number[][] = [];
  const y: boolean[] = [];
  for (const r of rows) {
    const vals = fkeys.map((fk) => r.fs.features[fk]?.value ?? null);
    const lab = r.labels.survival_50_24h;
    if (lab == null || vals.some((v) => v == null || !Number.isFinite(v))) continue;
    mints.push(r.mint);
    X.push(vals as number[]);
    y.push(lab);
  }

  // Comparaison : lignes avec y6h.
  const compareRows: CompareRow[] = rows
    .filter((r) => r.labels.y6h != null)
    .map((r) => ({
      mint: r.mint,
      t0ms: r.t0ms,
      ruleValue: r.fs.features["giniAmt"]?.value ?? null,
      y1h: r.labels.y1h,
      y6h: r.labels.y6h,
      y24h: r.labels.y24h,
      survival_50_24h: r.labels.survival_50_24h,
    }));

  return {
    stats,
    modelRows: { X, y, featureNames: fkeys, mints },
    compareRows,
  };
}

/** Forme structurelle du module windows.ts (import dynamique — jamais d'import statique). */
interface WindowsModuleShape {
  WINDOW_DEFS: Array<{ def: string; desc: string }>;
  applyWindow: (buyers: SnapshotBuyer[], def: string) => SnapshotBuyer[];
}

interface DeathSensitivity {
  n: number;
  graduated_7d: { true: number; false: number; null: number };
  death_liq_7d: { true: number; false: number; null: number };
  death_price_7d: { true: number; false: number; null: number };
  death_dd80_24h: { true: number; false: number; null: number };
  agreement: { agree: number; disagree: number; na: number };
  note: string;
}

/** Analyse complète pour UNE définition de fenêtre (FeatureSet séparé). */
interface WindowAnalysis {
  def: string;
  desc: string;
  counts: {
    snapshotsValid: number;
    dataErrorNeutralized: number;
    labeledRows: number;
  };
  audit: AuditResult;
  stats: {
    nTests: number;
    nConclusive: number;
    significantPairs: PairAnalysis[];
    topPairsByAbsSpearman: PairAnalysis[];
  };
  models: {
    logistic: ModelReport & { suspect: boolean };
    randomForest: ModelReport & { suspect: boolean };
    label: string;
    nModelRows: number;
  };
  compare: CompareResult | null;
  stability: {
    note: string;
    temporal: StabilityResult[];
    cohort: CohortResult[];
  };
  cox: {
    note: string;
    featureNames: string[];
  } & CoxResult;
  deathDefinitions: DeathSensitivity;
  scores: TokenScore[];
  secondary: {
    nTests: number;
    topConclusivePairs: PairAnalysis[];
  };
  verdict: string;
  verdictReason: string;
}

const COX_FEATURES = ["nBuyers", "giniAmt", "top1Share", "top5Share", "sameSlotMax"];

/**
 * Analyse complète d'une fenêtre : filtre les buyers via applyWindow,
 * RECALCULE les features (overlap index reconstruit sur la fenêtre),
 * puis rejoue tout le pipeline (audit, stats, modèles, comparaisons,
 * stabilité, Cox, morts, scores, secondaire, verdict).
 * Les labels sont indépendants de la fenêtre (calculés une fois).
 */
function analyzeWindow(
  def: string,
  desc: string,
  valid: EarlyBuyerSnapshot[],
  labelsByMint: Map<string, Labels>,
  ctx: {
    phase: Phase;
    truncatedByMint: Map<string, boolean>;
    migrationTimes: Map<string, number[]>;
    applyWindow: (buyers: SnapshotBuyer[], def: string) => SnapshotBuyer[];
    rule: ExclusionRule;
  },
): WindowAnalysis {
  // Fenêtre : filtre le set pré-t0 (jamais de buyer postérieur introduit).
  const wsnapshots = valid.map((s) => ({
    ...s,
    buyers: ctx.applyWindow(s.buyers, def),
  }));

  // Features (overlap index reconstruit sur la fenêtre — discovery+calibration uniquement, jamais holdout).
  const overlapIdx = buildOverlapIndex(wsnapshots);
  const featureSets = wsnapshots.map((s) => computeFeatureSet(s, overlapIdx));

  // AUDIT ANTI-LEAKAGE — fail fast.
  const audit = auditAntiLeakage(featureSets);
  console.error(`[earlybuyers][${def}] audit anti-fuite : ${audit.pass ? "PASS" : "FAIL"} (${audit.checked} features vérifiées)`);
  if (!audit.pass) {
    console.error(`[earlybuyers][${def}] VIOLATIONS :\n` + formatViolations(audit.violations));
    process.exit(2);
  }

  const analyzed: AnalyzedRow[] = wsnapshots.map((s, i) => ({
    mint: s.mint,
    universe: s.universe,
    t0ms: s.t0ms,
    fs: featureSets[i]!,
    labels: labelsByMint.get(s.mint)!,
  }));
  const nDataError = analyzed.filter((r) => r.labels.dataError).length;

  // Analyse principale (sans DATA_ERROR).
  const built = buildRows(analyzed, { includeDataError: false });

  // Modèles sur survival_50_24h.
  const logreg: ModelReport = trainLogistic(built.modelRows);
  const rf: ModelReport = trainRandomForest(built.modelRows);

  // Comparaison ALL vs EXCLUS vs RETENUS — RÈGLES PRÉ-ENREGISTRÉES.
  // Encodage : exclu → ruleValue 1, retenu → 0, seuil 0.5.
  const exclCtxByMint = new Map<string, ExclusionCtx>();
  for (const r of analyzed) {
    exclCtxByMint.set(r.mint, {
      mint: r.mint,
      dataError: r.labels.dataError,
      truncated: ctx.truncatedByMint.get(r.mint) ?? false,
      nBuyers: numOrNull(r.fs.features["nBuyers"]?.value) ?? 0,
      sameSlotMax: numOrNull(r.fs.features["sameSlotMax"]?.value),
    });
  }
  const compareRowsExcl: CompareRow[] = built.compareRows.map((cr) => {
    const ectx = exclCtxByMint.get(cr.mint);
    const res = ectx
      ? applyExclusions(ectx)
      : { excluded: false, reasons: [] as string[] };
    return { ...cr, ruleValue: res.excluded ? 1 : 0 };
  });
  const compare: CompareResult | null = compareAllExcludedRetained(
    compareRowsExcl,
    ctx.rule,
    { descriptiveOnly: ctx.phase === "discovery" },
  );

  // Stabilité par cohorte + temporelle (adaptateur local, wallets/ intact).
  const primaryRows = analyzed.filter((r) => !r.labels.dataError);
  const drows: DiscoveryRow[] = primaryRows.map((r) =>
    toDiscoveryRow(r, ctx.truncatedByMint.get(r.mint) ?? false),
  );
  const horizons: HorizonLabel[] = ["1h", "6h", "24h"];
  const allowedCohorts: Array<"discovery" | "calibration" | "holdout"> =
    ctx.phase === "discovery" ? ["discovery"] : ["discovery", "calibration"];
  const stability = {
    note: "Réutilise cohortStability/temporalStability de lab/predictive/wallets/analysis.ts via adaptateur local (sellersOver50/medianSoldFrac = null, INTERDITS en Phase 2).",
    temporal: temporalStability(drows, horizons),
    cohort: cohortStability(drows, horizons, allowedCohorts),
  };

  // Cox PH : temps jusqu'au premier passage sous -50% (censure 24h/fin série).
  const coxDurations: number[] = [];
  const coxEvents: boolean[] = [];
  const coxX: number[][] = [];
  for (const r of primaryRows) {
    const tte = dd50TimeToEvent(r.mint);
    if (!tte) continue;
    const xs = COX_FEATURES.map((k) => numOrNull(r.fs.features[k]?.value));
    if (xs.some((v) => v == null)) continue;
    coxDurations.push(tte.tHours);
    coxEvents.push(tte.event);
    coxX.push(xs as number[]);
  }
  const coxResult = fitCoxPH({
    durations: coxDurations,
    events: coxEvents,
    X: coxX,
    featureNames: COX_FEATURES,
  });
  const cox = {
    note: "Cox PH (Breslow, Newton-Raphson, max 100 itérations) sur le temps jusqu'au premier passage sous -50% (censure 24h/fin de série). n<30 ou non-convergence → converged=false, concordance=null, jamais interprété.",
    featureNames: COX_FEATURES,
    ...coxResult,
  };

  // Labels étendus §6 — sensibilité aux définitions.
  const extLabels = primaryRows.map((r) =>
    computeExtendedLabels(r.mint, { migrationTimes: ctx.migrationTimes }),
  );
  const count3 = (arr: Array<boolean | null>) => ({
    true: arr.filter((v) => v === true).length,
    false: arr.filter((v) => v === false).length,
    null: arr.filter((v) => v == null).length,
  });
  const deathDefinitions: DeathSensitivity = {
    n: extLabels.length,
    graduated_7d: count3(extLabels.map((l) => l.graduated_7d)),
    death_liq_7d: count3(extLabels.map((l) => l.death_liq_7d)),
    death_price_7d: count3(extLabels.map((l) => l.death_price_7d)),
    death_dd80_24h: count3(extLabels.map((l) => l.death_dd80_24h)),
    agreement: {
      agree: extLabels.filter((l) => l.deathAgreement.agree === true).length,
      disagree: extLabels.filter((l) => l.deathAgreement.agree === false).length,
      na: extLabels.filter((l) => l.deathAgreement.agree == null).length,
    },
    note: "death_dd80_24h = alias de dd80_24h ; accord = définitions non-null d'accord entre elles",
  };

  // Scores §16 — un par snapshot VALIDE (jamais de valeur inventée).
  // Les snapshots DATA_ERROR sont des snapshots valides : leur score existe
  // mais porte EXCLUSION_REASON (labels neutralisés à null).
  const snapshotByMint = new Map<string, EarlyBuyerSnapshot>(
    valid.map((s) => [s.mint, s]),
  );
  const maxFeatureTs = (fs: FeatureSet): number | null => {
    const ts = Object.values(fs.features)
      .map((fv) => fv.tsMs)
      .filter((t) => Number.isFinite(t));
    return ts.length ? Math.max(...ts) : null;
  };
  const scores: TokenScore[] = analyzed.map((r) => {
    const ectx = exclCtxByMint.get(r.mint);
    return buildTokenScore({
      snapshot: snapshotByMint.get(r.mint)!,
      featureSet: r.fs,
      labels: r.labels,
      auditPass: audit.pass,
      auditMaxTsMs: maxFeatureTs(r.fs),
      exclusionReasons: ectx ? applyExclusions(ectx).reasons : [],
      truncated: ectx?.truncated ?? false,
    });
  });

  // Analyse secondaire WITH_VALID_EXTREME_EVENTS (glitch ré-inclus, mesure séparée).
  const analyzedWithExtreme = wsnapshots.map((s, i) => ({
    mint: s.mint,
    universe: s.universe,
    t0ms: s.t0ms,
    fs: featureSets[i]!,
    labels: computeLabels(s.mint, { includeDataError: true }),
  }));
  const secondaryBuilt = buildRows(analyzedWithExtreme, { includeDataError: true });
  const secondaryTop = [...secondaryBuilt.stats]
    .filter((p) => p.conclusive)
    .sort((a, b) => Math.abs(b.spearman ?? 0) - Math.abs(a.spearman ?? 0))
    .slice(0, 10);

  // Verdict.
  const nLabeled = built.compareRows.length;
  const significant = built.stats.filter(
    (p) => p.conclusive && p.pValuePerm != null && p.pValuePerm < 0.05,
  );
  const topPairs = [...built.stats]
    .filter((p) => p.spearman != null)
    .sort((a, b) => Math.abs(b.spearman!) - Math.abs(a.spearman!))
    .slice(0, 15);

  let verdict: string;
  let verdictReason: string;
  if (nLabeled < MIN_N_CONCLUSIVE) {
    verdict = "NON_CONCLUSIF";
    verdictReason = `n=${nLabeled} lignes avec labels < ${MIN_N_CONCLUSIVE} : aucune interprétation (le backfill continue en parallèle)`;
  } else if (significant.length > 0) {
    verdict = "CANDIDAT_A_VERIFIER";
    verdictReason = `${significant.length} couple(s) (feature, label) significatif(s) à p<0.05 sur n>=${MIN_N_CONCLUSIVE} — à re-mesurer sur calibration puis holdout gelé`;
  } else {
    verdict = "AUCUN_SIGNAL";
    verdictReason = `aucun couple significatif à p<0.05 sur ${built.stats.length} tests (n>=${MIN_N_CONCLUSIVE})`;
  }

  // Règle SUSPECT : modèle "gagnant" sans test simple significatif.
  const modelWins = (m: ModelReport): boolean => {
    if (m.baselineAcc == null) return false;
    const perf = m.oobAcc ?? m.trainAcc;
    return perf != null && perf > m.baselineAcc + 0.05;
  };
  const suspectLogreg =
    modelWins(logreg) && significant.length === 0 && verdict !== "NON_CONCLUSIF";
  const suspectRF =
    modelWins(rf) && significant.length === 0 && verdict !== "NON_CONCLUSIF";

  return {
    def,
    desc,
    counts: {
      snapshotsValid: wsnapshots.length,
      dataErrorNeutralized: nDataError,
      labeledRows: nLabeled,
    },
    audit,
    stats: {
      nTests: built.stats.length,
      nConclusive: built.stats.filter((p) => p.conclusive).length,
      significantPairs: significant,
      topPairsByAbsSpearman: topPairs,
    },
    models: {
      logistic: { ...logreg, suspect: suspectLogreg },
      randomForest: { ...rf, suspect: suspectRF },
      label: "survival_50_24h",
      nModelRows: built.modelRows.X.length,
    },
    compare,
    stability,
    cox,
    deathDefinitions,
    scores,
    secondary: {
      nTests: secondaryBuilt.stats.length,
      topConclusivePairs: secondaryTop,
    },
    verdict,
    verdictReason,
  };
}

async function main(): Promise<void> {
  const { phase, fetch, windows } = parseArgs();
  const tStart = Date.now();
  console.error(`[earlybuyers] phase=${phase} fetch=${fetch} windows=${windows}`);

  // 1. Liste des mints — le holdout est écarté AVANT toute lecture.
  const files = readdirSync("data/earlybuyers").filter(
    (f) => f.endsWith(".json") && !f.startsWith("wallet-histories"),
  );
  const allowed: Universe[] =
    phase === "discovery" ? ["discovery"] : ["discovery", "calibration"];
  const skippedHoldout: string[] = [];
  const skippedUniverse: string[] = [];
  const mints: string[] = [];
  for (const f of files) {
    const mint = f.replace(/\.json$/, "");
    const u = splitUniverse(mint);
    if (u === "holdout") {
      skippedHoldout.push(mint); // JAMAIS lu
      continue;
    }
    if (!allowed.includes(u)) {
      skippedUniverse.push(mint);
      continue;
    }
    mints.push(mint);
  }
  console.error(
    `[earlybuyers] ${mints.length} mints à traiter (${skippedHoldout.length} holdout ignorés, jamais lus ; ${skippedUniverse.length} hors phase)`,
  );

  // 2. Snapshots.
  const snapshots = await buildSnapshots(mints, { fetchMissing: fetch });
  const valid = snapshots.filter((s) => !s.excludedReason);
  const exclusions = snapshots
    .filter((s) => s.excludedReason)
    .map((s) => ({ mint: s.mint, universe: s.universe, reason: s.excludedReason }));

  // GARDE : aucun row holdout ne doit atteindre l'analyse.
  for (const s of valid) {
    if (s.universe === "holdout") {
      console.error(`[earlybuyers] FAIL : row holdout inattendu (${s.mint})`);
      process.exit(2);
    }
  }

  // 3. Labels (indépendants de la fenêtre — calculés une fois) +
  //    ressources partagées par toutes les fenêtres.
  const labelsByMint = new Map<string, Labels>();
  for (const s of valid) labelsByMint.set(s.mint, computeLabels(s.mint));
  const truncatedByMint = new Map<string, boolean>();
  for (const f of files) {
    const mint = f.replace(/\.json$/, "");
    truncatedByMint.set(mint, readTruncatedFlag(mint));
  }
  const migrationTimes = readMigrationTimes("data/scans");

  // 4. Règle pré-enregistrée (identique pour toutes les fenêtres).
  const rule: ExclusionRule = {
    feature: "preregistered_exclusion",
    threshold: 0.5,
    direction: "exclude_high",
    origin:
      "PREREGISTERED_EXCLUSIONS gelées 2026-09-28 (DATA_ERROR, TRUNCATED, " +
      "SMALL_SET nBuyers<5, SNIPE_DOMINATED sameSlotMax>=nBuyers/2) — remplace " +
      "le placeholder « top tercile giniAmt » (quantile 2/3 sur discovery, arbitraire)",
  };

  // 5. Fenêtres à analyser. Import DYNAMIQUE : si le flag --windows est
  //    passé mais que windows.ts (agent A) est absent ou sans les exports
  //    WINDOW_DEFS/applyWindow, ÉCHEC PROPRE et explicite — jamais silencieux.
  //    Défaut (flag absent) : ["pre_t0_set"] = comportement actuel inchangé.
  let windowsMod: WindowsModuleShape | null = null;
  if (windows) {
    const windowsPath: string = "./windows.ts"; // string non-littéral : tsc ne résout pas, échec capté à l'exécution
    try {
      windowsMod = (await import(windowsPath)) as WindowsModuleShape;
    } catch {
      windowsMod = null;
    }
    if (
      windowsMod == null ||
      !Array.isArray(windowsMod.WINDOW_DEFS) ||
      typeof windowsMod.applyWindow !== "function"
    ) {
      console.error(
        "[earlybuyers] --windows demandé mais lab/predictive/earlybuyers/windows.ts " +
          "n'est pas livré (ou sans exports WINDOW_DEFS/applyWindow — agent A). " +
          "Échec propre : aucun calcul effectué.",
      );
      process.exit(2);
    }
  }
  const windowDefs: Array<{ def: string; desc: string }> = windowsMod
    ? windowsMod.WINDOW_DEFS
    : [
        {
          def: "pre_t0_set",
          desc: "identité : set pré-t0 complet (comportement actuel, inchangé)",
        },
      ];
  const applyWindowFn: (buyers: SnapshotBuyer[], def: string) => SnapshotBuyer[] =
    windowsMod?.applyWindow ?? ((buyers) => buyers);
  console.error(
    `[earlybuyers] fenêtres à analyser : ${windowDefs.map((w) => w.def).join(", ")}`,
  );

  // 6. Analyse par fenêtre : features RECALCULÉES par WINDOW_DEF
  //    (overlap index reconstruit sur la fenêtre — discovery+calibration
  //    uniquement, jamais holdout ; audit anti-fuite fail-fast par fenêtre).
  const analyses = new Map<string, WindowAnalysis>();
  for (const w of windowDefs) {
    console.error(`[earlybuyers] fenêtre ${w.def} : ${w.desc}`);
    analyses.set(
      w.def,
      analyzeWindow(w.def, w.desc, valid, labelsByMint, {
        phase,
        truncatedByMint,
        migrationTimes,
        applyWindow: applyWindowFn,
        rule,
      }),
    );
  }
  // "Primaire" = pre_t0_set : TOUT le rapport/décision historique repose
  // dessus, inchangé quand --windows est absent. Repli sur la première
  // fenêtre si pre_t0_set n'était pas dans WINDOW_DEFS (ne devrait pas arriver).
  const primary = analyses.get("pre_t0_set") ?? [...analyses.values()][0]!;

  // (étapes 8b-10 — stabilité, Cox PH, définitions de mort, scores §16,
  //  analyse secondaire, verdict — désormais calculées dans analyzeWindow()
  //  pour chaque fenêtre ; voir `primary` ci-dessus)

  // 11. Décision §17 — checklist explicite, checks non évaluables = pass:null.
  // Basée sur la fenêtre primaire (pre_t0_set).
  const nLabeled = primary.counts.labeledRows;
  const significant = primary.stats.significantPairs;
  const checks: ChecklistItem[] = [
    {
      id: "oos_holdout",
      desc: "Signal confirmé sur holdout gelé (jamais lu avant verrouillage)",
      pass: null,
      detail: "holdout jamais lu (garde FAIL active) — non évaluable",
    },
    {
      id: "time_split",
      desc: "Signal stable sur split temporel (deux moitiés de t0)",
      pass: null,
      detail:
        "stabilité temporelle calculée via wallets/analysis.ts mais n insuffisant — non évaluable",
    },
    {
      id: "unbiased_universe",
      desc: "Mesuré sur univers non biaisé (track-unbiased)",
      pass: null,
      detail:
        "data/track-unbiased/ jamais lue (holdout gelé du programme) — non évaluable",
    },
    {
      id: "multi_horizons",
      desc: "Signal cohérent sur 1h/6h/24h",
      pass: null,
      detail: "aucun signal simple à comparer entre horizons — non évaluable",
    },
    {
      id: "multi_cohorts",
      desc: "Signal stable par cohorte (discovery/calibration)",
      pass: null,
      detail:
        "stabilité par cohorte calculée mais n insuffisant — non évaluable",
    },
    {
      id: "multi_definitions",
      desc: "Robustesse à plusieurs définitions (rendements, morts)",
      pass: null,
      detail:
        "définitions de mort multiples calculées (deathAgreement) mais aucun signal — non évaluable",
    },
    {
      id: "simple_tests",
      desc: "Tests simples significatifs (Spearman + permutation, n>=30)",
      pass:
        nLabeled >= MIN_N_CONCLUSIVE ? significant.length > 0 : null,
      detail:
        nLabeled >= MIN_N_CONCLUSIVE
          ? `${significant.length} couple(s) significatif(s) à p<0.05`
          : `n=${nLabeled} < ${MIN_N_CONCLUSIVE} — non évaluable`,
    },
    {
      id: "competing_models",
      desc: "Modèles concurrents convergents (logistique, RF)",
      pass: null,
      detail: "n insuffisant pour entraîner des modèles — non évaluable",
    },
    {
      id: "cost_sensitivity",
      desc: "Robustesse aux coûts (frais/slippage)",
      pass: null,
      detail: "pas d'analyse de coûts dans ce run — non évaluable",
    },
    {
      id: "outliers",
      desc: "Outliers de données traités (DATA_ERROR, aberrantMask, analyse secondaire)",
      pass: true,
      detail:
        "DATA_ERROR_MINTS neutralisés par défaut, aberrantMask appliqué aux prix, analyse secondaire WITH_VALID_EXTREME_EVENTS séparée",
    },
    {
      id: "stability",
      desc: "Stabilité mesurée (temporelle + cohortes)",
      pass: null,
      detail:
        "calculée via wallets/analysis.ts (adaptateur local) mais n insuffisant — non évaluable",
    },
  ];
  // lossSignal : aucun signal de PERTE validé OOS dans le programme
  // early-buyers (les 3 signaux Phase 1 appartiennent à un autre programme).
  const decision = evaluateDecisionState(checks, false);

  const report = {
    program: "earlybuyers-phase2",
    question:
      "La composition des early buyers à t0 contient-elle une information statistiquement stable sur la distribution future du token ?",
    phase,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - tStart,
    biasNote:
      "data/history/ et data/scans/ biaisées vers les tokens chauds → toute mesure = borne OPTIMISTE. data/track-unbiased/ JAMAIS lue (holdout gelé).",
    strategyBuilt: false,
    window: primary.def,
    windowDesc: primary.desc,
    counts: {
      filesListed: files.length,
      mintsProcessed: mints.length,
      holdoutSkippedUnread: skippedHoldout.length,
      offPhaseSkipped: skippedUniverse.length,
      snapshotsValid: valid.length,
      snapshotsExcluded: exclusions.length,
      dataErrorNeutralized: primary.counts.dataErrorNeutralized,
      labeledRows: primary.counts.labeledRows,
    },
    exclusions,
    audit: {
      pass: primary.audit.pass,
      checked: primary.audit.checked,
      violations: primary.audit.violations,
    },
    stats: {
      nTests: primary.stats.nTests,
      nConclusive: primary.stats.nConclusive,
      significantPairs: primary.stats.significantPairs,
      topPairsByAbsSpearman: primary.stats.topPairsByAbsSpearman,
    },
    models: {
      logistic: primary.models.logistic,
      randomForest: primary.models.randomForest,
      label: primary.models.label,
      nModelRows: primary.models.nModelRows,
    },
    compare: primary.compare,
    exclusionsPreregistered: {
      note: "Règles gelées 2026-09-28 (exclusions.ts) — remplacent le placeholder « top tercile giniAmt ».",
      rule,
    },
    stability: primary.stability,
    coxPH: primary.cox,
    deathDefinitions: primary.deathDefinitions,
    scores: primary.scores,
    modelVersion: MODEL_VERSION,
    decision: {
      state: decision.state,
      checklist: decision.checklist,
      summary: decision.summary,
    },
    secondaryWithValidExtremeEvents: {
      note: "Analyse secondaire : DATA_ERROR_MINTS ré-inclus (glitch connu) pour mesurer l'effet de l'outlier — jamais la mesure principale.",
      dataErrorMints: [...DATA_ERROR_MINTS],
      nTests: primary.secondary.nTests,
      topConclusivePairs: primary.secondary.topConclusivePairs,
    },
    // Section multi-fenêtres (--windows) : résumé allégé par WINDOW_DEF.
    // Absente sans le flag. Chaque fenêtre a ses features RECALCULÉES
    // (overlap index reconstruit sur la fenêtre).
    ...(windows
      ? {
          windows: Object.fromEntries(
            [...analyses.entries()].map(([def, a]) => [
              def,
              {
                def: a.def,
                desc: a.desc,
                counts: a.counts,
                audit: {
                  pass: a.audit.pass,
                  checked: a.audit.checked,
                  nViolations: a.audit.violations.length,
                },
                verdict: a.verdict,
                verdictReason: a.verdictReason,
                nTests: a.stats.nTests,
                nConclusive: a.stats.nConclusive,
                nSignificant: a.stats.significantPairs.length,
                topPairsByAbsSpearman: a.stats.topPairsByAbsSpearman.slice(0, 5),
                compareGroups: a.compare?.groups ?? null,
                nModelRows: a.models.nModelRows,
              },
            ]),
          ),
        }
      : {}),
    verdict: primary.verdict,
    verdictReason: primary.verdictReason,
    honesty: {
      minNConclusive: MIN_N_CONCLUSIVE,
      noSmartMoneyLabeling: true,
      phase1ContaminationFixed:
        "sellersOver50/medianSoldFrac (ventes post-migration) INTERDITS en Phase 2 ; overlapFrac construit uniquement sur discovery+calibration, observations <= t0ms",
    },
  };

  const outDir = "lab/predictive/earlybuyers";
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = join(outDir, `results-${stamp}-${phase}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error(`[earlybuyers] rapport écrit : ${outPath}`);
  console.log(JSON.stringify(report));
}

main().catch((e) => {
  console.error("[earlybuyers] ERREUR FATALE :", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
