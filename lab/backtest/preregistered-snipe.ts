/**
 * Verdict PRÉ-ENREGISTRÉ de l'hypothèse 5 (sniping pump.fun) — voir docs/preregistration-memecoins.md.
 * Figé le 28 septembre 2026, avant toute donnée de sniping. Ne pas modifier avant le verdict (17 octobre 2026).
 *
 *   H5a « sniper parfait »  : achat au prix juste après la création (p0), revente au prix à +5 min.
 *   H5b « sniper réaliste » : achat au prix à +1 min, revente au prix à +5 min.
 * Coût aller-retour : 5 % (frais pump.fun ~1 % par côté, frais de priorité, impact de notre propre achat).
 * Prix absent de DexScreener = prix inchangé (token sans échanges). Si plus de 30 % des tokens n'ont pas de prix à
 * +5 min, les données sont jugées peu fiables : NON CONCLUANT.
 * RETENUE seulement si H5a ET H5b passent sur A ET sur B (mêmes périodes et critères que les hypothèses 1–4).
 *
 * Usage : npx tsx lab/backtest/preregistered-snipe.ts [data-snipe] [--now ISO]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SnipeRecord } from "../collect/snipe.ts";
import type { Trade } from "./harness.ts";
import { CRITERIA, periodStats, SPLIT_AT, type PeriodStats } from "./preregistered.ts";

// RÈGLES FIGÉES (ne pas modifier)
export const SNIPE_COST = 0.05;
export const MAX_MISSING_SHARE = 0.3;

export function loadSnipes(dir: string): SnipeRecord[] {
  if (!existsSync(dir)) return [];
  const out: SnipeRecord[] = [];
  for (const f of readdirSync(dir).filter((f) => f.startsWith("snipes-") && f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SnipeRecord);
      } catch {
        /* ligne corrompue ignorée */
      }
    }
  }
  return out;
}

const priceAt = (r: SnipeRecord, target: number) => r.checks.find((c) => c.target === target)?.p ?? null;

/** Rendement net d'un snipe (fonction pure, testée). */
export function snipeReturn(r: SnipeRecord, variant: "a" | "b"): number {
  const entry = variant === "a" ? r.p0 : (priceAt(r, 60) ?? r.p0);
  const exit = priceAt(r, 300) ?? entry;
  return (exit / entry) * (1 - SNIPE_COST) - 1;
}

function asTrades(recs: SnipeRecord[], variant: "a" | "b"): Trade[] {
  return recs.map((r) => ({ mint: r.mint, entryAt: r.createdAt, exitAt: r.createdAt, entryPrice: r.p0, exitPrice: r.p0, ret: snipeReturn(r, variant), grossRet: 0, bars: 0, exit: "time-stop", score: 1, costs: SNIPE_COST }));
}

export interface SnipeVerdict {
  n: number;
  missingShare: number | null;
  upAt5min: number | null;
  medianMove5min: number | null;
  a: { A: PeriodStats; B: PeriodStats };
  b: { A: PeriodStats; B: PeriodStats };
  verdict: "RETENUE" | "REJETÉE" | "NON CONCLUANT";
}

export function evaluateSnipes(recs: SnipeRecord[]): SnipeVerdict {
  const complete = recs.filter((r) => r.checks.some((c) => c.target === 300));
  const n = complete.length;
  const missing = complete.filter((r) => priceAt(r, 300) === null).length;
  const moves = complete.map((r) => (priceAt(r, 300) ?? r.p0) / r.p0 - 1).sort((x, y) => x - y);
  const split = (v: "a" | "b") => {
    const tr = asTrades(complete, v);
    const A = tr.filter((t) => Date.parse(t.entryAt) < SPLIT_AT);
    const B = tr.filter((t) => Date.parse(t.entryAt) >= SPLIT_AT);
    return { A: periodStats(A, 0), B: periodStats(B, 0) };
  };
  const a = split("a");
  const b = split("b");
  const all = [a.A, a.B, b.A, b.B];
  const enough = (p: PeriodStats) => p.n >= CRITERIA.minTradesPerPeriod;
  const missingShare = n ? missing / n : null;
  let verdict: SnipeVerdict["verdict"];
  if (missingShare !== null && missingShare > MAX_MISSING_SHARE) verdict = "NON CONCLUANT";
  else if (all.every((p) => p.pass)) verdict = "RETENUE";
  else if (all.some((p) => enough(p) && !p.pass)) verdict = "REJETÉE";
  else verdict = "NON CONCLUANT";
  return {
    n,
    missingShare,
    upAt5min: n ? moves.filter((m) => m > 0).length / n : null,
    medianMove5min: n ? (moves[Math.floor(n / 2)] as number) : null,
    a,
    b,
    verdict,
  };
}

export function formatSnipeVerdict(v: SnipeVerdict, generatedAt: Date): string {
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)} %`);
  const pf = (x: number | null) => (x === null ? "n/a" : x === Infinity ? "∞" : x.toFixed(2));
  const row = (label: string, p: PeriodStats) => `| ${label} | ${p.n} | ${pct(p.winRate)} | ${pct(p.expectancy)} | ${pf(p.profitFactor)} | ${p.pass ? "✅" : "❌"} ${p.reason} |`;
  return [
    `# Verdict pré-enregistré — sniping pump.fun (hypothèse 5) — **${v.verdict}**`,
    ``,
    `Généré le ${generatedAt.toISOString()}. ${v.n} nouveaux tokens suivis ; sans prix à +5 min : ${pct(v.missingShare)}.`,
    `Tokens plus hauts à +5 min qu'à la création : ${pct(v.upAt5min)} ; variation médiane à +5 min : ${pct(v.medianMove5min)}.`,
    ``,
    `| Variante / période | Snipes | Gagnants | Espérance/snipe | Gains ÷ pertes | Critères |`,
    `|---|---|---|---|---|---|`,
    row("H5a parfait — A", v.a.A),
    row("H5a parfait — B", v.a.B),
    row("H5b réaliste — A", v.b.A),
    row("H5b réaliste — B", v.b.B),
    ``,
    `RETENUE seulement si les quatre lignes passent. Coût aller-retour compté : ${SNIPE_COST * 100} %.`,
  ].join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "data-snipe");
  const nowIdx = process.argv.indexOf("--now");
  const now = nowIdx > 0 && process.argv[nowIdx + 1] ? new Date(process.argv[nowIdx + 1] as string) : new Date();
  const text = formatSnipeVerdict(evaluateSnipes(loadSnipes(dir)), now);
  mkdirSync("reports", { recursive: true });
  const out = join("reports", `verdict-snipe-${now.toISOString().slice(0, 10)}.md`);
  writeFileSync(out, text + "\n");
  console.log(text);
  console.log(`\n→ ${out}`);
}
