/**
 * Backtest H-EXIT sur données RÉELLES — data/history/*.jsonl (snapshots DexScreener).
 *
 * Compare 3 variantes à entrées IDENTIQUES (première observation avec
 * liquidité ≥ 20 000 $, exécution à t+1) :
 *   - "scalp"    : tout le monde sort en régime scalp (TP +30 %, SL −20 %) ;
 *   - "runner"   : tout le monde sort en régime runner (paliers +50/+150/+300 %) ;
 *   - "adaptive" : régime choisi par le score catalyst walk-forward du token
 *                  (≥ 40 → runner, sinon scalp ; cf. lab/signals/catalyst.ts).
 *
 * Chaque variante passe par `summarize` : n < 30 ⇒ NON CONCLUANT (NO ACTION).
 * Coûts : 1,3 % aller-retour + slippage ∝ taille/liquidité (plafond 3 %),
 * taille 50 $ (borne de la politique).
 *
 * Usage : `npx tsx lab/backtest/run-exit-comparison.ts [racine]`
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistoryDir, formatReport } from "./harness.ts";
import { runExitComparison, type ExitVariant } from "./exit-harness.ts";
import {
  acceleratingTermsByDay,
  createsToDocs,
  scoreTokensWalkForward,
  type CatalystToken,
} from "../signals/catalyst.ts";

function readJsonl<T>(path: string): T[] {
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      /* ignorée */
    }
  }
  return out;
}

export function runExitComparisonReal(rootDir: string) {
  const historyDir = join(rootDir, "data", "history");
  const seriesByMint = loadHistoryDir(historyDir);

  // --- Catalyst walk-forward depuis les scans (pas de lookahead) ---
  const scansDir = join(rootDir, "data", "scans");
  const scanFiles = existsSync(scansDir)
    ? readdirSync(scansDir)
        .filter((f) => /^pump-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
    : [];
  const creates: { name: string; symbol: string; receivedAt: string }[] = [];
  for (const f of scanFiles) {
    for (const e of readJsonl<{ kind: string; name?: string; symbol?: string; receivedAt?: string }>(join(scansDir, f))) {
      if (e.kind === "create" && e.receivedAt) creates.push({ name: e.name ?? "", symbol: e.symbol ?? "", receivedAt: e.receivedAt });
    }
  }
  const days = [...new Set(creates.map((c) => c.receivedAt.slice(0, 10)))].sort();
  const scorableDays = days.slice(1);
  const termsByDay = acceleratingTermsByDay(createsToDocs(creates), scorableDays);

  // Un « token » par série d'historique pour le scoring (nom/symbole/createdAt).
  const tokens: (CatalystToken & { at: string })[] = [];
  for (const [mint, series] of seriesByMint) {
    const first = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))[0];
    if (!first) continue;
    tokens.push({ mint, name: first.name ?? "", symbol: first.symbol ?? "", at: first.createdAt ?? first.fetchedAt });
  }
  const scores = scoreTokensWalkForward(
    tokens.filter((t) => scorableDays.includes(t.at.slice(0, 10))),
    termsByDay,
  );
  const catalystByMint = new Map<string, number>();
  for (const [mint, s] of scores) catalystByMint.set(mint, s.score);

  const comparison = runExitComparison({ seriesByMint, catalystByMint });

  // --- MFE par bucket catalyst : le catalyst prédit-il les gros multiples ? ---
  // MFE = plus haut prix observé après l'entrée / prix d'entrée (même règle
  // d'entrée que la comparaison H-EXIT : première obs liq ≥ 20 k$, exécution t+1).
  const mfeBuckets: Record<string, number[]> = { fort: [], autres: [] };
  for (const [mint, raw] of seriesByMint) {
    const series = [...raw].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const signalIdx = series.findIndex((s) => s.priceUsd > 0 && s.liquidityUsd >= 20_000);
    if (signalIdx === -1 || signalIdx + 2 >= series.length) continue;
    const entry = series[signalIdx + 1] as (typeof series)[number];
    if (entry.priceUsd <= 0) continue;
    let mfe = 0;
    for (let j = signalIdx + 2; j < series.length; j++) {
      const p = (series[j] as (typeof series)[number]).priceUsd;
      if (p > 0) mfe = Math.max(mfe, p / entry.priceUsd);
    }
    if (mfe <= 0) continue;
    const key = (catalystByMint.get(mint) ?? 0) >= 40 ? "fort" : "autres";
    (mfeBuckets[key] as number[]).push(mfe);
  }
  const mfeLine = (name: string, xs: number[]) =>
    xs.length >= 30
      ? `MFE bucket « ${name} » (n=${xs.length}) : médiane x${(q(xs, 0.5) as number).toFixed(2)}, P(MFE ≥ 2x) ${((xs.filter((x) => x >= 2).length / xs.length) * 100).toFixed(1)} %`
      : `MFE bucket « ${name} » : n=${xs.length} < 30 — NO ACTION.`;
  // `q` est défini plus bas (utilisé aussi par les stats robustes).

  const lines: string[] = [
    "Comparaison H-EXIT — scalp vs runner vs adaptatif (données réelles)",
    `Séries : ${seriesByMint.size} mints, ${comparison.skipped} écartées (liquidité/prix/données insuffisantes)`,
    `Adaptatif : ${comparison.adaptiveRunnerCount} runners / ${comparison.adaptiveScalpCount} scalps (seuil catalyst 40)`,
    "",
  ];
  const q = (xs: number[], p: number) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  // Stats robustes : la moyenne est dominée par les outliers (ex. +50 000x en
  // une barre = tick aberrant probable). On rapporte la médiane et la
  // concentration des gains sur le top 5 — SANS censurer les données.
  for (const v of ["scalp", "runner", "adaptive"] as ExitVariant[]) {
    const rets = comparison.variants[v].trades.map((t) => t.ret).sort((a, b) => a - b);
    const med: number | null = q(rets, 0.5) ?? null;
    const sum = rets.reduce((a, b) => a + b, 0);
    const top5 = [...rets].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
    const max1 = Math.max(...rets);
    lines.push(
      `>>> robustesse ${v} : médiane ${med === null ? "n/a" : (med * 100).toFixed(1) + " %"} | top-5 = ${sum !== 0 ? ((top5 / sum) * 100).toFixed(1) : "n/a"} % de la somme des rendements | max 1 trade x${(1 + max1).toFixed(0)}`,
    );
  }
  lines.push("");
  for (const v of ["scalp", "runner", "adaptive"] as ExitVariant[]) {
    lines.push(`=== variante ${v} ===`, formatReport(comparison.variants[v]), "");
  }
  lines.push(comparison.note, "", "--- MFE par bucket catalyst (même entrées) ---");
  lines.push(mfeLine("fort (score ≥ 40)", mfeBuckets["fort"] as number[]), mfeLine("autres", mfeBuckets["autres"] as number[]));
  return { text: lines.join("\n"), comparison, computedAt: new Date().toISOString() };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const { text, comparison, computedAt } = runExitComparisonReal(rootDir);
  const outDir = join(rootDir, "data", "backtests");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `exit-comparison-${computedAt.slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify({ computedAt, ...comparison }, null, 2));
  console.log(text);
  console.log(`\nRapport JSON : ${outPath}`);
}
