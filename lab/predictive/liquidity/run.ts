/**
 * CLI reproductible — DOMAINE liquidity.
 * Usage :
 *   npx tsx lab/predictive/liquidity/run.ts --phase discovery [--out FILE]
 *   npx tsx lab/predictive/liquidity/run.ts --phase calibration --lock LOCK.json [--out FILE]
 *   npx tsx lab/predictive/liquidity/run.ts --phase holdout --lock LOCK.json [--out FILE]
 * LOCK.json : { "variables": [...], "horizons": [...] } — verrouillé après discovery.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HORIZON_LABELS } from "../universe.ts";
import { analyzeAll } from "./analysis.ts";
import { loadAllFeatures, varNames } from "./features.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const phase = arg("--phase");
if (phase !== "discovery" && phase !== "calibration" && phase !== "holdout") {
  console.error("Usage: --phase discovery|calibration|holdout [--lock FILE] [--out FILE]");
  process.exit(1);
}

let variables = varNames();
let horizons = HORIZON_LABELS;
const lockFile = arg("--lock");
if (lockFile) {
  const lock = JSON.parse(readFileSync(lockFile, "utf8")) as {
    variables: string[];
    horizons: string[];
  };
  variables = lock.variables;
  horizons = lock.horizons;
}

const dataDir = join(process.cwd(), "data", "history");
const feats = loadAllFeatures(dataDir);
const universe = phase === "discovery" ? "discovery" : phase === "calibration" ? "calibration" : "holdout";
const results = analyzeAll(feats, universe, horizons, variables);

// Couverture Y par horizon et univers (métrique obligatoire).
const coverage: Record<string, Record<string, number>> = {};
for (const u of ["discovery", "calibration", "holdout"] as const) {
  coverage[u] = {};
  for (const h of HORIZON_LABELS) {
    coverage[u]![h] = feats.filter((f) => f.universe === u && f.y[h] != null).length;
  }
}

const report = {
  domain: "liquidity",
  phase,
  generatedAt: new Date().toISOString(),
  note: "data/history/ biaisée vers tokens chauds : borne OPTIMISTE.",
  nTokensWithT0: feats.length,
  nPreStats: {
    withPre: feats.filter((f) => f.nPre >= 2).length,
    withSlope: feats.filter((f) => f.liqSlopePre != null).length,
  },
  coverage,
  results,
};

const out = arg("--out") ?? `liquidity-${phase}.json`;
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`OK ${phase}: ${feats.length} tokens avec t0, ${results.length} résultats -> ${out}`);
