/**
 * Pipeline DÉCOUVERTE — Domaine 1/5 wallets/early buyers.
 *
 * Usage : npx tsx lab/predictive/wallets/pipeline.ts [--phase discovery|calibration]
 *
 * GRILLE ANTI-OVERFITTING (dure) :
 * - phase discovery (défaut) : seules les lignes `discovery` sont analysées.
 * - phase calibration : discovery + calibration, UNIQUEMENT après verrouillage
 *   explicite des hypothèses (le flag est l'acte de verrouillage).
 * - holdout : JAMAIS analysé par ce pipeline. La mesure OOS unique fera
 *   l'objet d'un script dédié après gel de la calibration.
 *
 * Sortie : rapport JSON sur stdout (n<30 => verdict NON_CONCLUSIF).
 * AUCUN push, AUCUNE transaction, AUCUNE écriture hors stdout.
 */
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import {
  buildOverlapMap,
  computeFeatures,
  listEarlyBuyerFiles,
  readEarlyBuyersFile,
} from "./features.ts";
import { computeOutcome, horizonCoverage, readHistorySeries } from "./outcomes.ts";
import {
  cohortStability,
  decileTopBottom,
  spearmanByHorizon,
  temporalStability,
} from "./analysis.ts";
import { splitUniverse } from "../universe.ts";
import type { DiscoveryRow, EarlyBuyersFile, HorizonLabel } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EARLYBUYERS_DIR = path.join(REPO_ROOT, "data", "earlybuyers");
const HISTORY_DIR = path.join(REPO_ROOT, "data", "history");
const HORIZONS: HorizonLabel[] = ["1h", "6h", "24h"];
const MIN_N_CONCLUSIVE = 30;

function main(): void {
  const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
  const phase = phaseArg ? phaseArg.split("=")[1] : "discovery";
  const calibrationUnlocked = phase === "calibration";
  if (phase !== "discovery" && phase !== "calibration") {
    console.error(`phase inconnue: ${phase} (attendu discovery|calibration)`);
    process.exit(2);
  }

  // 1. Chargement (tolérant : backfill en cours).
  const files: EarlyBuyersFile[] = [];
  const skipped: string[] = [];
  for (const f of listEarlyBuyerFiles(EARLYBUYERS_DIR)) {
    const parsed = readEarlyBuyersFile(f);
    if (parsed) files.push(parsed);
    else skipped.push(path.basename(f));
  }

  // 2. Overlap inter-tokens : statistique descriptive sur l'ensemble des
  //    fichiers (aucun seuil appris => pas de fuite du lien X->Y).
  const overlapMap = buildOverlapMap(files);

  // 3. Features + outcomes.
  const rows: DiscoveryRow[] = [];
  const noHistory: string[] = [];
  const noT0: string[] = [];
  for (const f of files) {
    const series = readHistorySeries(HISTORY_DIR, f.mint);
    if (series.length === 0) {
      noHistory.push(f.mint);
      continue;
    }
    const outcome = computeOutcome(f.mint, series);
    if (!outcome) {
      noT0.push(f.mint);
      continue;
    }
    rows.push({
      mint: f.mint,
      universe: splitUniverse(f.mint),
      features: computeFeatures(f, overlapMap),
      outcome,
    });
  }

  // 4. Grille : seules les lignes des univers débloqués sont analysées.
  const allowed = calibrationUnlocked
    ? ["discovery", "calibration"]
    : ["discovery"];
  const analyzed = rows.filter((r) => (allowed as string[]).includes(r.universe));
  const universeCounts: Record<string, number> = {};
  for (const r of rows) universeCounts[r.universe] = (universeCounts[r.universe] ?? 0) + 1;

  const n = analyzed.length;
  const verdict = n < MIN_N_CONCLUSIVE ? "NON_CONCLUSIF" : "ANALYSE_STANDARD";

  const report = {
    generatedAt: new Date().toISOString(),
    phase,
    calibrationUnlocked,
    note_biais:
      "data/history/ et data/earlybuyers/ biaisés vers les tokens chauds : toute mesure = borne OPTIMISTE.",
    fichiers: {
      lus: files.length,
      ignores_incomplets: skipped,
      sans_history: noHistory,
      sans_t0: noT0,
    },
    univers: universeCounts,
    lignes_analysees: n,
    verdict,
    couverture_horizons: horizonCoverage(rows.map((r) => r.outcome)),
    spearman_avec_outliers: spearmanByHorizon(analyzed, HORIZONS, false),
    spearman_sans_outliers: spearmanByHorizon(analyzed, HORIZONS, true),
    deciles_avec_outliers: decileTopBottom(analyzed, HORIZONS, false),
    deciles_sans_outliers: decileTopBottom(analyzed, HORIZONS, true),
    stabilite_temporelle: temporalStability(analyzed, HORIZONS),
    stabilite_cohorte: cohortStability(analyzed, HORIZONS, allowed as ("discovery" | "calibration" | "holdout")[]),
    features: analyzed.map((r) => r.features),
    outcomes: analyzed.map((r) => r.outcome),
  };

  console.log(JSON.stringify(report, null, 1));
}

main();
