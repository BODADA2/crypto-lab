/**
 * Verdict PRÉ-ENREGISTRÉ de l'hypothèse 6 (« les 4 questions » sur 14 canaux Telegram) — voir
 * docs/preregistration-memecoins.md. Figé le 28 septembre 2026, AVANT les calls jugés (seuls les calls publiés à partir
 * du 29 septembre 2026 00:00 heure du Nouveau-Brunswick = 03:00 UTC comptent). Ne pas modifier avant le verdict.
 *
 * H6 « 4 questions » : pour chaque token appelé en direct (vu < 30 min après sa publication) sur l'un des 14 canaux de
 * data-channels/, on achète à l'observation qui suit la PREMIÈRE observation, dans les 2 h après le call, où :
 *   1. l'argent entre   : volume 5 min ≥ 5 % de la liquidité ET achats 5 min ≥ ventes 5 min (> 0) ;
 *   2. on en parle      : vrai par construction (le call) ;
 *   3. pas un piège     : liquidité ≥ 20 000 $ ET prix ≥ la moitié du prix à la 1re observation après le call ;
 *   4. humeur du marché : non mesurée dans ces données → case grise, ne compte ni pour ni contre.
 * Règle d'achat du Journal : ≥ 3 vertes et 0 rouge → les questions 1 à 3 doivent être vertes.
 * Un seul trade par adresse (le premier canal qui l'appelle). Sorties de S1 (+50 % / −25 % / ~6 h), mêmes frais,
 * glissement, règle « disparu = −100 % », périodes A/B et critères que les hypothèses 1–4.
 *
 * Usage : npx tsx lab/backtest/preregistered-channels.ts [data-channels] [--now ISO]
 * Écrit reports/verdict-channels-YYYY-MM-DD.md et l'affiche.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCalls } from "../collect/calls.ts";
import { addressKey, type Call } from "../collect/telegram.ts";
import { makeSnapshot, zeroTxns, zeroWindows } from "../collect/types.ts";
import type { TokenSnapshot } from "../types.ts";
import { simulateToken, type SignalFn, type Trade } from "./harness.ts";
import { H4_RULES } from "./preregistered-calls.ts";
import { applyVanishRule, CRITERIA, periodStats, SPLIT_AT, type PeriodStats, type StrategyVerdict } from "./preregistered.ts";

// ---------------------------------------------------------------------------
// RÈGLES FIGÉES (ne pas modifier)
// ---------------------------------------------------------------------------

/** Premier instant où un call compte : 29 septembre 2026 00:00 America/Moncton (UTC−3). */
export const H6_START = Date.parse("2026-09-29T03:00:00Z");
export const H6_LIVE_LAG_MS = 30 * 60_000;
export const H6_WINDOW_MS = 2 * 3_600_000;
export const H6_MIN_VOLUME_TO_LIQUIDITY = 0.05;
export const H6_MIN_LIQUIDITY_USD = 20_000;
export const H6_MAX_DRAWDOWN_FROM_CALL = 0.5;
export const H6_RULES = H4_RULES;

// ---------------------------------------------------------------------------
// Données (observations complètes ou compactes {t,p,l,v5,b5,s5,mc,sym})
// ---------------------------------------------------------------------------

export function toSnapshot(mint: string, j: Record<string, unknown>): TokenSnapshot | null {
  const fetchedAt = String(j.t ?? j.fetchedAt ?? "");
  if (!Number.isFinite(Date.parse(fetchedAt))) return null;
  const vol = j.volume as { m5?: number } | undefined;
  const tx = j.txns as { m5?: { buys?: number; sells?: number } } | undefined;
  const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const volume = zeroWindows();
  volume.m5 = num(j.v5 ?? vol?.m5);
  const txns = zeroTxns();
  txns.m5 = { buys: num(j.b5 ?? tx?.m5?.buys), sells: num(j.s5 ?? tx?.m5?.sells) };
  return makeSnapshot({
    mint,
    fetchedAt: new Date(Date.parse(fetchedAt)).toISOString(),
    symbol: typeof (j.sym ?? j.symbol) === "string" ? String(j.sym ?? j.symbol) : "",
    priceUsd: num(j.p ?? j.priceUsd),
    liquidityUsd: num(j.l ?? j.liquidityUsd),
    volume,
    txns,
  });
}

export function loadSeries(dataDir: string): Map<string, TokenSnapshot[]> {
  const out = new Map<string, TokenSnapshot[]>();
  const dir = join(dataDir, "history");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const mint = f.replace(/\.jsonl$/, "");
    const rows: TokenSnapshot[] = [];
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = toSnapshot(mint, JSON.parse(line) as Record<string, unknown>);
        if (s) rows.push(s);
      } catch {
        /* ligne corrompue ignorée */
      }
    }
    rows.sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
    const key = addressKey(mint);
    out.set(key, (out.get(key) ?? []).concat(rows).sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt)));
  }
  return out;
}

/** Calls jugés : publiés après H6_START, vus en direct, chaîne tradable ; un seul par adresse (le premier vu). */
export function eligibleCalls(calls: Call[]): Call[] {
  const seen = new Set<string>();
  return calls
    .filter((c) => (c.chain === "solana" || c.chain === "robinhood") && Date.parse(c.postedAt) >= H6_START && Date.parse(c.seenAt) - Date.parse(c.postedAt) <= H6_LIVE_LAG_MS)
    .sort((a, b) => Date.parse(a.seenAt) - Date.parse(b.seenAt))
    .filter((c) => {
      const k = addressKey(c.address);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// ---------------------------------------------------------------------------
// Signal (fonction pure, aucune donnée future)
// ---------------------------------------------------------------------------

export function fourQuestionsGreen(s: TokenSnapshot, firstPrice: number): boolean {
  if (s.liquidityUsd <= 0 || s.priceUsd <= 0 || firstPrice <= 0) return false;
  const argent = s.volume.m5 / s.liquidityUsd >= H6_MIN_VOLUME_TO_LIQUIDITY && s.txns.m5.buys > 0 && s.txns.m5.buys >= s.txns.m5.sells;
  const piege = s.liquidityUsd >= H6_MIN_LIQUIDITY_USD && s.priceUsd >= (1 - H6_MAX_DRAWDOWN_FROM_CALL) * firstPrice;
  return argent && piege;
}

export function h6Signal(call: Call): SignalFn {
  const seen = Date.parse(call.seenAt);
  return (upToNow) => {
    const after = upToNow.filter((s) => Date.parse(s.fetchedAt) >= seen && s.priceUsd > 0);
    const first = after[0];
    if (!first) return 0;
    const idx = upToNow.findIndex((s) => {
      const t = Date.parse(s.fetchedAt);
      return t >= seen && t - seen <= H6_WINDOW_MS && fourQuestionsGreen(s, first.priceUsd);
    });
    return idx !== -1 && idx === upToNow.length - 1 ? 1 : 0;
  };
}

// ---------------------------------------------------------------------------
// Évaluation
// ---------------------------------------------------------------------------

export function evaluateChannels(dataDir: string): { verdict: StrategyVerdict; calls: number; eligible: number; dataEnd: number } {
  const calls = readCalls(join(dataDir, "calls.jsonl"));
  const series = loadSeries(dataDir);
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
  const eligible = eligibleCalls(calls);
  const trades: Trade[] = [];
  for (const c of eligible) {
    const s = series.get(addressKey(c.address));
    if (s && s.length > 1) trades.push(...simulateToken(s, h6Signal(c), H6_RULES));
  }
  const kept = applyVanishRule(trades, lastSeen, dataEnd).trades;
  const inA = kept.filter((t) => Date.parse(t.entryAt) < SPLIT_AT);
  const inB = kept.filter((t) => Date.parse(t.entryAt) >= SPLIT_AT);
  const a: PeriodStats = periodStats(inA, inA.filter((t) => t.ret === -1).length);
  const b: PeriodStats = periodStats(inB, inB.filter((t) => t.ret === -1).length);
  const enough = (p: PeriodStats) => p.n >= CRITERIA.minTradesPerPeriod;
  const failedWithEnough = (enough(a) && !a.pass) || (enough(b) && !b.pass);
  const verdict: StrategyVerdict = {
    id: "h6-quatre-questions",
    note: "H6 les 4 questions du Journal sur 14 canaux (≤ 2 h après le call) : +50 % / −25 % / ~6 h",
    a,
    b,
    verdict: a.pass && b.pass ? "RETENUE" : failedWithEnough ? "REJETÉE" : "NON CONCLUANT",
  };
  return { verdict, calls: calls.length, eligible: eligible.length, dataEnd };
}

export function formatChannelsVerdict(r: ReturnType<typeof evaluateChannels>, generatedAt: Date): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)} %`);
  const pf = (v: number | null) => (v === null ? "n/a" : v === Infinity ? "∞" : v.toFixed(2));
  const row = (label: string, p: PeriodStats) =>
    `| ${label} | ${p.n} | ${pct(p.winRate)} | ${pct(p.expectancy)} | ${pf(p.profitFactor)} | ${p.vanished} | ${p.pass ? "✅" : "❌"} ${p.reason} |`;
  const v = r.verdict;
  return [
    `# Verdict pré-enregistré — les 4 questions sur 14 canaux (hypothèse 6) — **${v.verdict}**`,
    ``,
    `Généré le ${generatedAt.toISOString()} — données jusqu'au ${r.dataEnd ? new Date(r.dataEnd).toISOString() : "n/a"}.`,
    `${r.calls} calls collectés ; ${r.eligible} jugés (publiés depuis le 29/09 00:00 heure du N.-B., vus en direct, Solana/Robinhood, un par adresse).`,
    ``,
    v.note,
    ``,
    `| Période | Trades | Gagnants | Espérance/trade | Gains ÷ pertes | Tokens disparus (−100 %) | Critères |`,
    `|---|---|---|---|---|---|---|`,
    row("A", v.a),
    row("B", v.b),
    ``,
    `Mêmes décisions que pour les hypothèses 1–5 : RETENUE → 4 semaines de paper en temps réel ; REJETÉE → abandon, pas de nouveau réglage.`,
  ].join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "data-channels");
  const nowIdx = process.argv.indexOf("--now");
  const now = nowIdx > 0 && process.argv[nowIdx + 1] ? new Date(process.argv[nowIdx + 1] as string) : new Date();
  const text = formatChannelsVerdict(evaluateChannels(dataDir), now);
  mkdirSync("reports", { recursive: true });
  const out = join("reports", `verdict-channels-${now.toISOString().slice(0, 10)}.md`);
  writeFileSync(out, text + "\n");
  console.log(text);
  console.log(`\n→ ${out}`);
}
