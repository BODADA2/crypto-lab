/** Tests AVOIDANCE_ENGINE — règle pré-enregistrée (données synthétiques). */
import { describe, expect, it } from "vitest";
import {
  AVOID_RULE_VERSION,
  combinedAvoid,
  evaluateFilters,
  FILTERS,
  percentile,
  thresholdsForPoint,
  type FilterVariable,
} from "./rule.ts";

describe("pré-enregistrement", () => {
  it("version gelée et 3 filtres", () => {
    expect(AVOID_RULE_VERSION).toBe("AVOID-S2D-v1");
    expect(FILTERS.map((f) => f.id)).toEqual(["F_FRENZY", "F_TURNOVER", "F_LIQT0"]);
  });

  it("points de sensibilité : 3 points par filtre, sans optimisation fine", () => {
    for (const f of FILTERS) expect(f.points).toHaveLength(3);
    expect(FILTERS[0]!.points).toEqual([70, 75, 80]);
    expect(FILTERS[1]!.points).toEqual([85, 90, 95]);
    expect(FILTERS[2]!.points).toEqual([30, 25, 20]);
  });
});

describe("percentile", () => {
  it("médiane d'une série paire (interpolation)", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 10);
  });
  it("bornes", () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 100)).toBe(9);
  });
  it("vide => null ; hors bornes => erreur", () => {
    expect(percentile([], 75)).toBeNull();
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
  it("P75 de 1..100 = 75.25 (type 7)", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 75)).toBeCloseTo(75.25, 10);
  });
});

describe("evaluateFilters", () => {
  const thresholds = { F_FRENZY: 100, F_TURNOVER: 2.0, F_LIQT0: 50000 };
  const feats = (o: Partial<Record<FilterVariable, number | null>>) => ({
    sellsM5: null,
    turnoverM5: null,
    liqT0: null,
    ...o,
  });

  it("F_FRENZY : évite si sellsM5 >= seuil", () => {
    expect(evaluateFilters(feats({ sellsM5: 150 }), thresholds).F_FRENZY).toBe(true);
    expect(evaluateFilters(feats({ sellsM5: 99 }), thresholds).F_FRENZY).toBe(false);
  });

  it("F_TURNOVER : évite si turnoverM5 >= seuil", () => {
    expect(evaluateFilters(feats({ turnoverM5: 3 }), thresholds).F_TURNOVER).toBe(true);
    expect(evaluateFilters(feats({ turnoverM5: 1.9 }), thresholds).F_TURNOVER).toBe(false);
  });

  it("F_LIQT0 : évite si liqT0 < seuil (côté bas)", () => {
    expect(evaluateFilters(feats({ liqT0: 40000 }), thresholds).F_LIQT0).toBe(true);
    expect(evaluateFilters(feats({ liqT0: 60000 }), thresholds).F_LIQT0).toBe(false);
  });

  it("variable manquante => jamais flaggé (pas d'imputation)", () => {
    const flags = evaluateFilters(feats({}), thresholds);
    expect(flags).toEqual({ F_FRENZY: false, F_TURNOVER: false, F_LIQT0: false });
  });

  it("combinedAvoid = OU logique", () => {
    expect(combinedAvoid({ F_FRENZY: false, F_TURNOVER: false, F_LIQT0: false })).toBe(false);
    expect(combinedAvoid({ F_FRENZY: true, F_TURNOVER: false, F_LIQT0: false })).toBe(true);
    expect(combinedAvoid({ F_FRENZY: true, F_TURNOVER: true, F_LIQT0: true })).toBe(true);
  });
});

describe("thresholdsForPoint", () => {
  it("calcule les 3 seuils intra-discovery", () => {
    const vals: Record<FilterVariable, number[]> = {
      sellsM5: Array.from({ length: 100 }, (_, i) => i + 1),
      turnoverM5: Array.from({ length: 100 }, (_, i) => (i + 1) / 10),
      liqT0: Array.from({ length: 100 }, (_, i) => (i + 1) * 1000),
    };
    const t = thresholdsForPoint(vals, 1);
    expect(t.F_FRENZY).toBeCloseTo(75.25, 8);
    expect(t.F_TURNOVER).toBeCloseTo(9.01, 8);
    expect(t.F_LIQT0).toBeCloseTo(25750, 8);
  });

  it("erreur si aucune valeur", () => {
    const vals: Record<FilterVariable, number[]> = { sellsM5: [], turnoverM5: [1], liqT0: [1] };
    expect(() => thresholdsForPoint(vals, 1)).toThrow();
  });
});
