/**
 * FLIP ENGINE — Sprint 0 : descriptifs des 12 événements §66 sur 30j de SOL-PERP.
 *
 * DESCRIPTIF UNIQUEMENT : fréquence, amplitude, durée. Aucun test prédictif, aucun modèle.
 * Données : Binance data.vision (klines 1m, metrics 30m, premium 1h) + Hyperliquid funding.
 */
import {
  collectBinance, fetchHLFunding, saveJson, DATA_DIR,
  type MetricRow, type PremiumRow, type FundingRow,
} from "./collect.js";
import {
  toBars5m, detectCascades, detectAbsorption, detectHourly, describeEvents,
  DEFAULT_CFG, HOUR_CFG,
  type HourRow, type FlipEvent,
} from "./events.js";

const SYMBOL = "SOLUSDT";
const START = "2026-08-29";
const END = "2026-09-27";

const hourFloor = (t: number) => Math.floor(t / 3_600_000) * 3_600_000;

function buildHourly(
  closes1m: Array<{ t: number; c: number }>,
  metrics: MetricRow[],
  premium: PremiumRow[],
  funding: FundingRow[],
): HourRow[] {
  // hourly closes from 1m
  const byHour = new Map<number, { first: number; last: number }>();
  for (const k of closes1m) {
    const h = hourFloor(k.t);
    const e = byHour.get(h);
    if (!e) byHour.set(h, { first: k.c, last: k.c });
    else e.last = k.c;
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const premByHour = new Map(premium.map((p) => [hourFloor(p.t), p.premium]));
  const fundByHour = new Map<number, number>();
  for (const f of funding) {
    const h = hourFloor(f.t);
    if (!fundByHour.has(h)) fundByHour.set(h, f.funding);
  }
  // OI: last metric at or before hour end
  let mi = 0;
  const oiByHour = new Map<number, number>();
  for (const h of hours) {
    while (mi < metrics.length && metrics[mi]!.t <= h + 3_600_000) mi++;
    const m = metrics[mi - 1];
    if (m && Number.isFinite(m.oi) && m.oi > 0) oiByHour.set(h, m.oi);
  }
  const rows: HourRow[] = [];
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i]!;
    const e = byHour.get(h);
    const ph = i > 0 ? hours[i - 1]! : null;
    const prev = ph != null ? byHour.get(ph) ?? null : null;
    const oi = oiByHour.get(h) ?? null;
    const oiPrev = ph != null ? oiByHour.get(ph) ?? null : null;
    rows.push({
      t: h,
      ret1h: e && prev && prev.last > 0 ? Math.log(e.last / prev.last) : 0,
      oi,
      oiChg1h: oi != null && oiPrev != null && oiPrev > 0 ? oi / oiPrev - 1 : null,
      premium: premByHour.get(h) ?? null,
      funding: fundByHour.get(h) ?? null,
    });
  }
  return rows;
}

async function main() {
  console.log(`[flip/sprint0] collecte ${SYMBOL} ${START} → ${END}`);
  const ds = collectBinance(SYMBOL, START, END);
  const startMs = Date.parse(START + "T00:00:00Z");
  const endMs = Date.parse(END + "T23:59:59Z");
  console.log("[flip/sprint0] funding Hyperliquid…");
  const funding = await fetchHLFunding("SOL", startMs, endMs);
  console.log(`[flip/sprint0] funding: ${funding.length} points horaires`);

  saveJson("sol-binance-30d.json", {
    manifest: ds.manifest,
    klines: ds.klines,
    metrics: ds.metrics,
    premium: ds.premium,
    hlFunding: funding,
  });

  const bars = toBars5m(ds.klines);
  console.log(`[flip/sprint0] ${bars.length} barres 5m`);
  const cascades = detectCascades(bars, DEFAULT_CFG);
  const absorption = detectAbsorption(cascades, bars, DEFAULT_CFG);
  const hourly = buildHourly(
    ds.klines.map((k) => ({ t: k.t, c: k.c })),
    ds.metrics, ds.premium, funding,
  );
  console.log(`[flip/sprint0] ${hourly.length} heures`);
  const hourlyEvents = detectHourly(hourly, HOUR_CFG);

  const events: FlipEvent[] = [...cascades, ...absorption, ...hourlyEvents]
    .sort((a, b) => a.t - b.t);
  const firstK = ds.klines[0];
  const lastK = ds.klines[ds.klines.length - 1];
  const daysSpan = firstK && lastK ? (lastK.t - firstK.t) / 86_400_000 : 0;
  const stats = describeEvents(events, daysSpan);

  // taux d'absorption après cascades (descriptif) — par type de cascade
  const e1 = events.filter((e) => e.type === "E1");
  const e2 = events.filter((e) => e.type === "E2");
  const a1 = absorption.filter((a) => a.meta.afterEvent === "E1").length;
  const a2 = absorption.filter((a) => a.meta.afterEvent === "E2").length;
  const absorptionRate = {
    E1_absorbed: e1.length ? a1 / e1.length : 0,
    E2_absorbed: e2.length ? a2 / e2.length : 0,
    nE1: e1.length, nE2: e2.length, nE12: absorption.length,
  };

  const out = {
    manifest: {
      ...ds.manifest,
      venue: "Binance SOLUSDT perp (data.vision) + Hyperliquid funding",
      generatedAt: new Date().toISOString(),
      config5m: DEFAULT_CFG,
      config1h: HOUR_CFG,
      nBars5m: bars.length,
      nHours: hourly.length,
      daysSpan: Number(daysSpan.toFixed(2)),
      note: "DESCRIPTIF UNIQUEMENT — seuils = guesses initiaux, aucun test prédictif",
    },
    stats,
    absorptionRate,
    events,
  };
  const p = saveJson("descriptives-2026-09-28.json", out);
  console.log(`[flip/sprint0] écrit ${p}`);

  console.log("\nÉvénement |   n |  /jour | amplitude% p50 (p10-p90) | durée min p50 (revert%)");
  console.log("----------|-----|-------|--------------------------|----------------------");
  for (const s of stats) {
    const amp = s.amplitudePct
      ? `${s.amplitudePct.p50.toFixed(2)} (${s.amplitudePct.p10.toFixed(2)}-${s.amplitudePct.p90.toFixed(2)})`
      : "—";
    const dur = s.durationMin
      ? `${s.durationMin.p50.toFixed(0)} (${s.durationMin.revertedPct.toFixed(0)}%)`
      : "—";
    console.log(
      `${s.type.padEnd(9)} | ${String(s.n).padStart(3)} | ${s.perDay.toFixed(2).padStart(5)} | ${amp.padStart(24)} | ${dur}`,
    );
  }
  console.log(`\nAbsorption E12: E1 ${a1}/${absorptionRate.nE1} (${(absorptionRate.E1_absorbed * 100).toFixed(0)}%), E2 ${a2}/${absorptionRate.nE2} (${(absorptionRate.E2_absorbed * 100).toFixed(0)}%)`);
  console.log(`[flip/sprint0] DATA_DIR=${DATA_DIR}`);
}

main().catch((e) => { console.error("[flip/sprint0] ERREUR:", e); process.exit(1); });
