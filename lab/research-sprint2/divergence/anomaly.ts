/**
 * SPRINT 2A — Famille O : ANOMALY_SCORE.
 *
 * Distance z robuste au « régime » du jour (médiane mobile par jour
 * calendaire de t0) sur trois dimensions mesurées à t0 :
 *   - log(liquidité t0)
 *   - log(turnover h1)
 *   - log(vélocité) = log(buys+sells m5 + 1)
 *
 * Médianes/MAD calculées en leave-one-out (le token est exclu de son
 * propre régime). Jour avec < 10 tokens (après exclusion) → régime
 * indéterminé (null).
 *
 * ANOMALY = moyenne des |z| disponibles (≥ 2 dimensions requises).
 * ANOMALY ≠ OPPORTUNITY par défaut : les deux directions sont testées
 * (anomalie → pertes ET anomalie → gains).
 */
import type { DivergenceRow } from "./features.ts";

export interface AnomalyRow {
  mint: string;
  t0day: string;
  dexId: string | null;
  zLiq: number | null;
  zTurn: number | null;
  zVelo: number | null;
  /** Score composite : moyenne des |z| disponibles. */
  anomaly: number | null;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** z robuste : 0.6745 * (x - médiane) / MAD ; null si MAD = 0. */
export function robustZ(x: number, population: number[]): number | null {
  if (population.length === 0) return null;
  const med = median(population);
  const mad = median(population.map((v) => Math.abs(v - med)));
  if (mad <= 0) return null;
  return (0.6745 * (x - med)) / mad;
}

const MIN_COHORT = 10;

export function computeAnomaly(rows: DivergenceRow[]): AnomalyRow[] {
  const byDay = new Map<string, DivergenceRow[]>();
  for (const r of rows) {
    const g = byDay.get(r.t0day) ?? [];
    g.push(r);
    byDay.set(r.t0day, g);
  }
  const out: AnomalyRow[] = [];
  for (const r of rows) {
    const cohort = (byDay.get(r.t0day) ?? []).filter((x) => x.mint !== r.mint);
    let zLiq: number | null = null;
    let zTurn: number | null = null;
    let zVelo: number | null = null;
    if (cohort.length >= MIN_COHORT) {
      zLiq = robustZ(r.logLiqT0, cohort.map((x) => x.logLiqT0));
      const turnPop = cohort
        .map((x) => x.logTurnoverH1)
        .filter((v): v is number => v != null);
      zTurn = r.logTurnoverH1 != null ? robustZ(r.logTurnoverH1, turnPop) : null;
      zVelo = robustZ(r.logVelo, cohort.map((x) => x.logVelo));
    }
    const zs = [zLiq, zTurn, zVelo].filter((z): z is number => z != null);
    out.push({
      mint: r.mint,
      t0day: r.t0day,
      dexId: r.dexId,
      zLiq,
      zTurn,
      zVelo,
      anomaly: zs.length >= 2 ? zs.reduce((a, b) => a + Math.abs(b), 0) / zs.length : null,
    });
  }
  return out;
}

/** z robuste vs population complète (pour K3/K5, population discovery entière). */
export function populationRobustZ(x: number, population: number[]): number | null {
  return robustZ(x, population);
}
