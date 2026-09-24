/**
 * Générateur déterministe de séries synthétiques (fixtures de backtest et tests).
 * Ce n'est PAS de la donnée de marché : il sert uniquement à vérifier la mécanique du harnais.
 * Pour une vraie évaluation, `data/history/` doit être alimenté par `lab/collect/run.ts`.
 */
import { makeSnapshot } from "../collect/types.ts";
import type { TokenSnapshot } from "../types.ts";

/** PRNG mulberry32 (déterministe). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  mint: string;
  symbol?: string;
  bars?: number;
  startMs?: number;
  stepMs?: number;
  seed?: number;
  price0?: number;
  liquidity0?: number;
  /** Indices de barres où un « pump » de volume démarre (volume x8, prix +/-). */
  pumpsAt?: number[];
  /** Rendement moyen d'un pump sur les 6 barres suivantes (fraction, ex. 0.6 ou -0.3). */
  pumpDrift?: number;
}

export function synthSeries(o: SynthOptions): TokenSnapshot[] {
  const rnd = mulberry32(o.seed ?? 1);
  const bars = o.bars ?? 100;
  const step = o.stepMs ?? 300_000;
  const start = o.startMs ?? Date.UTC(2026, 8, 1, 0, 0, 0);
  let price = o.price0 ?? 0.001;
  let liq = o.liquidity0 ?? 40_000;
  let holders = 200;
  const pumps = new Set(o.pumpsAt ?? []);
  const out: TokenSnapshot[] = [];
  let pumpLeft = 0;
  for (let i = 0; i < bars; i++) {
    if (pumps.has(i)) pumpLeft = 6;
    const inPump = pumpLeft > 0;
    if (inPump) pumpLeft -= 1;
    const drift = inPump ? (o.pumpDrift ?? 0.4) / 6 : 0;
    const noise = (rnd() - 0.5) * 0.04;
    price = Math.max(1e-9, price * (1 + drift + noise));
    liq = Math.max(5_000, liq * (1 + (rnd() - 0.5) * 0.02 + (inPump ? 0.03 : 0)));
    const baseVol = liq * 0.03 * (0.6 + rnd() * 0.8);
    const vol = inPump ? baseVol * 8 : baseVol;
    holders += inPump ? 20 + Math.floor(rnd() * 30) : Math.floor(rnd() * 4);
    const buys = Math.floor(vol / 200 * (inPump ? 0.7 : 0.5));
    const sells = Math.floor(vol / 200 * (inPump ? 0.3 : 0.5));
    const t = start + i * step;
    out.push(makeSnapshot({
      mint: o.mint,
      symbol: o.symbol ?? "SYN",
      name: `Synthetic ${o.symbol ?? "SYN"}`,
      pairAddress: null,
      dexId: "raydium",
      url: null,
      priceUsd: Number(price.toPrecision(6)),
      liquidityUsd: Math.round(liq),
      fdvUsd: Math.round(price * 1e9),
      marketCapUsd: Math.round(price * 1e9),
      volume: { m5: Math.round(vol), h1: Math.round(vol * 10), h6: Math.round(vol * 50), h24: Math.round(vol * 150) },
      priceChange: { m5: Number(((drift + noise) * 100).toFixed(2)), h1: 0, h6: 0, h24: 0 },
      txns: { m5: { buys, sells }, h1: { buys: buys * 10, sells: sells * 10 }, h6: { buys: buys * 50, sells: sells * 50 }, h24: { buys: buys * 150, sells: sells * 150 } },
      holders,
      pairCreatedAt: start - 3_600_000,
      boostsActive: 0,
      pairCount: 1,
      source: "fixture",
      fetchedAt: new Date(t).toISOString(),
    }));
  }
  return out;
}
