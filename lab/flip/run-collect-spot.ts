/**
 * FLIP ENGINE — Branch B, Sprint 1. Parse les zips spot (cache) → JSONL.
 * Binance spot SOLUSDT 1m, même format que les klines perp (avec taker_buy_volume).
 */
import { dlVisionZip, readZipCsv, parseKlines, dateRange } from "./collect.js";
import { writeJsonl, writeJson } from "./store.js";

const SYMBOL = "SOLUSDT";
const START = "2026-03-28";
const END = "2026-09-27";
const VISION = "https://data.binance.vision/data/spot/daily";

async function main() {
  const tag = "2026-03_2026-09";
  const all: number[][] = [];
  const missing: string[] = [];
  for (const d of dateRange(START, END)) {
    const z = dlVisionZip(`${VISION}/klines/${SYMBOL}/1m/${SYMBOL}-1m-${d}.zip`, `SPOT-${SYMBOL}-1m-${d}.zip`);
    if (!z) { missing.push(d); continue; }
    const klines = parseKlines(readZipCsv(z));
    for (const k of klines) {
      // les klines SPOT data.vision sont en microsecondes (16 chiffres) → normaliser en ms
      const t = k.t > 1e14 ? Math.round(k.t / 1000) : k.t;
      all.push([t, k.o, k.h, k.l, k.c, k.v, k.buyVol, k.n]);
    }
  }
  all.sort((a, b) => (a[0] as number) - (b[0] as number));
  const p = await writeJsonl(`klines-spot-solusdt-1m-${tag}.jsonl`, all);
  writeJson(`manifest-spot-${tag}.json`, {
    source: "data.binance.vision spot/daily klines SOLUSDT 1m",
    start: START, end: END, nKlines: all.length, missingDays: missing,
    generatedAt: new Date().toISOString(),
  });
  console.log(`[flip/collect-spot] ${all.length} klines spot → ${p} (missing: ${missing.length})`);
}

main().catch((e) => { console.error("[flip/collect-spot] ERREUR:", e); process.exit(1); });
