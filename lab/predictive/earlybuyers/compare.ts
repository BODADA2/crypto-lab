/**
 * Phase 2 — comparaison ALL vs EXCLUS vs RETENUS.
 *
 * `rule` = fonction d'exclusion DÉFINIE SUR DISCOVERY (ex. top tercile d'une
 * feature, seuil = quantile discovery). AUCUN paramètre n'est touché au
 * holdout — et ce module ne voit jamais le holdout de toute façon.
 *
 * Honnêteté : sur discovery, la comparaison est DESCRIPTIVE (la règle vient
 * des mêmes données — biais d'optimisme). Le vrai test sera le holdout gelé,
 * UNE FOIS la règle verrouillée. Sur calibration, la règle reste celle
 * définie sur discovery (gelée), appliquée à discovery+calibration.
 */
import { bootstrapCI, median } from "../universe.ts";

export interface ExclusionRule {
  /** Feature sur laquelle porte la règle. */
  feature: string;
  /** Seuil (quantile calculé sur discovery, gelé). */
  threshold: number;
  /** "exclude_high" = on exclut les valeurs >= seuil. */
  direction: "exclude_high" | "exclude_low";
  /** Description de l'origine de la règle (ex. "top tercile giniAmt sur discovery"). */
  origin: string;
}

export interface CompareRow {
  mint: string;
  t0ms: number;
  /** Valeur de la feature de la règle (null = ligne ignorée). */
  ruleValue: number | null;
  y1h: number | null;
  y6h: number | null;
  y24h: number | null;
  survival_50_24h: boolean | null;
}

export interface GroupSummary {
  name: "ALL" | "EXCLUS" | "RETENUS";
  n: number;
  /** Résumé sur y6h (rendement primaire). */
  mean: number | null;
  median: number | null;
  ci95: [number, number] | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  freqLeMinus30: number | null;
  freqLeMinus50: number | null;
  freqLeMinus80: number | null;
  survivalRate50: number | null;
  /** Stabilité temporelle : médiane y6h sur chaque moitié de t0. */
  medianFirstHalfT0: number | null;
  medianSecondHalfT0: number | null;
}

export interface CompareResult {
  rule: ExclusionRule;
  returnKey: string;
  groups: GroupSummary[];
  /** true si la règle a été définie sur les mêmes données qu'elle évalue. */
  descriptiveOnly: boolean;
  note: string;
}

function quantile(a: number[], q: number): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function summarizeGroup(name: GroupSummary["name"], rows: CompareRow[]): GroupSummary {
  const ys = rows.map((r) => r.y6h).filter((v): v is number => v != null);
  const n = ys.length;
  const surv = rows.map((r) => r.survival_50_24h).filter((v): v is boolean => v != null);
  let medianFirst: number | null = null;
  let medianSecond: number | null = null;
  if (rows.length >= 4) {
    const byT0 = [...rows].sort((a, b) => a.t0ms - b.t0ms);
    const half = Math.floor(byT0.length / 2);
    medianFirst = median(byT0.slice(0, half).map((r) => r.y6h).filter((v): v is number => v != null));
    medianSecond = median(byT0.slice(half).map((r) => r.y6h).filter((v): v is number => v != null));
  }
  return {
    name,
    n,
    mean: n ? ys.reduce((a, b) => a + b, 0) / n : null,
    median: median(ys),
    ci95: bootstrapCI(ys),
    p10: quantile(ys, 0.1),
    p25: quantile(ys, 0.25),
    p75: quantile(ys, 0.75),
    p90: quantile(ys, 0.9),
    freqLeMinus30: n ? ys.filter((y) => y <= -0.3).length / n : null,
    freqLeMinus50: n ? ys.filter((y) => y <= -0.5).length / n : null,
    freqLeMinus80: n ? ys.filter((y) => y <= -0.8).length / n : null,
    survivalRate50: surv.length ? surv.filter(Boolean).length / surv.length : null,
    medianFirstHalfT0: medianFirst,
    medianSecondHalfT0: medianSecond,
  };
}

/** Applique la règle : true = EXCLU. */
export function applyRule(row: CompareRow, rule: ExclusionRule): boolean | null {
  if (row.ruleValue == null) return null;
  return rule.direction === "exclude_high"
    ? row.ruleValue >= rule.threshold
    : row.ruleValue <= rule.threshold;
}

export function compareAllExcludedRetained(
  rows: CompareRow[],
  rule: ExclusionRule,
  opts: { returnKey?: string; descriptiveOnly?: boolean } = {},
): CompareResult {
  const usable = rows.filter((r) => applyRule(r, rule) != null && r.y6h != null);
  const exclus = usable.filter((r) => applyRule(r, rule) === true);
  const retained = usable.filter((r) => applyRule(r, rule) === false);
  const descriptiveOnly = opts.descriptiveOnly ?? true;
  return {
    rule,
    returnKey: opts.returnKey ?? "y6h",
    groups: [
      summarizeGroup("ALL", usable),
      summarizeGroup("EXCLUS", exclus),
      summarizeGroup("RETENUS", retained),
    ],
    descriptiveOnly,
    note: descriptiveOnly
      ? "Comparaison DESCRIPTIVE : la règle a été définie sur ces mêmes données (biais d'optimisme). Le vrai test = holdout gelé."
      : "Règle gelée sur discovery, appliquée à discovery+calibration (pas de re-calibrage).",
  };
}
