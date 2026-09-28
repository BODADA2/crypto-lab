/**
 * Outcomes Y par horizon + survie, depuis data/history/<mint>.jsonl.
 * Utilise le protocole partagé (lab/predictive/universe.ts) : findT0,
 * futureReturns (prix nettoyés des ticks aberrants), horizons 1h/6h/24h.
 *
 * survie@H = au snapshot couvrant H : priceUsd > 0 ET liquidityUsd >= seuil.
 * Horizon non couvert => null (pas d'extrapolation, jamais inventé).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenSnapshot } from "../../types.ts";
import {
  HORIZONS_MS,
  aberrantMask,
  findT0,
  futureReturns,
  splitUniverse,
} from "../universe.ts";
import type { HorizonLabel, TokenOutcome } from "./types.ts";
import { SURVIVAL_LIQUIDITY_USD } from "./types.ts";

const LABELS: HorizonLabel[] = ["1h", "6h", "24h"];

/** Lit la série history d'un mint (jsonl, une ligne = un snapshot). */
export function readHistorySeries(historyDir: string, mint: string): TokenSnapshot[] {
  const p = path.join(historyDir, `${mint}.jsonl`);
  if (!fs.existsSync(p)) return [];
  const out: TokenSnapshot[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as TokenSnapshot);
    } catch {
      // Ligne corrompue : ignorée (documentée dans le rapport).
    }
  }
  return out;
}

/**
 * Snapshot couvrant l'horizon H depuis t0 : premier snapshot >= t0+H,
 * prix valide et non aberrant. null si l'horizon n'est pas couvert.
 */
export function snapshotAtHorizon(
  sorted: TokenSnapshot[],
  t0Idx: number,
  horizonMs: number,
  mask: boolean[],
): TokenSnapshot | null {
  const t0Time = Date.parse(sorted[t0Idx]!.fetchedAt);
  const target = t0Time + horizonMs;
  for (let i = t0Idx + 1; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (mask[i]) continue;
    if (s.priceUsd <= 0) continue;
    if (Date.parse(s.fetchedAt) >= target) return s;
  }
  return null;
}

export function computeOutcome(
  mint: string,
  series: TokenSnapshot[],
): TokenOutcome | null {
  const sorted = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0Idx = findT0(sorted);
  if (t0Idx < 0) return null;
  const mask = aberrantMask(sorted);
  const rets = futureReturns(sorted, [...HORIZONS_MS]);
  const retByH = new Map<number, number>(rets.map((r) => [r.horizonMs, r.ret]));

  const y = {} as Record<HorizonLabel, number | null>;
  const survival = {} as Record<HorizonLabel, boolean | null>;
  for (let k = 0; k < LABELS.length; k++) {
    const label = LABELS[k]!;
    const h = HORIZONS_MS[k]!;
    y[label] = retByH.has(h) ? (retByH.get(h) as number) : null;
    const snap = snapshotAtHorizon(sorted, t0Idx, h, mask);
    survival[label] =
      snap == null
        ? null
        : snap.priceUsd > 0 && (snap.liquidityUsd ?? 0) >= SURVIVAL_LIQUIDITY_USD;
  }
  return {
    mint,
    universe: splitUniverse(mint),
    t0Index: t0Idx,
    t0Time: sorted[t0Idx]!.fetchedAt,
    nTicks: sorted.length,
    aberrantTicks: mask.filter(Boolean).length,
    y,
    survival,
  };
}

/** Couverture des horizons sur un ensemble d'outcomes (à documenter). */
export function horizonCoverage(outcomes: TokenOutcome[]): Record<HorizonLabel, number> {
  const cov = { "1h": 0, "6h": 0, "24h": 0 } as Record<HorizonLabel, number>;
  for (const o of outcomes) for (const l of LABELS) if (o.y[l] != null) cov[l]++;
  return cov;
}
