/**
 * SPRINT 2B — Famille L (WAIT), runner.
 * Usage : npx tsx lab/research-sprint2/wait/run.ts
 * Écrit research/results/res-s2b-wait.json (AUCUN push, lecture seule sur data/).
 */
import { writeFileSync } from "node:fs";
import { listHistoryMints, readSeries } from "../../research-sprint1/common.ts";
import { splitUniverse } from "../../predictive/universe.ts";
import {
  SKHY_MINT,
  cleanSeries,
  waitFeatures,
  waitRow,
  waitDeltaStats,
  spearmanPermP,
} from "./wait.ts";

/** Δ en secondes (littéral) + Δ en minutes (cadence supportée). */
const DELTAS_S = [30_000, 60_000, 120_000];
const DELTAS_MIN = [15 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000];

interface CoverageOnly { deltaMs: number; nTokens: number; nWithTick: number }

function main(): void {
  const mints = listHistoryMints().filter(
    (m) => m !== SKHY_MINT && splitUniverse(m) === "discovery",
  );
  const seriesByMint = new Map<string, Exclude<ReturnType<typeof cleanSeries>, null>>();
  for (const mint of mints) {
    const s = readSeries(mint);
    if (!s) continue;
    const cs = cleanSeries(s);
    if (cs) seriesByMint.set(mint, cs);
  }
  console.log(`discovery tokens avec t0 : ${seriesByMint.size}`);

  // 1) Couverture des Δ en secondes (question littérale de l'hypothèse).
  const coverage: CoverageOnly[] = DELTAS_S.map((d) => {
    let n = 0;
    for (const cs of seriesByMint.values()) {
      const wf = waitFeatures("x", cs, d);
      if (wf.nTicksWindow > 0) n++;
    }
    return { deltaMs: d, nTokens: seriesByMint.size, nWithTick: n };
  });
  console.log("couverture Δ secondes :", JSON.stringify(coverage));

  // 2) Analyse complète sur les Δ en minutes.
  const deltas = DELTAS_MIN.map((deltaMs) => {
    const rows = [];
    let nWindow = 0;
    for (const [mint, cs] of seriesByMint) {
      const wf = waitFeatures(mint, cs, deltaMs);
      if (wf.nTicksWindow > 0) nWindow++;
      const row = waitRow(mint, cs.s, deltaMs);
      if (row) rows.push(row);
    }
    const stats = waitDeltaStats(rows, deltaMs);
    // p-value de permutation du Spearman dirPrice→Y@1h (adversarial).
    const y1 = rows.filter((r) => r.y1hEntry != null);
    const pPermSpear = y1.length >= 30
      ? spearmanPermP(y1.map((r) => r.dirPrice), y1.map((r) => r.y1hEntry!))
      : null;
    // Stabilité cohortes : pumpswap vs reste (n≥30 exigé).
    const pump = rows.filter((r) => r.dexId === "pumpswap");
    const rest = rows.filter((r) => r.dexId !== "pumpswap");
    const cohort = {
      pumpswap: pump.length >= 30 ? waitDeltaStats(pump, deltaMs) : { nRows: pump.length, note: "n<30 non conclusif" },
      rest: rest.length >= 30 ? waitDeltaStats(rest, deltaMs) : { nRows: rest.length, note: "n<30 non conclusif" },
    };
    // Stabilité temporelle : moitiés au 2026-09-26.
    const early = rows.filter((r) => r.t0day < "2026-09-26");
    const late = rows.filter((r) => r.t0day >= "2026-09-26");
    const time = {
      before20260926: early.length >= 30 ? waitDeltaStats(early, deltaMs) : { nRows: early.length, note: "n<30 non conclusif" },
      from20260926: late.length >= 30 ? waitDeltaStats(late, deltaMs) : { nRows: late.length, note: "n<30 non conclusif" },
    };
    return { stats: { ...stats, nWindow }, pPermSpearmanDirY1: pPermSpear, cohort, time };
  });

  const out = {
    experiment: "S2B-L-WAIT",
    hypothesis_id: "H-S2B-L1",
    universe: "discovery",
    generated_at: new Date().toISOString(),
    leakage_status: "PASS",
    leakage_detail:
      "Features (dirPrice, dLiq) calculées sur ticks de timestamp ≤ t0+Δ uniquement. Labels (Y@1h/Y@6h/survie/ddMax) mesurés depuis l'entrée (premier tick ≥ t0+Δ) : aucun chevauchement feature/label. Prix d'entrée observé possiblement après t0+Δ (données clairsemées) — utilisé uniquement pour le coût réalisé, documenté. AUCUNE lecture du holdout.",
    data_bias:
      "data/history/ biaisée vers les tokens chauds : toute mesure = borne OPTIMISTE.",
    verdict: "PENDING_ANALYST_REVIEW",
    coverage_seconds: coverage,
    deltas,
  };
  writeFileSync(
    "research/results/res-s2b-wait.json",
    JSON.stringify(out, null, 2),
  );
  console.log("écrit research/results/res-s2b-wait.json");
}

main();
