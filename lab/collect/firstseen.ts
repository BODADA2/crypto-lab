/**
 * Index de première observation — H-FRESH (hypothèse issue de l'interview Deku, 2026-09-28).
 *
 * Deku : « I want to be the first person to scan it » — son edge inclut la vitesse
 * d'entrée sur les nouveaux pairs. Notre équivalent système : mesurer, pour chaque
 * mint, le délai entre la première observation (flux PumpPortal) et l'entrée simulée,
 * puis tester si « entrer tôt » bat « entrer tard » nette de slippage.
 *
 * Ce module construit l'index mint → première observation à partir des fichiers
 * `data/scans/pump-<date>.jsonl` existants (aucune modification du collecteur
 * PumpPortal requise : `receivedAt` est déjà enregistré par événement).
 *
 * Sortie : `data/firstseen.json` = { mint: ISO }.
 * Usage prévu : en backtest, simuler des entrées à +1 / +5 / +15 min après la
 * première observation et comparer l'espérance nette (H-FRESH).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPumpEvents } from "./devregistry.ts";

/**
 * Pour chaque mint vu en "create", l'horodatage ISO le plus ancien.
 * Fonction pure (testée) : prend des événements déjà filtrés.
 */
export function buildFirstSeen(receivedAts: Array<{ mint: string; receivedAt: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { mint, receivedAt } of receivedAts) {
    if (!mint || !receivedAt) continue;
    if (!out[mint] || receivedAt < out[mint]) out[mint] = receivedAt;
  }
  return out;
}

/** Délai en minutes entre la première observation et une entrée ; null si incalculable. */
export function entryDelayMinutes(firstSeenIso: string, entryIso: string): number | null {
  const a = Date.parse(firstSeenIso);
  const b = Date.parse(entryIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60_000;
}

export function writeFirstSeen(index: Record<string, string>, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ computedAt: new Date().toISOString(), count: Object.keys(index).length, firstSeen: index }, null, 2) + "\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = resolve(process.env.DATA_DIR ?? "data");
  const days = Number(process.env.FRESH_DAYS ?? 30);
  const nowMs = Date.now();
  const events = readPumpEvents(join(dataDir, "scans"), nowMs - days * 86_400_000, nowMs).filter((e) => e.kind === "create");
  const index = buildFirstSeen(events);
  const outPath = join(dataDir, "firstseen.json");
  writeFirstSeen(index, outPath);
  console.log(`First-seen : ${events.length} créations (${days} j) → ${Object.keys(index).length} mints → ${outPath}`);
}
