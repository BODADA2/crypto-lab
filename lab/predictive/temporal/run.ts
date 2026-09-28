/**
 * DOMAINE 5/5 — TEMPORAL STRUCTURE : pilote de la phase DÉCOUVERTE.
 *
 * Protocole (gelé dans docs/hypothesis-pred-temporal-2026-09-28.md AVANT exécution) :
 *   1. discovery  → analyse complète, critères de passage fixés d'avance ;
 *   2. calibration → re-mesure des seuls candidats ;
 *   3. holdout    → UNE SEULE mesure des survivants (jamais de re-calibrage).
 *
 * Sorties : tableau résumé stdout + lab/predictive/temporal/results-2026-09-28.json
 * (reproductible). Aucune stratégie construite — relation prédictive uniquement.
 *
 * Biais : data/history/ biaisée vers les tokens chauds → toute mesure = borne
 * OPTIMISTE (déclaré partout).
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { TokenSnapshot } from "../../types.ts";
import {
  HORIZON_LABELS,
  HORIZONS_MS,
  futureReturns,
  splitUniverse,
} from "../universe.ts";
import { hourCyclic, temporalFeatures } from "./features.ts";
import { analyzeVariable, coverage, type Row, type VarAnalysis } from "./analyze.ts";

const H_LABELS = HORIZON_LABELS; // ["1h","6h","24h"]

const VARIABLES: { key: string; family: "NIVEAU" | "FORME"; desc: string }[] = [
  { key: "priceAtT0", family: "NIVEAU", desc: "prix à t0" },
  { key: "liqAtT0", family: "NIVEAU", desc: "liquidité à t0" },
  { key: "growthPreT0PerH", family: "NIVEAU", desc: "croissance pré-t0 (pente log-prix/h)" },
  { key: "agePairMs", family: "FORME", desc: "âge paire à t0 (jeunesse)" },
  { key: "ageTokenMs", family: "FORME", desc: "âge token à t0" },
  { key: "accelPerH2", family: "FORME", desc: "accélération (pente2 − pente1)" },
  { key: "accelSign", family: "FORME", desc: "signe de l'accélération" },
  { key: "interSnapMeanMs", family: "FORME", desc: "durée moyenne inter-snapshots pré-t0" },
  { key: "hourSin", family: "FORME", desc: "heure t0 UTC (sin cyclique)" },
  { key: "hourCos", family: "FORME", desc: "heure t0 UTC (cos cyclique)" },
];

function loadRows(): Row[] {
  const dir = "data/history";
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const rows: Row[] = [];
  let noT0 = 0;
  for (const f of files) {
    const mint = f.replace(/\.jsonl$/, "");
    const lines = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    const series = lines.map((l) => JSON.parse(l) as TokenSnapshot);
    const feat = temporalFeatures(series);
    if (!feat) {
      noT0++;
      continue;
    }
    const fr = futureReturns(series, HORIZONS_MS);
    const y: Record<string, number | null> = { "1h": null, "6h": null, "24h": null };
    for (const r of fr) {
      const label = H_LABELS[HORIZONS_MS.indexOf(r.horizonMs)]!;
      y[label] = r.ret;
    }
    const hc = hourCyclic(feat.hourUTC);
    rows.push({
      mint,
      t0Time: feat.t0Time,
      x: {
        priceAtT0: feat.priceAtT0,
        liqAtT0: feat.liqAtT0,
        growthPreT0PerH: feat.growthPreT0PerH,
        agePairMs: feat.agePairMs,
        ageTokenMs: feat.ageTokenMs,
        accelPerH2: feat.accelPerH2,
        accelSign: feat.accelSign,
        interSnapMeanMs: feat.interSnapMeanMs,
        hourSin: hc.sin,
        hourCos: hc.cos,
      },
      y,
    });
  }
  console.error(`mints lus: ${files.length}, avec t0 exploitable: ${rows.length}, sans t0: ${noT0}`);
  return rows;
}

const byUniverse = (rows: Row[]) => ({
  discovery: rows.filter((r) => splitUniverse(r.mint) === "discovery"),
  calibration: rows.filter((r) => splitUniverse(r.mint) === "calibration"),
  holdout: rows.filter((r) => splitUniverse(r.mint) === "holdout"),
});

function fmt(v: number | null, d = 3): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toFixed(d);
}
function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(1) + "%";
}

function printTable(title: string, analyses: VarAnalysis[]): void {
  console.log(`\n### ${title}`);
  console.log(
    "| variable | hor | n | ρ | IC95 ρ | ρ ss-out | méd Y | moy Y | IC95 moy | P(perte) | P(≤−50%) | déc top méd | déc bot méd | Δmoy top−bot [IC] | stab T | stab C |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of analyses) {
    const sgn = (v: number | null) => (v === null ? "·" : v > 0 ? "+" : v < 0 ? "−" : "0");
    const stabT = `${sgn(a.stabTimeA)}/${sgn(a.stabTimeB)}`;
    const stabC = `${sgn(a.stabCohA)}/${sgn(a.stabCohB)}`;
    console.log(
      `| ${a.variable} | ${a.horizon} | ${a.n} | ${fmt(a.spearman)} | ` +
        `[${fmt(a.spearmanCI?.[0] ?? null)}, ${fmt(a.spearmanCI?.[1] ?? null)}] | ${fmt(a.spearmanNoOut)} | ` +
        `${fmtPct(a.median)} | ${fmtPct(a.mean)} | [${fmtPct(a.meanCI?.[0] ?? null)}, ${fmtPct(a.meanCI?.[1] ?? null)}] | ` +
        `${fmtPct(a.pLoss)} | ${fmtPct(a.pExtremeLoss)} | ${fmtPct(a.deciles?.topMedian ?? null)} | ${fmtPct(a.deciles?.botMedian ?? null)} | ` +
        `${fmt(a.deciles?.diffMean ?? null)} [${fmt(a.deciles?.diffMeanCI?.[0] ?? null)}, ${fmt(a.deciles?.diffMeanCI?.[1] ?? null)}] | ` +
        `${stabT} | ${stabC} |`,
    );
  }
}

/** Critères de passage discovery→calibration (gelés avant exécution). */
function passesDiscovery(a: VarAnalysis): boolean {
  if (a.n < 30 || a.spearman === null) return false;
  if (Math.abs(a.spearman) < 0.1) return false;
  if (!a.spearmanCI || a.spearmanCI[0] * a.spearmanCI[1] <= 0) return false; // IC exclut 0
  const s = Math.sign(a.spearman);
  for (const v of [a.stabTimeA, a.stabTimeB, a.stabCohA, a.stabCohB]) {
    if (v === null || Math.sign(v) !== s) return false;
  }
  if (a.deciles && a.deciles.topMedian !== null && a.deciles.botMedian !== null) {
    if (Math.sign(a.deciles.topMedian - a.deciles.botMedian) !== s) return false;
  }
  return true;
}

/** Critères de passage calibration→holdout. */
function passesCalibration(a: VarAnalysis, discSign: number): boolean {
  if (a.n < 30 || a.spearman === null) return false;
  if (Math.sign(a.spearman) !== discSign) return false;
  return Math.abs(a.spearman) >= 0.07;
}

function main(): void {
  const rows = loadRows();
  const U = byUniverse(rows);
  console.error(
    `univers — discovery: ${U.discovery.length}, calibration: ${U.calibration.length}, holdout: ${U.holdout.length}`,
  );
  for (const [name, set] of Object.entries(U)) {
    const cov = coverage(set, H_LABELS);
    console.error(
      `couverture Y ${name}: ` +
        H_LABELS.map((h) => `${h}: ${cov[h]!.n} (${cov[h]!.pct.toFixed(1)}%)`).join(", "),
    );
  }

  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    note: "data/history biaisee vers tokens chauds — borne OPTIMISTE",
    nRows: rows.length,
    coverage: Object.fromEntries(
      Object.entries(U).map(([k, v]) => [k, coverage(v, H_LABELS)]),
    ),
    variables: VARIABLES,
  };

  // ---- Phase 1 : DISCOVERY ----
  const discAnalyses: VarAnalysis[] = [];
  for (const v of VARIABLES) {
    for (const h of H_LABELS) discAnalyses.push(analyzeVariable(U.discovery, v.key, h));
  }
  printTable("DISCOVERY (n≈50 % des mints)", discAnalyses);
  const candidates = discAnalyses.filter(passesDiscovery);
  console.log(
    `\nCandidats discovery→calibration (${candidates.length}) : ` +
      (candidates.map((c) => `${c.variable}@${c.horizon}`).join(", ") || "aucun"),
  );
  results.discovery = discAnalyses;
  results.candidates = candidates.map((c) => ({
    variable: c.variable,
    horizon: c.horizon,
    sign: Math.sign(c.spearman as number),
  }));

  // ---- Phase 2 : CALIBRATION (candidats uniquement) ----
  const calAnalyses: VarAnalysis[] = [];
  const survivors: { variable: string; horizon: string; sign: number }[] = [];
  for (const c of candidates) {
    const a = analyzeVariable(U.calibration, c.variable, c.horizon);
    calAnalyses.push(a);
    const discSign = Math.sign(c.spearman as number); // c.spearman existe ; c.sign n'existe pas
    if (Number.isFinite(discSign) && discSign !== 0 && passesCalibration(a, discSign)) {
      survivors.push({ variable: c.variable, horizon: c.horizon, sign: discSign });
    }
  }
  if (calAnalyses.length > 0) printTable("CALIBRATION (candidats uniquement)", calAnalyses);
  console.log(
    `\nSurvivants calibration→holdout (${survivors.length}) : ` +
      (survivors.map((s) => `${s.variable}@${s.horizon}`).join(", ") || "aucun"),
  );
  results.calibration = calAnalyses;

  // ---- Phase 3 : HOLDOUT — UNE SEULE mesure par survivant ----
  const holdAnalyses: VarAnalysis[] = [];
  for (const s of survivors) {
    holdAnalyses.push(analyzeVariable(U.holdout, s.variable, s.horizon));
  }
  if (holdAnalyses.length > 0) printTable("HOLDOUT — mesure unique", holdAnalyses);
  else console.log("\nHOLDOUT : aucune mesure (aucun survivant) — holdout intact.");
  results.holdout = holdAnalyses;

  mkdirSync("lab/predictive/temporal", { recursive: true });
  writeFileSync(
    "lab/predictive/temporal/results-2026-09-28.json",
    JSON.stringify(results, null, 2),
  );
  console.error("résultats écrits : lab/predictive/temporal/results-2026-09-28.json");
}

main();
