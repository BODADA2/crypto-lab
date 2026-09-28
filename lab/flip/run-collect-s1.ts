/**
 * FLIP ENGINE — Branch B, Sprint 1. Collecte étendue : 6 mois de SOL-PERP.
 *
 * Sources : Binance data.vision (klines 1m, metrics 30m — granularité réelle constatée,
 *           premiumIndexKlines 1h) + Hyperliquid (fundingHistory 1h, candleSnapshot 5m).
 * Stockage : data/flip/*.jsonl (JSONL, lignes = tableaux compacts).
 * Lecture seule, coût 0, aucun secret. N'écrit que dans data/flip/.
 *
 * NOTE GRANULARITÉ : la spec §10 annonçait des metrics 5m ; les fichiers
 * data.vision contiennent en réalité des lignes 30m (289 lignes/jour).
 * Documenté comme écart, pas contourné.
 */
import { collectBinance, fetchHLFunding } from "./collect.js";
import { fetchHLCandles } from "./leadlag.js";
import { writeJsonl, writeJson } from "./store.js";

const SYMBOL = "SOLUSDT";
const START = "2026-03-28";
const END = "2026-09-27";

async function main() {
  console.log(`[flip/collect-s1] ${SYMBOL} ${START} → ${END} (cache zips réutilisé si présent)`);
  const ds = collectBinance(SYMBOL, START, END);
  console.log(`[flip/collect-s1] ${ds.klines.length} klines 1m, ${ds.metrics.length} metrics, ${ds.premium.length} premium`);

  const tag = "2026-03_2026-09";
  await writeJsonl(`klines-solusdt-1m-${tag}.jsonl`,
    ds.klines.map((k) => [k.t, k.o, k.h, k.l, k.c, k.v, k.buyVol, k.n]));
  console.log("[flip/collect-s1] klines JSONL ok");
  await writeJsonl(`metrics-solusdt-30m-${tag}.jsonl`,
    ds.metrics.map((m) => [m.t, m.oi, m.oiValue, m.topCountLS, m.topSumLS, m.countLS, m.takerVolRatio]));
  console.log("[flip/collect-s1] metrics JSONL ok");
  await writeJsonl(`premium-solusdt-1h-${tag}.jsonl`,
    ds.premium.map((p) => [p.t, p.premium]));
  console.log("[flip/collect-s1] premium JSONL ok");

  const startMs = Date.parse(START + "T00:00:00Z");
  const endMs = Date.parse(END + "T23:59:59Z");
  console.log("[flip/collect-s1] funding Hyperliquid…");
  const funding = await fetchHLFunding("SOL", startMs, endMs);
  await writeJsonl(`funding-hl-sol-1h-${tag}.jsonl`, funding.map((f) => [f.t, f.funding, f.premium]));
  console.log(`[flip/collect-s1] funding: ${funding.length} points`);

  console.log("[flip/collect-s1] bougies HL 5m…");
  const candles = await fetchHLCandles("SOL", startMs, endMs);
  await writeJsonl(`hl-candles-sol-5m-${tag}.jsonl`, candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]));
  console.log(`[flip/collect-s1] HL candles: ${candles.length}`);

  const manifest = {
    ...ds.manifest,
    tag,
    granularity: { klines: "1m", metrics: "30m (constaté, spec disait 5m)", premium: "1h", hlFunding: "1h", hlCandles: "5m" },
    nKlines: ds.klines.length,
    nMetrics: ds.metrics.length,
    nPremium: ds.premium.length,
    nHlFunding: funding.length,
    nHlCandles: candles.length,
    generatedAt: new Date().toISOString(),
    note: "Sprint 1 — collecte étendue 6 mois, discovery uniquement pour les tests",
  };
  const p = writeJson(`manifest-s1-${tag}.json`, manifest);
  console.log(`[flip/collect-s1] manifest ${p}`);
}

main().catch((e) => { console.error("[flip/collect-s1] ERREUR:", e); process.exit(1); });
