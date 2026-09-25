/**
 * Verdict PRÉ-ENREGISTRÉ des stratégies memecoins (S1, S3) — voir docs/preregistration-memecoins.md.
 *
 * Règles figées le 25 septembre 2026, AVANT d'avoir regardé les résultats. Ce fichier ne doit pas être
 * modifié avant le verdict (le 17 octobre 2026) : toute modification invalide le test.
 *
 * Usage : npx tsx lab/backtest/preregistered.ts [dossier-data] [--now ISO]
 * Écrit reports/verdict-memecoins-YYYY-MM-DD.md et l'affiche.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createS1Volume } from "../strategies/s1-volume.ts";
import { createS3Migration } from "../strategies/s3-migration.ts";
import type { Strategy } from "../strategies/types.ts";
import type { TokenSnapshot } from "../types.ts";
import { loadHistoryDir, runStrategyBacktest, type BacktestRules, type InputExtras, type Trade } from "./harness.ts";

// ---------------------------------------------------------------------------
// RÈGLES FIGÉES (ne pas modifier)
// ---------------------------------------------------------------------------

/** Frontière entre la période A et la période B (UTC). */
export const SPLIT_AT = Date.parse("2026-10-06T00:00:00Z");
/** Un token dont la dernière observation précède la fin des données de plus de 2 h est considéré disparu. */
export const VANISH_GAP_MS = 2 * 3_600_000;
export const CRITERIA = { minTradesPerPeriod: 30, minProfitFactor: 1.3, minExpectancy: 0 } as const;

const COMMON: Omit<BacktestRules, "takeProfit" | "stopLoss" | "timeStopBars"> = {
  threshold: 1, // tout signal BUY de la stratégie (force > 0) déclenche l'entrée à l'observation suivante
  sizeUsd: 15, // ≈ 20 $ CAD par trade
  feesRoundTrip: 0.013, // 1 % plateforme + 0,3 % swap
  maxSlippage: 0.03, // plafond de la politique de risque, par côté
  minLiquidityUsd: 20_000,
  cooldownBars: 1,
};

interface Plan {
  strategy: Strategy;
  rules: BacktestRules;
  note: string;
}

// Snapshots collectés toutes les ~15 min : 24 observations ≈ 6 h ; 96 ≈ 24 h.
export function plans(): Plan[] {
  return [
    {
      strategy: createS1Volume(),
      rules: { ...COMMON, takeProfit: 0.5, stopLoss: 0.25, timeStopBars: 24 },
      note: "S1 volume anormal : objectif +50 %, stop −25 %, sortie après ~6 h",
    },
    {
      strategy: createS3Migration(),
      rules: { ...COMMON, takeProfit: 0.8, stopLoss: 0.3, timeStopBars: 96 },
      note: "S3 post-migration : objectif +80 %, stop −30 %, sortie après ~24 h",
    },
  ];
}

// ---------------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------------

/** Première migration vue par mint, depuis data/scans/pump-*.jsonl (kind = "migrate"). */
export function loadMigrations(dataDir: string): Map<string, number> {
  const out = new Map<string, number>();
  const dir = join(dataDir, "scans");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.startsWith("pump-") && f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { kind?: string; mint?: string; receivedAt?: string };
        if (ev.kind !== "migrate" || !ev.mint || !ev.receivedAt) continue;
        const ts = Date.parse(ev.receivedAt);
        if (!Number.isFinite(ts)) continue;
        const prev = out.get(ev.mint);
        if (prev === undefined || ts < prev) out.set(ev.mint, ts);
      } catch {
        /* ligne corrompue ignorée */
      }
    }
  }
  return out;
}

/** La migration n'est fournie à la stratégie que si elle est antérieure à l'instant évalué (aucun futur). */
export function migrationExtras(migrations: Map<string, number>): InputExtras {
  return (upToNow: TokenSnapshot[]) => {
    const last = upToNow[upToNow.length - 1];
    if (!last) return {};
    const at = migrations.get(last.mint);
    const now = Date.parse(last.fetchedAt);
    return at !== undefined && at <= now ? { migration: { migratedAt: at } } : { migration: null };
  };
}

// ---------------------------------------------------------------------------
// Évaluation
// ---------------------------------------------------------------------------

export interface PeriodStats {
  n: number;
  winRate: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  vanished: number;
  pass: boolean;
  reason: string;
}

/** Règle anti-biais : position ouverte sur un token disparu des données = perte totale (−100 %). */
export function applyVanishRule(trades: Trade[], lastSeenByMint: Map<string, number>, dataEnd: number): { trades: Trade[]; vanished: number } {
  let vanished = 0;
  const out = trades.map((t) => {
    if (t.exit !== "end-of-data") return t;
    const lastSeen = lastSeenByMint.get(t.mint) ?? 0;
    if (dataEnd - lastSeen > VANISH_GAP_MS) {
      vanished += 1;
      return { ...t, ret: -1 };
    }
    return t;
  });
  return { trades: out, vanished };
}

export function periodStats(trades: Trade[], vanished: number): PeriodStats {
  const n = trades.length;
  if (n === 0) return { n, winRate: null, expectancy: null, profitFactor: null, vanished, pass: false, reason: "aucun trade" };
  const wins = trades.filter((t) => t.ret > 0);
  const gain = wins.reduce((s, t) => s + t.ret, 0);
  const loss = trades.filter((t) => t.ret <= 0).reduce((s, t) => s - t.ret, 0);
  const expectancy = trades.reduce((s, t) => s + t.ret, 0) / n;
  const profitFactor = loss === 0 ? Infinity : gain / loss;
  const reasons: string[] = [];
  if (n < CRITERIA.minTradesPerPeriod) reasons.push(`n = ${n} < ${CRITERIA.minTradesPerPeriod} (non concluant)`);
  if (profitFactor < CRITERIA.minProfitFactor) reasons.push(`gains ÷ pertes ${profitFactor.toFixed(2)} < ${CRITERIA.minProfitFactor}`);
  if (!(expectancy > CRITERIA.minExpectancy)) reasons.push(`espérance ${(expectancy * 100).toFixed(2)} % ≤ 0`);
  return {
    n,
    winRate: wins.length / n,
    expectancy,
    profitFactor,
    vanished,
    pass: reasons.length === 0,
    reason: reasons.length ? reasons.join(" ; ") : "critères remplis",
  };
}

export interface StrategyVerdict {
  id: string;
  note: string;
  a: PeriodStats;
  b: PeriodStats;
  verdict: "RETENUE" | "REJETÉE" | "NON CONCLUANT";
}

export function evaluate(dataDir: string): { verdicts: StrategyVerdict[]; dataEnd: number; tokens: number } {
  const series = loadHistoryDir(join(dataDir, "history"));
  const migrations = loadMigrations(dataDir);
  const lastSeen = new Map<string, number>();
  let dataEnd = 0;
  for (const [mint, s] of series) {
    const last = s[s.length - 1];
    if (!last) continue;
    const ts = Date.parse(last.fetchedAt);
    lastSeen.set(mint, ts);
    if (ts > dataEnd) dataEnd = ts;
  }
  const verdicts = plans().map(({ strategy, rules, note }) => {
    const extras = strategy.id === "s3-migration" ? migrationExtras(migrations) : undefined;
    const report = runStrategyBacktest(series, strategy, rules, extras);
    const all = applyVanishRule(report.trades, lastSeen, dataEnd).trades;
    const inA = all.filter((t) => Date.parse(t.entryAt) < SPLIT_AT);
    const inB = all.filter((t) => Date.parse(t.entryAt) >= SPLIT_AT);
    const va = inA.filter((t) => t.ret === -1).length;
    const vb = inB.filter((t) => t.ret === -1).length;
    const a = periodStats(inA, va);
    const b = periodStats(inB, vb);
    // Une période avec assez de trades qui échoue ⇒ REJETÉE. Sinon, si un échec ne vient que du manque de trades ⇒ NON CONCLUANT.
    const enough = (p: PeriodStats) => p.n >= CRITERIA.minTradesPerPeriod;
    const failedWithEnough = (enough(a) && !a.pass) || (enough(b) && !b.pass);
    const verdict: StrategyVerdict["verdict"] = a.pass && b.pass ? "RETENUE" : failedWithEnough ? "REJETÉE" : "NON CONCLUANT";
    return { id: `${strategy.id}@${strategy.version}`, note, a, b, verdict };
  });
  return { verdicts, dataEnd, tokens: series.size };
}

export function formatVerdict(r: ReturnType<typeof evaluate>, generatedAt: Date): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)} %`);
  const pf = (v: number | null) => (v === null ? "n/a" : v === Infinity ? "∞" : v.toFixed(2));
  const row = (label: string, p: PeriodStats) =>
    `| ${label} | ${p.n} | ${pct(p.winRate)} | ${pct(p.expectancy)} | ${pf(p.profitFactor)} | ${p.vanished} | ${p.pass ? "✅" : "❌"} ${p.reason} |`;
  const lines = [
    `# Verdict pré-enregistré — stratégies memecoins`,
    ``,
    `Généré le ${generatedAt.toISOString()} — données jusqu'au ${r.dataEnd ? new Date(r.dataEnd).toISOString() : "n/a"}, ${r.tokens} tokens.`,
    `Règles : docs/preregistration-memecoins.md (figées le 25/09/2026). Période A : avant le 06/10/2026, période B : à partir du 06/10/2026.`,
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
  lines.push(
    `RETENUE = passe sur A ET sur B → 4 semaines supplémentaires en paper, en temps réel, avant toute décision d'argent réel.`,
    `REJETÉE = abandonnée ; pas de nouveau réglage sur ces mêmes données. NON CONCLUANT = trop peu de trades ; la collecte continue, aucun argent réel.`,
  );
  return lines.join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "data");
  const nowIdx = process.argv.indexOf("--now");
  const now = nowIdx > 0 && process.argv[nowIdx + 1] ? new Date(process.argv[nowIdx + 1] as string) : new Date();
  const result = evaluate(dataDir);
  const text = formatVerdict(result, now);
  mkdirSync("reports", { recursive: true });
  const out = join("reports", `verdict-memecoins-${now.toISOString().slice(0, 10)}.md`);
  writeFileSync(out, text + "\n");
  console.log(text);
  console.log(`\n→ ${out}`);
}
