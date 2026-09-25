/**
 * Verdict PRÉ-ENREGISTRÉ des hypothèses 3 et 4 (calls Telegram) — voir docs/preregistration-memecoins.md.
 * Figé le 25 septembre 2026, avant toute donnée de calls. Ne pas modifier avant le verdict (17 octobre 2026).
 *
 *   H3 « copier les calls »      : chaque call (1re apparition de l'adresse) → achat à l'observation qui suit la
 *                                  première observation après le call ; sorties de S3 (+80 % / −30 % / ~24 h).
 *   H4 « call + volume » (mix)   : dans les 2 h après le call, première observation où le volume 5 min ≥ 5 % de la
 *                                  liquidité ET achats 5 min ≥ ventes 5 min (seuils de S1) → achat à l'observation
 *                                  suivante ; sorties de S1 (+50 % / −25 % / ~6 h).
 * Mêmes frais, glissement, liquidité minimale, règle « disparu = −100 % », périodes et critères que les hypothèses 1–2.
 *
 * Usage : npx tsx lab/backtest/preregistered-calls.ts [data-calls] [--now ISO]
 * Écrit reports/verdict-calls-YYYY-MM-DD.md et l'affiche.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCalls } from "../collect/calls.ts";
import { addressKey, type Call } from "../collect/telegram.ts";
import type { TokenSnapshot } from "../types.ts";
import { loadHistoryDir, simulateToken, type BacktestRules, type SignalFn, type Trade } from "./harness.ts";
import { applyVanishRule, CRITERIA, periodStats, SPLIT_AT, type PeriodStats, type StrategyVerdict } from "./preregistered.ts";

// ---------------------------------------------------------------------------
// RÈGLES FIGÉES (ne pas modifier)
// ---------------------------------------------------------------------------

const COMMON: Omit<BacktestRules, "takeProfit" | "stopLoss" | "timeStopBars"> = {
  threshold: 1,
  sizeUsd: 15,
  feesRoundTrip: 0.013,
  maxSlippage: 0.03,
  minLiquidityUsd: 20_000,
  cooldownBars: 1,
};
export const H3_RULES: BacktestRules = { ...COMMON, takeProfit: 0.8, stopLoss: 0.3, timeStopBars: 96 };
export const H4_RULES: BacktestRules = { ...COMMON, takeProfit: 0.5, stopLoss: 0.25, timeStopBars: 24 };
/** Fenêtre de confirmation de H4 après le call. */
export const H4_WINDOW_MS = 2 * 3_600_000;
export const H4_MIN_VOLUME_TO_LIQUIDITY = 0.05;

// ---------------------------------------------------------------------------
// Signaux (fonctions pures, aucune donnée future)
// ---------------------------------------------------------------------------

/** H3 : déclenche une seule fois, sur la première observation postérieure au moment où le call a été vu. */
export function h3Signal(call: Call): SignalFn {
  const seen = Date.parse(call.seenAt);
  return (upToNow) => {
    const idx = upToNow.findIndex((s) => Date.parse(s.fetchedAt) >= seen);
    return idx !== -1 && idx === upToNow.length - 1 ? 1 : 0;
  };
}

function h4Confirms(s: TokenSnapshot): boolean {
  if (s.liquidityUsd <= 0 || s.priceUsd <= 0) return false;
  const v2l = s.volume.m5 / s.liquidityUsd;
  const { buys, sells } = s.txns.m5;
  return v2l >= H4_MIN_VOLUME_TO_LIQUIDITY && buys > 0 && buys >= sells;
}

/** H4 : déclenche une seule fois, sur la première observation confirmée dans les 2 h après le call. */
export function h4Signal(call: Call): SignalFn {
  const seen = Date.parse(call.seenAt);
  return (upToNow) => {
    const idx = upToNow.findIndex((s) => {
      const t = Date.parse(s.fetchedAt);
      return t >= seen && t - seen <= H4_WINDOW_MS && h4Confirms(s);
    });
    return idx !== -1 && idx === upToNow.length - 1 ? 1 : 0;
  };
}

// ---------------------------------------------------------------------------
// Évaluation
// ---------------------------------------------------------------------------

export interface Scoreboard {
  calls: number;
  byChain: Record<string, number>;
  withData: number;
  /** Calls dont la première observation a une liquidité ≥ 20 k$. */
  tradable: number;
  /** Parmi les calls avec données : part ayant touché ×2 (depuis la 1re observation) dans les 24 h. */
  hitX2: number | null;
  /** Parmi les calls avec données : part valant moins de la moitié 24 h après (ou disparus). */
  halvedAt24h: number | null;
}

function seriesByAddress(dataDir: string): Map<string, TokenSnapshot[]> {
  const out = new Map<string, TokenSnapshot[]>();
  for (const [mint, s] of loadHistoryDir(join(dataDir, "history"))) out.set(addressKey(mint), s);
  return out;
}

export function scoreboard(calls: Call[], series: Map<string, TokenSnapshot[]>, dataEnd: number): Scoreboard {
  const byChain: Record<string, number> = {};
  for (const c of calls) byChain[c.chain] = (byChain[c.chain] ?? 0) + 1;
  let withData = 0;
  let tradable = 0;
  let x2 = 0;
  let halved = 0;
  let judged = 0;
  for (const c of calls) {
    const s = (series.get(addressKey(c.address)) ?? []).filter((x) => Date.parse(x.fetchedAt) >= Date.parse(c.seenAt) && x.priceUsd > 0);
    const first = s[0];
    if (!first) continue;
    withData += 1;
    if (first.liquidityUsd >= 20_000) tradable += 1;
    const t0 = Date.parse(first.fetchedAt);
    if (dataEnd - t0 < 24 * 3_600_000) continue; // pas encore 24 h de recul
    judged += 1;
    const day = s.filter((x) => Date.parse(x.fetchedAt) - t0 <= 24 * 3_600_000);
    if (day.some((x) => x.priceUsd >= 2 * first.priceUsd)) x2 += 1;
    const after = s.find((x) => Date.parse(x.fetchedAt) - t0 >= 24 * 3_600_000);
    if (!after || after.priceUsd < 0.5 * first.priceUsd) halved += 1;
  }
  return { calls: calls.length, byChain, withData, tradable, hitX2: judged ? x2 / judged : null, halvedAt24h: judged ? halved / judged : null };
}

function verdictOf(id: string, note: string, trades: Trade[]): StrategyVerdict {
  const inA = trades.filter((t) => Date.parse(t.entryAt) < SPLIT_AT);
  const inB = trades.filter((t) => Date.parse(t.entryAt) >= SPLIT_AT);
  const a: PeriodStats = periodStats(inA, inA.filter((t) => t.ret === -1).length);
  const b: PeriodStats = periodStats(inB, inB.filter((t) => t.ret === -1).length);
  const enough = (p: PeriodStats) => p.n >= CRITERIA.minTradesPerPeriod;
  const failedWithEnough = (enough(a) && !a.pass) || (enough(b) && !b.pass);
  const verdict: StrategyVerdict["verdict"] = a.pass && b.pass ? "RETENUE" : failedWithEnough ? "REJETÉE" : "NON CONCLUANT";
  return { id, note, a, b, verdict };
}

export function evaluateCalls(dataDir: string): { verdicts: StrategyVerdict[]; board: Scoreboard; dataEnd: number } {
  const calls = readCalls(join(dataDir, "calls.jsonl"));
  const series = seriesByAddress(dataDir);
  const lastSeen = new Map<string, number>();
  let dataEnd = 0;
  for (const [key, s] of series) {
    const last = s[s.length - 1];
    if (!last) continue;
    const ts = Date.parse(last.fetchedAt);
    lastSeen.set(last.mint, ts);
    lastSeen.set(key, ts);
    if (ts > dataEnd) dataEnd = ts;
  }
  const tradableCalls = calls.filter((c) => c.chain === "solana" || c.chain === "robinhood");
  const run = (signal: (c: Call) => SignalFn, rules: BacktestRules) => {
    const trades: Trade[] = [];
    for (const c of tradableCalls) {
      const s = series.get(addressKey(c.address));
      if (s && s.length > 1) trades.push(...simulateToken(s, signal(c), rules));
    }
    return applyVanishRule(trades, lastSeen, dataEnd).trades;
  };
  return {
    verdicts: [
      verdictOf("h3-copier-les-calls", "H3 copier chaque call : achat à l'observation suivante, +80 % / −30 % / ~24 h", run(h3Signal, H3_RULES)),
      verdictOf("h4-call-plus-volume", "H4 call + confirmation volume (≤ 2 h) : +50 % / −25 % / ~6 h", run(h4Signal, H4_RULES)),
    ],
    board: scoreboard(calls, series, dataEnd),
    dataEnd,
  };
}

export function formatCallsVerdict(r: ReturnType<typeof evaluateCalls>, generatedAt: Date): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)} %`);
  const pf = (v: number | null) => (v === null ? "n/a" : v === Infinity ? "∞" : v.toFixed(2));
  const row = (label: string, p: PeriodStats) =>
    `| ${label} | ${p.n} | ${pct(p.winRate)} | ${pct(p.expectancy)} | ${pf(p.profitFactor)} | ${p.vanished} | ${p.pass ? "✅" : "❌"} ${p.reason} |`;
  const b = r.board;
  const lines = [
    `# Verdict pré-enregistré — calls Telegram (hypothèses 3 et 4)`,
    ``,
    `Généré le ${generatedAt.toISOString()} — données jusqu'au ${r.dataEnd ? new Date(r.dataEnd).toISOString() : "n/a"}.`,
    ``,
    `## Tableau d'honneur réel des calls (descriptif, hors verdict)`,
    ``,
    `${b.calls} calls (${Object.entries(b.byChain).map(([k, v]) => `${k} ${v}`).join(", ") || "aucun"}), ${b.withData} avec des prix, ${b.tradable} avec liquidité ≥ 20 k$.`,
    `Part ayant touché ×2 dans les 24 h : ${pct(b.hitX2)}. Part valant moins de la moitié (ou disparue) 24 h après : ${pct(b.halvedAt24h)}.`,
    ``,
  ];
  for (const v of r.verdicts) {
    lines.push(
      `## ${v.id} — **${v.verdict}**`,
      ``,
      v.note,
      ``,
      `| Période | Trades | Gagnants | Espérance/trade | Gains ÷ pertes | Tokens disparus (−100 %) | Critères |`,
      `|---|---|---|---|---|---|---|`,
      row("A", v.a),
      row("B", v.b),
      ``,
    );
  }
  lines.push(`Mêmes décisions que pour les hypothèses 1–2 : RETENUE → 4 semaines de paper en temps réel ; REJETÉE → abandon, pas de nouveau réglage.`);
  return lines.join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "data-calls");
  const nowIdx = process.argv.indexOf("--now");
  const now = nowIdx > 0 && process.argv[nowIdx + 1] ? new Date(process.argv[nowIdx + 1] as string) : new Date();
  const text = formatCallsVerdict(evaluateCalls(dataDir), now);
  mkdirSync("reports", { recursive: true });
  const out = join("reports", `verdict-calls-${now.toISOString().slice(0, 10)}.md`);
  writeFileSync(out, text + "\n");
  console.log(text);
  console.log(`\n→ ${out}`);
}
