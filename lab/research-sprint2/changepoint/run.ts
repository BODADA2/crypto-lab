/**
 * SPRINT 2B — Famille N (CHANGE POINT), runner.
 * Usage : npx tsx lab/research-sprint2/changepoint/run.ts
 * Écrit research/results/res-s2b-changepoint.json (AUCUN push, lecture seule sur data/).
 */
import { writeFileSync } from "node:fs";
import { listHistoryMints, readSeries } from "../../research-sprint1/common.ts";
import { splitUniverse } from "../../predictive/universe.ts";
import { SKHY_MINT, changePointRow, changePointStats } from "./changepoint.ts";

const WINDOWS = [2 * 3_600_000, 3 * 3_600_000];
const THRESHOLDS = [0.25, 0.35, 0.5];
const PRIMARY = { windowMs: 2 * 3_600_000, threshold: 0.35 };

function main(): void {
  const mints = listHistoryMints().filter(
    (m) => m !== SKHY_MINT && splitUniverse(m) === "discovery",
  );
  const allSeries = new Map<string, ReturnType<typeof readSeries>>();
  for (const mint of mints) {
    const s = readSeries(mint);
    if (s) allSeries.set(mint, s);
  }
  console.log(`discovery séries lues : ${allSeries.size}`);

  // Couverture minute-scale (question littérale « premières minutes »).
  const cov1h = { windowMs: 3_600_000, nTestable: 0 };
  for (const s of allSeries.values()) {
    if (changePointRow("x", s!, 3_600_000, 0.35) != null) cov1h.nTestable++;
  }
  console.log(`testables W=1h (m≥5) : ${cov1h.nTestable} / ${allSeries.size}`);

  // Grille primaire + robustesse.
  const grid = [];
  for (const windowMs of WINDOWS) {
    for (const threshold of THRESHOLDS) {
      const rows = [];
      for (const [mint, s] of allSeries) {
        const r = changePointRow(mint, s!, windowMs, threshold);
        if (r) rows.push(r);
      }
      const stats = changePointStats(rows, windowMs, threshold);
      // Stabilité cohortes / temps sur la config primaire.
      let cohort: unknown = null;
      let time: unknown = null;
      if (windowMs === PRIMARY.windowMs && threshold === PRIMARY.threshold) {
        const pump = rows.filter((r) => r.dexId === "pumpswap");
        const rest = rows.filter((r) => r.dexId !== "pumpswap");
        cohort = {
          pumpswap: pump.length >= 30 ? changePointStats(pump, windowMs, threshold) : { nTestable: pump.length, note: "n<30 non conclusif" },
          rest: rest.length >= 30 ? changePointStats(rest, windowMs, threshold) : { nTestable: rest.length, note: "n<30 non conclusif" },
        };
        const early = rows.filter((r) => r.t0day < "2026-09-26");
        const late = rows.filter((r) => r.t0day >= "2026-09-26");
        time = {
          before20260926: early.length >= 30 ? changePointStats(early, windowMs, threshold) : { nTestable: early.length, note: "n<30 non conclusif" },
          from20260926: late.length >= 30 ? changePointStats(late, windowMs, threshold) : { nTestable: late.length, note: "n<30 non conclusif" },
        };
      }
      grid.push({ stats, cohort, time });
    }
  }

  const out = {
    experiment: "S2B-N-CHANGEPOINT",
    hypothesis_id: "H-S2B-N1",
    universe: "discovery",
    generated_at: new Date().toISOString(),
    leakage_status: "PASS",
    leakage_detail:
      "Rupture déterminée à D = t0+W (fin de la fenêtre de détection). Tous les labels (Y@6h, ddMax24h, survie_50_24h) mesurés DEPUIS D : aucun chevauchement détection/label. Ticks aberrants masqués (aberrantMask). AUCUNE lecture du holdout.",
    data_bias:
      "data/history/ biaisée vers les tokens chauds : toute mesure = borne OPTIMISTE.",
    verdict: "PENDING_ANALYST_REVIEW",
    coverage_1h: cov1h,
    primary: PRIMARY,
    grid,
  };
  writeFileSync(
    "research/results/res-s2b-changepoint.json",
    JSON.stringify(out, null, 2),
  );
  console.log("écrit research/results/res-s2b-changepoint.json");
}

main();
