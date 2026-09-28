/**
 * FLIP ENGINE — Branch B. Collecte READ-ONLY (aucune clé, aucun secret, coût 0).
 *
 * Sources :
 *  - Binance public data archive (data.binance.vision) : klines 1m, metrics 30m,
 *    premiumIndexKlines 1h, markPriceKlines 1h — zips quotidiens.
 *  - Hyperliquid public API : fundingHistory horaire (paginé).
 *
 * N'écrit que dans data/flip/ (Branch B). Ne touche jamais aux dossiers Branch A.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kline1m } from "./events.js";

export const DATA_DIR = "/home/hatch/workspace/crypto-lab/repo/data/flip";
const VISION = "https://data.binance.vision/data/futures/um/daily";
const HL = "https://api.hyperliquid.xyz/info";

export interface MetricRow {
  t: number; // ms (UTC)
  oi: number; // sum_open_interest (contracts)
  oiValue: number; // sum_open_interest_value (USDT)
  topCountLS: number; // count_toptrader_long_short_ratio
  topSumLS: number; // sum_toptrader_long_short_ratio
  countLS: number; // count_long_short_ratio
  takerVolRatio: number; // sum_taker_long_short_vol_ratio
}

export interface PremiumRow { t: number; premium: number; }
export interface FundingRow { t: number; funding: number; premium: number; }

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
}

function parseCsv(text: string): string[][] {
  return text.trim().split("\n").map((l) => l.split(","));
}

function num(x: string | undefined): number {
  const v = Number(x);
  return Number.isFinite(v) ? v : NaN;
}

/** Télécharge un zip data.vision dans le cache local, retourne le chemin. */
export function dlVisionZip(url: string, cacheName: string): string | null {
  const dir = join(DATA_DIR, "_cache");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, cacheName);
  if (!existsSync(dest) || (readFileSync(dest).length < 100)) {
    try {
      sh("curl", ["-sL", "--max-time", "60", "--retry", "2", "-o", dest, url]);
    } catch {
      return null;
    }
  }
  try {
    const probe = sh("unzip", ["-l", dest]);
    if (!probe.includes(".csv")) return null;
  } catch {
    return null;
  }
  return dest;
}

export function readZipCsv(zipPath: string): string[][] {
  const text = sh("unzip", ["-p", zipPath]);
  return parseCsv(text);
}

const hasHeader = (rows: string[][]) => rows.length > 0 && /open_time|create_time/.test(rows[0]?.[0] ?? "");

export function parseKlines(rows: string[][]): Kline1m[] {
  const data = hasHeader(rows) ? rows.slice(1) : rows;
  const out: Kline1m[] = [];
  for (const r of data) {
    if (r.length < 11) continue;
    const c = num(r[4]);
    if (!Number.isFinite(c) || c <= 0) continue;
    out.push({
      t: Number(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c,
      v: num(r[5]), buyVol: num(r[9]), n: Number(r[8]),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function parseMetrics(rows: string[][]): MetricRow[] {
  const data = hasHeader(rows) ? rows.slice(1) : rows;
  const out: MetricRow[] = [];
  for (const r of data) {
    if (r.length < 8) continue;
    const ts = r[0];
    if (!ts) continue;
    // "2026-09-26 00:30:00" -> UTC ms
    const t = Date.parse(ts.replace(" ", "T") + "Z");
    if (!Number.isFinite(t)) continue;
    out.push({
      t, oi: num(r[2]), oiValue: num(r[3]), topCountLS: num(r[4]),
      topSumLS: num(r[5]), countLS: num(r[6]), takerVolRatio: num(r[7]),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function parsePremium(rows: string[][]): PremiumRow[] {
  const data = hasHeader(rows) ? rows.slice(1) : rows;
  const out: PremiumRow[] = [];
  for (const r of data) {
    if (r.length < 5) continue;
    const p = num(r[4]); // close du premium index
    if (!Number.isFinite(p)) continue;
    out.push({ t: Number(r[0]), premium: p });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface BinanceDay {
  date: string;
  klines: Kline1m[];
  metrics: MetricRow[];
  premium: PremiumRow[];
}

export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Collecte un jour (3 zips). Retourne null si les klines manquent. */
export function collectDay(symbol: string, date: string): BinanceDay | null {
  const kUrl = `${VISION}/klines/${symbol}/1m/${symbol}-1m-${date}.zip`;
  const mUrl = `${VISION}/metrics/${symbol}/${symbol}-metrics-${date}.zip`;
  const pUrl = `${VISION}/premiumIndexKlines/${symbol}/1h/${symbol}-1h-${date}.zip`;
  const kz = dlVisionZip(kUrl, `${symbol}-1m-${date}.zip`);
  if (!kz) return null;
  const klines = parseKlines(readZipCsv(kz));
  const mz = dlVisionZip(mUrl, `${symbol}-metrics-${date}.zip`);
  const pz = dlVisionZip(pUrl, `${symbol}-1h-${date}.zip`);
  return {
    date,
    klines,
    metrics: mz ? parseMetrics(readZipCsv(mz)) : [],
    premium: pz ? parsePremium(readZipCsv(pz)) : [],
  };
}

export interface BinanceDataset extends BinanceDay {
  manifest: {
    source: string;
    symbol: string;
    start: string;
    end: string;
    fetchedAt: string;
    days: string[];
    missingDays: string[];
  };
}

/** Collecte N jours, concatène et trie. */
export function collectBinance(symbol: string, start: string, end: string): BinanceDataset {
  const days = dateRange(start, end);
  const klines: Kline1m[] = [];
  const metrics: MetricRow[] = [];
  const premium: PremiumRow[] = [];
  const ok: string[] = [];
  const missing: string[] = [];
  for (const d of days) {
    const day = collectDay(symbol, d);
    if (!day || day.klines.length === 0) { missing.push(d); continue; }
    ok.push(d);
    klines.push(...day.klines);
    metrics.push(...day.metrics);
    premium.push(...day.premium);
    process.stderr.write(`  ${d}: ${day.klines.length} klines 1m, ${day.metrics.length} metrics, ${day.premium.length} premium\n`);
  }
  klines.sort((a, b) => a.t - b.t);
  metrics.sort((a, b) => a.t - b.t);
  premium.sort((a, b) => a.t - b.t);
  return {
    date: `${start}_${end}`, klines, metrics, premium,
    manifest: {
      source: "data.binance.vision futures/um daily",
      symbol, start, end,
      fetchedAt: new Date().toISOString(),
      days: ok, missingDays: missing,
    },
  };
}

/** Hyperliquid fundingHistory paginé (500 entrées/req). */
export async function fetchHLFunding(coin: string, startMs: number, endMs: number): Promise<FundingRow[]> {
  const out: FundingRow[] = [];
  let cursor = startMs;
  for (let page = 0; page < 40; page++) {
    const res = await fetch(HL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fundingHistory", coin, startTime: cursor }),
    });
    if (!res.ok) throw new Error(`HL fundingHistory HTTP ${res.status}`);
    const arr = (await res.json()) as Array<{ fundingRate: string; premium: string; time: number }>;
    if (arr.length === 0) break;
    for (const e of arr) {
      if (e.time > endMs) continue;
      out.push({ t: e.time, funding: Number(e.fundingRate), premium: Number(e.premium) });
    }
    const lastEntry = arr[arr.length - 1];
    if (!lastEntry) break;
    const last = lastEntry.time;
    if (last >= endMs || arr.length < 500) break;
    cursor = last + 1;
    await new Promise((r) => setTimeout(r, 300));
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((r, i, a) => i === 0 || r.t !== a[i - 1]?.t);
}

export function saveJson(name: string, data: unknown): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = join(DATA_DIR, name);
  writeFileSync(p, JSON.stringify(data, null, 1));
  return p;
}
