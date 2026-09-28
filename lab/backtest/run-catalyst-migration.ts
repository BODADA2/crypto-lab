/**
 * Backtest H-NARR v2 (catalyst) sur données RÉELLES — walk-forward strict.
 *
 * Question : les tokens dont le nom/symbole chevauche un narratif en accélération
 * (score catalyst ≥ 40) migrent-ils plus souvent que la base ?
 *
 * Protocole :
 * - Entrées : événements `create` de data/scans/pump-AAAA-MM-JJ.jsonl
 *   (mint, name, symbol, receivedAt).
 * - Outcome : présence du mint dans les événements `migrate` de la fenêtre.
 * - Score : walk-forward — pour le jour D, les termes en accélération sont
 *   calculés UNIQUEMENT sur les créations strictement antérieures à D
 *   (cf. lab/signals/catalyst.ts). Aucun lookahead.
 * - Buckets : catalyst ≥ 40 (« fort ») / 1–39 (« faible ») / 0 (« aucun »).
 * - Règle n ≥ 30 par bucket : un bucket sous le seuil = NO ACTION pour lui.
 *
 * Biais connus (documentés, pas corrigés en silence) :
 * - les tokens créés en fin de fenêtre ont moins de temps pour migrer ;
 * - « migration » ≠ succès (un token peut migrer puis mourir) ;
 * - l'attention mesurée est celle des créateurs, pas celle de X/TikTok.
 *
 * Usage : `npx tsx lab/backtest/run-catalyst-migration.ts [racine]`
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceleratingTermsByDay,
  createsToDocs,
  scoreTokensWalkForward,
  type CatalystToken,
} from "../signals/catalyst.ts";
import { MIN_TRADES_FOR_CONCLUSION } from "./harness.ts";

interface CreateEvent {
  kind: string;
  mint: string;
  name?: string;
  symbol?: string;
  receivedAt?: string;
}

interface BucketStats {
  bucket: string;
  n: number;
  migrated: number;
  migrationRate: number | null;
  conclusive: boolean;
}

export interface CatalystMigrationReport {
  computedAt: string;
  windowDays: string[];
  creates: number;
  migrates: number;
  baselineMigrationRate: number | null;
  buckets: BucketStats[];
  /** lift du bucket « fort » vs base (null si non concluant). */
  liftStrongVsBaseline: number | null;
  verdict: string;
}

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

export function runCatalystMigrationBacktest(rootDir: string): CatalystMigrationReport {
  const scansDir = join(rootDir, "data", "scans");
  const files = existsSync(scansDir)
    ? readdirSync(scansDir)
        .filter((f) => /^pump-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
    : [];

  const seen = new Set<string>();
  const creates: (CatalystToken & { at: string })[] = [];
  const migrated = new Set<string>();
  for (const f of files) {
    for (const e of readJsonl<CreateEvent>(join(scansDir, f))) {
      if (e.kind === "migrate" && e.mint) {
        migrated.add(e.mint);
        continue;
      }
      if (e.kind !== "create" || !e.mint || !e.receivedAt || seen.has(e.mint)) continue;
      seen.add(e.mint);
      creates.push({ mint: e.mint, name: e.name ?? "", symbol: e.symbol ?? "", at: e.receivedAt });
    }
  }

  const days = [...new Set(creates.map((c) => c.at.slice(0, 10)))].sort();
  // Le premier jour n'a pas de passé : pas de score walk-forward possible.
  const scorableDays = days.slice(1);
  const docs = createsToDocs(creates.map((c) => ({ name: c.name, symbol: c.symbol, receivedAt: c.at })));
  const termsByDay = acceleratingTermsByDay(docs, scorableDays);
  const scores = scoreTokensWalkForward(
    creates.filter((c) => scorableDays.includes(c.at.slice(0, 10))),
    termsByDay,
  );

  const buckets: Record<string, { n: number; migrated: number }> = {
    fort: { n: 0, migrated: 0 },
    faible: { n: 0, migrated: 0 },
    aucun: { n: 0, migrated: 0 },
  };
  let totalMigrated = 0;
  for (const [mint, s] of scores) {
    const key = s.score >= 40 ? "fort" : s.score > 0 ? "faible" : "aucun";
    const b = buckets[key] as { n: number; migrated: number };
    b.n += 1;
    if (migrated.has(mint)) {
      b.migrated += 1;
      totalMigrated += 1;
    }
  }

  const n = scores.size;
  const baseline = n > 0 ? totalMigrated / n : null;
  const bucketStats: BucketStats[] = (Object.entries(buckets) as [string, { n: number; migrated: number }][]).map(
    ([bucket, b]) => ({
      bucket,
      n: b.n,
      migrated: b.migrated,
      migrationRate: b.n > 0 ? b.migrated / b.n : null,
      conclusive: b.n >= MIN_TRADES_FOR_CONCLUSION,
    }),
  );
  const strong = bucketStats.find((b) => b.bucket === "fort")!;
  const lift =
    strong.conclusive && strong.migrationRate !== null && baseline !== null && baseline > 0
      ? strong.migrationRate / baseline
      : null;

  const verdict = !strong.conclusive
    ? `NO ACTION : bucket « fort » n=${strong.n} < ${MIN_TRADES_FOR_CONCLUSION} — échantillon insuffisant, aucune conclusion sur le catalyst.`
    : lift !== null && lift > 1
      ? `Bucket « fort » (n=${strong.n}) : taux de migration x${lift.toFixed(2)} vs base — signal catalyst à creuser en paper, pas une preuve.`
      : `Bucket « fort » (n=${strong.n}) : pas de sur-migration vs base (lift ${lift?.toFixed(2) ?? "n/a"}) — le catalyst seul ne prédit pas la migration ici.`;

  return {
    computedAt: new Date().toISOString(),
    windowDays: days,
    creates: n,
    migrates: totalMigrated,
    baselineMigrationRate: baseline,
    buckets: bucketStats,
    liftStrongVsBaseline: lift,
    verdict,
  };
}

export function formatCatalystReport(r: CatalystMigrationReport): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(2)} %`);
  const lines = [
    `Backtest catalyst → migration (walk-forward, données réelles)`,
    `Fenêtre : ${r.windowDays.join(", ")} — ${r.creates} créations scorées, ${r.migrates} migrations observées`,
    `Taux de migration de base : ${pct(r.baselineMigrationRate)}`,
    ...r.buckets.map(
      (b) =>
        `- bucket « ${b.bucket} » : n=${b.n}, migrés=${b.migrated}, taux ${pct(b.migrationRate)}${b.conclusive ? "" : " (NON CONCLUANT, n < 30)"}`,
    ),
    `Lift « fort » vs base : ${r.liftStrongVsBaseline === null ? "n/a" : "x" + r.liftStrongVsBaseline.toFixed(2)}`,
    r.verdict,
  ];
  return lines.join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const report = runCatalystMigrationBacktest(rootDir);
  const outDir = join(rootDir, "data", "backtests");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `catalyst-migration-${report.computedAt.slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(formatCatalystReport(report));
  console.log(`\nRapport JSON : ${outPath}`);
}
