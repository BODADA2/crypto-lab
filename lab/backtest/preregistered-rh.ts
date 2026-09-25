/**
 * Verdict PRÉ-ENREGISTRÉ de S1 (volume anormal) sur Robinhood Chain — voir docs/preregistration-memecoins.md,
 * section « Hypothèse 2 ». Mêmes règles, périodes, frais et critères que pour Solana (lab/backtest/preregistered.ts,
 * inchangé) ; seules les données diffèrent (data-rh/). S3 n'est pas évaluée : pas de migrations PumpPortal hors Solana.
 *
 * Usage : npx tsx lab/backtest/preregistered-rh.ts [dossier-data-rh] [--now ISO]
 * Écrit reports/verdict-memecoins-robinhood-YYYY-MM-DD.md et l'affiche.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, formatVerdict } from "./preregistered.ts";

export function evaluateRobinhood(dataDir: string) {
  const r = evaluate(dataDir);
  return { ...r, verdicts: r.verdicts.filter((v) => v.id.startsWith("s1-volume@")) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "data-rh");
  const nowIdx = process.argv.indexOf("--now");
  const now = nowIdx > 0 && process.argv[nowIdx + 1] ? new Date(process.argv[nowIdx + 1] as string) : new Date();
  const text = formatVerdict(evaluateRobinhood(dataDir), now).replace(
    "# Verdict pré-enregistré — stratégies memecoins",
    "# Verdict pré-enregistré — S1 sur Robinhood Chain",
  );
  mkdirSync("reports", { recursive: true });
  const out = join("reports", `verdict-memecoins-robinhood-${now.toISOString().slice(0, 10)}.md`);
  writeFileSync(out, text + "\n");
  console.log(text);
  console.log(`\n→ ${out}`);
}
