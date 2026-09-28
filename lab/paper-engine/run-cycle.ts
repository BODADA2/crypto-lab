/**
 * CLI : exécute un cycle du moteur paper et écrit le rapport.
 *
 * Usage :
 *   npx tsx lab/paper-engine/run-cycle.ts --cycle 1 [--max-tokens 300] [--root .]
 *
 * Sorties :
 *   - data/paper-engine/decisions.jsonl (ledger append-only)
 *   - data/paper-engine/CHANGELOG.md (ajustements tracés)
 *   - docs/paper-engine-cycle-001.md (rapport §11)
 *
 * Aucune transaction réelle. Aucune modification du Risk Engine, de l'exécuteur,
 * de la politique ou des poids.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCycle } from "./cycle.ts";
import { ensureLedgerDir } from "./ledger.ts";
import { renderCycleReport } from "./report.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ? v : def;
}

const rootDir = resolve(arg("root", process.cwd()));
const cycleNum = arg("cycle", "1");
const cycleId = cycleNum.padStart(3, "0");
const maxTokens = parseInt(arg("max-tokens", "300"), 10);

ensureLedgerDir(rootDir);
const summary = runCycle({ rootDir, cycleId, maxTokens });
const report = renderCycleReport(summary);
const outPath = join(rootDir, "docs", `paper-engine-cycle-${cycleId}.md`);
writeFileSync(outPath, report + "\n");

console.log(`Cycle ${cycleId} terminé.`);
console.log(`  Régime : ${summary.marketRegime}${summary.halted ? " (HALT)" : ""}`);
console.log(`  Tokens analysés : ${summary.tokensAnalyzed} — éliminés : ${summary.eliminated.length}`);
console.log(`  Paper trades : ${summary.paperTrades} (${summary.wins} gains / ${summary.losses} pertes), NO_TRADE : ${summary.noTrades}`);
console.log(`  Rapport : ${outPath}`);
