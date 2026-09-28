import { describe, it, expect } from "vitest";
import {
  classifyExitRegime,
  simulateExit,
  SCALP_PARAMS,
  RUNNER_PARAMS,
  RUNNER_CATALYST_THRESHOLD,
  type PricePoint,
} from "../lab/signals/exit.ts";

const COSTS = { sizeUsd: 50, feesRoundTrip: 0.013, maxSlippage: 0.03 };

function path(prices: number[], liq = 100_000): PricePoint[] {
  return prices.map((price, i) => ({
    t: `2026-09-26T00:${String(i).padStart(2, "0")}:00.000Z`,
    price,
    liquidityUsd: liq,
  }));
}

describe("classifyExitRegime", () => {
  it(`runner ssi catalyst ≥ ${RUNNER_CATALYST_THRESHOLD}`, () => {
    expect(classifyExitRegime(80)).toBe("runner");
    expect(classifyExitRegime(40)).toBe("runner");
    expect(classifyExitRegime(39)).toBe("scalp");
    expect(classifyExitRegime(0)).toBe("scalp");
  });
  it("score manquant/invalide → scalp (conservateur)", () => {
    expect(classifyExitRegime(null)).toBe("scalp");
    expect(classifyExitRegime(undefined)).toBe("scalp");
    expect(classifyExitRegime(NaN)).toBe("scalp");
  });
});

describe("simulateExit — scalp", () => {
  it("take-profit à +30 % en une sortie unique", () => {
    const p = path([1, 1.05, 1.35, 1.5]);
    const plan = simulateExit(p, 0, "scalp", COSTS);
    expect(plan.regime).toBe("scalp");
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0]?.exit).toBe("take-profit");
    expect(plan.fills[0]?.fraction).toBe(1);
    expect(plan.fills[0]?.exitPrice).toBe(1.35);
    expect(plan.fills[0]?.bars).toBe(2);
  });
  it("stop-loss à −20 % prioritaire sur le time-stop", () => {
    const p = path([1, 0.95, 0.79, 0.9]);
    const plan = simulateExit(p, 0, "scalp", COSTS);
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0]?.exit).toBe("stop-loss");
    expect(plan.fills[0]?.exitPrice).toBe(0.79);
  });
  it("time-stop après 6 observations sans TP ni SL", () => {
    const p = path([1, 1.01, 1.02, 1.01, 1.03, 1.02, 1.04, 1.05]);
    const plan = simulateExit(p, 0, "scalp", COSTS);
    expect(plan.fills[0]?.exit).toBe("time-stop");
    expect(plan.fills[0]?.bars).toBe(SCALP_PARAMS.timeStopBars);
  });
  it("fin de données si la série est trop courte", () => {
    const p = path([1, 1.05]);
    const plan = simulateExit(p, 0, "scalp", COSTS);
    expect(plan.fills[0]?.exit).toBe("end-of-data");
  });
  it("le rendement net déduit frais et slippage", () => {
    const p = path([1, 1.3]);
    const plan = simulateExit(p, 0, "scalp", COSTS);
    // brut +30 %, net < brut à cause des coûts.
    expect(plan.blendedRet).toBeLessThan(0.3);
    expect(plan.blendedRet).toBeGreaterThan(0.2);
  });
});

describe("simulateExit — runner (paliers)", () => {
  it("prend les 3 paliers + solde au time-stop", () => {
    // +50 % à i=1, +150 % à i=2, +300 % à i=3, puis plat jusqu'au time-stop (48).
    const prices = [1, 1.5, 2.5, 4.0, ...Array(50).fill(4.0)];
    const p = path(prices);
    const plan = simulateExit(p, 0, "runner", COSTS);
    expect(plan.regime).toBe("runner");
    expect(plan.fills).toHaveLength(4);
    expect(plan.fills.map((f) => f.fraction).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(plan.fills[0]).toMatchObject({ exit: "take-profit", exitPrice: 1.5, fraction: 0.25 });
    expect(plan.fills[1]).toMatchObject({ exit: "take-profit", exitPrice: 2.5, fraction: 0.25 });
    expect(plan.fills[2]).toMatchObject({ exit: "take-profit", exitPrice: 4.0, fraction: 0.25 });
    expect(plan.fills[3]?.exit).toBe("time-stop");
    expect(plan.fills[3]?.fraction).toBeCloseTo(0.25, 10);
  });
  it("plusieurs paliers peuvent se déclencher sur la même observation", () => {
    const p = path([1, 5.0, 5.0]); // +400 % d'un coup : les 3 paliers à i=1
    const plan = simulateExit(p, 0, "runner", COSTS);
    expect(plan.fills.filter((f) => f.exit === "take-profit")).toHaveLength(3);
    expect(plan.fills).toHaveLength(4); // + solde en fin de données
  });
  it("stop-loss −25 % liquide tout le restant d'un coup", () => {
    const p = path([1, 1.5, 0.7, 0.8]);
    const plan = simulateExit(p, 0, "runner", COSTS);
    const sl = plan.fills.find((f) => f.exit === "stop-loss");
    expect(sl).toBeDefined();
    expect(sl?.fraction).toBeCloseTo(0.75, 10); // 25 % déjà pris à +50 %
    expect(plan.fills.map((f) => f.fraction).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
  it("le runner laisse courir là où le scalp serait déjà sorti", () => {
    const prices = [1, 1.31, 1.32, 1.33, 2.0]; // scalp TP à i=1 (+31 %)
    const scalp = simulateExit(path(prices), 0, "scalp", COSTS);
    const runner = simulateExit(path(prices), 0, "runner", COSTS);
    expect(scalp.fills).toHaveLength(1);
    expect(scalp.fills[0]?.bars).toBe(1);
    // runner : aucun palier atteint (+50 % jamais touché avant i=4 → +100 % = palier 1)
    expect(runner.fills[0]?.exitPrice).toBe(2.0);
    expect(runner.blendedRet).toBeGreaterThan(scalp.blendedRet);
  });
});

describe("robustesse", () => {
  it("refuse une entrée invalide", () => {
    expect(() => simulateExit(path([1, 2]), 5, "scalp", COSTS)).toThrow(/invalide/);
    expect(() => simulateExit(path([0, 2]), 0, "scalp", COSTS)).toThrow(/invalide/);
  });
  it("ignore les observations à prix 0 (donnée manquante)", () => {
    const p = path([1, 0, 0, 1.35]);
    const plan = simulateExit(p, 0, "scalp", COSTS);
    expect(plan.fills[0]?.exit).toBe("take-profit");
    expect(plan.fills[0]?.exitPrice).toBe(1.35);
  });
  it("les paramètres documentés sont cohérents", () => {
    expect(RUNNER_PARAMS.tiers.map((t) => t.fraction).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1);
    expect(SCALP_PARAMS.takeProfit).toBeGreaterThan(0);
  });
});
