/**
 * SPRINT 2D — Famille A (Avoidance / No-trade) : runner AVOIDANCE_ENGINE.
 *
 * Usage : npx tsx lab/research-sprint2/avoidance/run.ts
 * Sortie : research/results/res-s2d-avoidance.json (+ tableau console).
 *
 * AUCUNE stratégie construite : mesure de la valeur d'ÉVITEMENT uniquement.
 * - Baseline « tout prendre » vs « éviter les flagged ».
 * - Seuils intra-discovery, holdout JAMAIS lu, SKHY exclu, borne OPTIMISTE.
 * - Ne commite pas (décision du parent).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AVOID_RULE_VERSION,
  FILTERS,
  FROZEN_DATE,
  POINT_LABELS,
} from "./rule.ts";
import {
  discoveryThresholds,
  loadDiscoveryRows,
  measureAvoidance,
  type AvoidanceMetrics,
  type FilterScope,
  type Horizon,
} from "./metrics.ts";

const HISTORY_DIR = "data/history";
const OUT_JSON = "research/results/res-s2d-avoidance.json";

type Verdict = "RISK_ONLY" | "NULL" | "UNSTABLE" | "NEAR_MISS" | "NON_CONCLUSIF";

interface VerdictRow {
  scope: FilterScope;
  horizon: Horizon;
  hypothesis: string;
  n: number;
  effectLossAvoidedMed: number | null;
  pValue: number | null;
  ci: [number, number] | null;
  verdict: Verdict;
  note: string;
}

/**
 * Verdict mécanique pré-enregistré (même règle pour les 4 scopes) :
 * - n<30 → NON_CONCLUSIF
 * - signe de lossAvoidedMed instable sur les 3 points → UNSTABLE
 * - p>=0,05 (Mann-Whitney flagged vs kept) ou effet ≤0 → NULL
 * - significatif mais concentré (cohortes/temps en désaccord) → NEAR_MISS
 * - sinon → RISK_ONLY (filtre d'exclusion utile, PAS un edge long)
 */
function verdictFor(points: AvoidanceMetrics[], hypothesis: string): VerdictRow {
  const mid = points[1]!;
  const base: VerdictRow = {
    scope: mid.scope,
    horizon: mid.horizon,
    hypothesis,
    n: mid.nAll,
    effectLossAvoidedMed: mid.lossAvoidedMed,
    pValue: mid.mwP,
    ci: mid.ciLo !== null && mid.ciHi !== null ? [mid.ciLo, mid.ciHi] : null,
    verdict: "NULL",
    note: "",
  };
  if (points.some((p) => p.nAll < 30)) {
    base.verdict = "NON_CONCLUSIF";
    base.note = "n < 30 : jamais interprété.";
    return base;
  }
  const signs = points.map((p) =>
    p.lossAvoidedMed === null || p.lossAvoidedMed === 0 ? 0 : Math.sign(p.lossAvoidedMed),
  );
  if (new Set(signs).size > 1) {
    base.verdict = "UNSTABLE";
    base.note = `Signe de la perte médiane évitée instable sur les 3 points : ${points
      .map((p, i) => `${POINT_LABELS[i]}=${fmtPct(p.lossAvoidedMed)}`)
      .join(" / ")}.`;
    return base;
  }
  if (mid.mwP === null || mid.mwP >= 0.05 || (mid.lossAvoidedMed ?? 0) <= 0) {
    base.verdict = "NULL";
    base.note =
      mid.mwP === null
        ? "Test impossible (groupes trop petits)."
        : `Pas de séparation significative flagged vs kept (p=${mid.mwP.toFixed(4)}).`;
    return base;
  }
  const s = Math.sign(mid.lossAvoidedMed!);
  const cohorts = mid.cohortStability.filter((c) => c.n >= 10);
  const agreeCohorts = cohorts.filter(
    (c) => c.lossAvoidedMed !== null && Math.sign(c.lossAvoidedMed) === s,
  ).length;
  const timeAgree = mid.timeStability.every(
    (t) => t.lossAvoidedMed !== null && Math.sign(t.lossAvoidedMed) === s,
  );
  if (cohorts.length > 0 && (agreeCohorts < Math.ceil(cohorts.length / 2) || !timeAgree)) {
    base.verdict = "NEAR_MISS";
    const cond = mid.cohortStability
      .filter((c) => c.lossAvoidedMed !== null && Math.sign(c.lossAvoidedMed) === s)
      .map((c) => `${c.name} (n=${c.n})`)
      .join(", ");
    base.note = `Effet significatif mais concentré — condition : ${cond || "aucune cohorte concordante"}. Temps : ${mid.timeStability
      .map((t) => `${t.name}=${fmtPct(t.lossAvoidedMed)}`)
      .join(" / ")}.`;
    return base;
  }
  base.verdict = "RISK_ONLY";
  base.note = `Sépare les perdants (p=${mid.mwP!.toFixed(4)}), direction stable cohortes+temps. Filtre d'exclusion, PAS un edge long.`;
  return base;
}

function fmtPct(v: number | null, digits = 1): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(digits)} pts`;
}

const HYPOTHESES: Record<FilterScope, string> = {
  F_FRENZY:
    "H-PRED-FLOW-01 — frénésie (sellsM5) à t0 ⇒ Y@1h négatif : éviter les tokens en frénésie réduit les pertes.",
  F_TURNOVER:
    "H-PRED-LIQ-01 — turnoverM5 élevé à t0 ⇒ Y@6h négatif : éviter le churn extrême réduit les pertes.",
  F_LIQT0:
    "H-S1-E1 — liqT0 basse ⇒ mauvaise survie : éviter la liquidité faible réduit pertes et drawdown.",
  COMBINED:
    "Règle combinée AVOID-S2D-v1 (OU logique des 3 filtres) : valeur d'évitement globale.",
};

function main(): void {
  const rows = loadDiscoveryRows(HISTORY_DIR);
  console.log(`Lignes discovery chargées : ${rows.length} (holdout/calibration jamais lus, SKHY exclu)`);

  const thresholdsByPoint = [0, 1, 2].map((p) => discoveryThresholds(rows, p as 0 | 1 | 2));
  const scopes: FilterScope[] = ["F_FRENZY", "F_TURNOVER", "F_LIQT0", "COMBINED"];
  const horizons: Horizon[] = ["1h", "6h"];

  const allMetrics: AvoidanceMetrics[] = [];
  const verdicts: VerdictRow[] = [];
  for (const scope of scopes) {
    for (const horizon of horizons) {
      const pts = [0, 1, 2].map((pi) =>
        measureAvoidance(rows, scope, horizon, POINT_LABELS[pi as 0 | 1 | 2]!, thresholdsByPoint[pi]!),
      );
      allMetrics.push(...pts);
      verdicts.push(verdictFor(pts, HYPOTHESES[scope]!));
    }
  }

  // --- Tableau de triage console (point principal) ---
  console.log("\n=== TRIAGE AVOIDANCE — point principal (discovery, borne OPTIMISTE) ===");
  console.log(
    "scope      | hor | n    | %évité | perte méd évitée | P10 évitée | DD évité | gagnants filtrés | p (MW)",
  );
  for (const v of verdicts) {
    const m = allMetrics.find(
      (x) => x.scope === v.scope && x.horizon === v.horizon && x.point === "principal",
    )!;
    console.log(
      `${v.scope.padEnd(10)} | ${v.horizon.padEnd(3)} | ${String(v.n).padEnd(4)} | ` +
        `${fmtPct(m.pctAvoided).padEnd(6)} | ${fmtPct(m.lossAvoidedMed, 2).padEnd(14)} | ` +
        `${fmtPct(m.tailLossAvoided, 2).padEnd(10)} | ${fmtPct(m.ddAvoided, 2).padEnd(8)} | ` +
        `${m.fpWinners}/${m.nWinners} (${fmtPct(m.fpWinnersPct)})`.padEnd(16) +
        ` | ${v.pValue === null ? "n/a" : v.pValue.toFixed(4)} → ${v.verdict}`,
    );
  }

  const payload = {
    ruleVersion: AVOID_RULE_VERSION,
    frozenDate: FROZEN_DATE,
    protocol: {
      universe: "discovery uniquement (hash mint < 50) ; holdout JAMAIS lu ; calibration non utilisée",
      excluded: ["SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3 (glitch décimal)"],
      t0: "findT0 : premier snapshot liquidityUsd >= 20000 et priceUsd > 0",
      antiGlitch: "aberrantMask (>=100x ou <=1/100 des deux voisins) appliqué à Y et au drawdown",
      dataBias: "BORNE OPTIMISTE : data/history/ biaisée vers les tokens chauds",
      thresholds: "percentiles intra-discovery (interpolation linéaire type 7), 3 points de sensibilité",
      oos: "NON MESURÉ — holdout gelé ; re-test requis sur collecte propre 30 j (data/track-unbiased/)",
      noStrategy: "AUCUNE stratégie construite : valeur d'évitement uniquement, pas de P&L de trading",
      readOnly: "data/ en lecture seule ; data/earlybuyers/ non touché",
    },
    thresholdsByPoint: {
      bas: thresholdsByPoint[0],
      principal: thresholdsByPoint[1],
      haut: thresholdsByPoint[2],
    },
    nDiscoveryRows: rows.length,
    filters: FILTERS,
    metrics: allMetrics,
    verdicts,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(OUT_JSON), JSON.stringify(payload, null, 2) + "\n");
  console.log(`\nRésultats écrits : ${OUT_JSON}`);
}

main();
