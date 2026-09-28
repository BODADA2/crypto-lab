/**
 * SPRINT 2C — run : familles E (Actors/Entity) + F (Creator History).
 *
 * Usage : npx tsx lab/research-sprint2/actors/run.ts
 * Écrit : research/results/res-s2c-actors.json, res-s2c-creator.json
 * Lecture seule sur les données (aucune écriture dans data/).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadMintSets,
  buildIncidence,
  t0ByMint,
  recurrentWalletsAsOf,
  recurrentWalletsOverall,
} from "./incidence.ts";
import {
  mintQualityFeatures,
  loadSurvival,
} from "./quality.ts";
import { buildSharedPairs, outcomeCorrelation } from "./correlation.ts";
import { auditCreator } from "./creator.ts";
import { permutationP, median, mean } from "./statsx.ts";
import { spearman } from "../../predictive/universe.ts";

const RESULTS_DIR = "research/results";

function main(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  // ---------- E : incidence ----------
  const sets = loadMintSets();
  const inc = buildIncidence(sets);
  const t0 = t0ByMint(sets);
  const recurrentByMint = new Map<string, Set<string>>();
  for (const s of sets) {
    recurrentByMint.set(s.mint, recurrentWalletsAsOf(inc, t0, s.mint, s.t0ms, 1));
  }
  const overallRecurrent = recurrentWalletsOverall(inc);
  const buyerMints = new Map<string, string[]>();
  for (const [w, obs] of inc) buyerMints.set(w, [...new Set(obs.map((o) => o.mint))]);

  // ---------- E1 : outcomes corrélés ? ----------
  const mints = sets.map((s) => s.mint);
  const { survivalOf, y1hOf } = loadSurvival(mints);
  const pairs = buildSharedPairs(sets, buyerMints, t0, recurrentByMint);
  const corr = outcomeCorrelation(pairs, y1hOf, survivalOf, buyerMints);

  // ---------- E2 : qualité historique → outcome ? ----------
  const feats = mintQualityFeatures(sets, inc, t0, survivalOf, recurrentByMint);
  const qRows = feats.filter(
    (f) => f.meanWalletQuality != null && y1hOf.get(f.mint) != null,
  );
  const qx = qRows.map((f) => f.meanWalletQuality!);
  const qy = qRows.map((f) => y1hOf.get(f.mint)!);
  const sp = spearman(qx, qy);
  const permQ = permutationP(qx, qy, spearman, { side: "ge", seed: 21 });

  const eRows = feats.filter(
    (f) => f.meanEntityQuality != null && y1hOf.get(f.mint) != null,
  );
  const spEnt = spearman(
    eRows.map((f) => f.meanEntityQuality!),
    eRows.map((f) => y1hOf.get(f.mint)!),
  );

  // Stabilité temporelle : split médian t0 → corrélation par cohorte.
  const sortedT0 = [...feats].sort((a, b) => a.t0ms - b.t0ms);
  const mid = Math.floor(sortedT0.length / 2);
  const cohorts = [
    { name: "early", rows: sortedT0.slice(0, mid) },
    { name: "late", rows: sortedT0.slice(mid) },
  ].map((c) => {
    const r = c.rows.filter((f) => f.meanWalletQuality != null && y1hOf.get(f.mint) != null);
    return {
      name: c.name,
      n: r.length,
      spearman: spearman(
        r.map((f) => f.meanWalletQuality!),
        r.map((f) => y1hOf.get(f.mint)!),
      ),
    };
  });

  // Déciles de qualité wallet → y1h médian.
  const ranked = [...qRows].sort((a, b) => a.meanWalletQuality! - b.meanWalletQuality!);
  const deciles: Array<{ decile: number; n: number; medianY1h: number | null }> = [];
  for (let d = 0; d < 10; d++) {
    const chunk = ranked.slice(Math.floor((d / 10) * ranked.length), Math.floor(((d + 1) / 10) * ranked.length));
    deciles.push({ decile: d, n: chunk.length, medianY1h: median(chunk.map((f) => y1hOf.get(f.mint)!)) });
  }

  const actors = {
    generated_at: new Date().toISOString(),
    universe: "discovery",
    excluded: ["SKHY (dataError)"],
    note: "tokens chauds uniquement — borne optimiste",
    n_mint_sets: sets.length,
    n_distinct_wallets: inc.size,
    n_recurrent_wallets_overall: overallRecurrent.length,
    mints_with_any_recurrent_as_of_t0: [...recurrentByMint.values()].filter((s) => s.size > 0).length,
    mean_recurrent_frac: mean(feats.map((f) => f.recurrentFrac)),
    // E1
    e1_shared_outcome_corr: corr,
    // E2
    e2_wallet_quality: {
      n_mints_with_quality_and_y1h: qRows.length,
      n_mints_without_any_past_label: feats.length - feats.filter((f) => f.nWithQuality > 0).length,
      spearman_quality_y1h: sp,
      permutation_p_ge: permQ.p,
      median_meanWalletQuality: median(qx),
      deciles,
      cohort_stability: cohorts,
      entity_level: {
        n: eRows.length,
        spearman_entityQuality_y1h: spEnt,
      },
    },
    leakage: {
      status: "PASS",
      detail:
        "Sets pré-t0 stricts (blockTime*1000<=t0ms). Récurrence as-of-t0 : seuls mints avec t0'<t0. Qualité wallet calculée uniquement sur mints passés labellisés (survival_50_24h). Clustering avec buildPairOverlap(t0ms, excludeMint). Aucune donnée post-t0, aucun label futur dans les features. Discovery uniquement.",
    },
  };
  writeFileSync(join(RESULTS_DIR, "res-s2c-actors.json"), JSON.stringify(actors, null, 2));

  // ---------- F : audit creator ----------
  const audit = auditCreator();
  const creator = {
    generated_at: new Date().toISOString(),
    ...audit,
    missing: {
      creator_field_absent_pct:
        audit.nTokenRecords > 0 ? 100 * (1 - audit.nWithCreator / audit.nTokenRecords) : null,
    },
    verdict: "DATA ISSUE",
    detail:
      "Aucun champ creator/deployer exploitable dans data/scans ; mintAuthority=UNKNOWN dans data/history. CREATOR_HISTORY_AS_OF_T0 non reconstructible sans inventer de données. Interaction CREATOR × EARLY_FLOW bloquée.",
  };
  writeFileSync(join(RESULTS_DIR, "res-s2c-creator.json"), JSON.stringify(creator, null, 2));

  console.log(JSON.stringify({ actors_summary: { n_mint_sets: sets.length, e1: { nPairs: corr.nPairs, permP_Y1h: corr.permP_Y1h, permP_surv: corr.permP_surv }, e2: { n: qRows.length, spearman: sp, p: permQ.p } }, creator_summary: { nTokenRecords: audit.nTokenRecords, nWithCreator: audit.nWithCreator } }, null, 2));
}

main();
