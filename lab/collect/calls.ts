/**
 * Collecte des calls Telegram (hypothèses 3 et 4, docs/preregistration-memecoins.md) — dossier séparé `data-calls/`
 * pour ne pas toucher aux données des hypothèses 1 et 2.
 *
 *   npx tsx lab/collect/calls.ts
 *
 * 1. Lit l'aperçu public des canaux (CALL_CHANNELS, défaut « mad_apes_gambles ») → data-calls/calls.jsonl (nouveaux calls).
 * 2. Interroge DexScreener pour chaque call Solana / Robinhood Chain de moins de 7 jours, qu'il soit vivant ou mort
 *    → data-calls/history/<adresse>.jsonl (une ligne par observation, ~15 min).
 * Lecture seule : aucun compte Telegram, aucun message, aucun achat.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDexScreenerClient } from "./dexscreener.ts";
import { fetchChannelCalls, mergeNewCalls, type Call } from "./telegram.ts";
import type { FetchLike } from "./types.ts";

/** Durée de suivi d'un call après sa publication. */
export const CALL_TRACK_MS = 7 * 24 * 3_600_000;

export function readCalls(file: string): Call[] {
  if (!existsSync(file)) return [];
  const out: Call[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Call);
    } catch {
      /* ligne corrompue ignorée */
    }
  }
  return out;
}

/** Calls à interroger maintenant, par chaîne (fonction pure, testée). */
export function callsToPoll(calls: Call[], nowMs: number): { solana: string[]; robinhood: string[] } {
  const live = calls.filter((c) => nowMs - Date.parse(c.postedAt) <= CALL_TRACK_MS);
  return {
    solana: live.filter((c) => c.chain === "solana").map((c) => c.address),
    robinhood: live.filter((c) => c.chain === "robinhood").map((c) => c.address),
  };
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function runCalls(opts: { dataDir: string; channels: string[]; fetch?: FetchLike; now?: () => number }): Promise<{ newCalls: number; snapshots: number; errors: string[] }> {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
  mkdirSync(join(opts.dataDir, "history"), { recursive: true });
  const file = join(opts.dataDir, "calls.jsonl");
  const known = readCalls(file);
  const errors: string[] = [];
  const seenAt = new Date(now()).toISOString();

  let added: Call[] = [];
  for (const channel of opts.channels) {
    const mine = known.filter((c) => c.channel === channel);
    const since = mine.length ? Math.max(...mine.map((c) => c.postId)) : null;
    try {
      const found = await fetchChannelCalls(fetchImpl, channel, seenAt, since);
      added = added.concat(mergeNewCalls([...known, ...added], found));
    } catch (e) {
      errors.push(`telegram:${channel}: ${(e as Error).message}`);
    }
  }
  if (added.length) appendFileSync(file, added.map((c) => JSON.stringify(c)).join("\n") + "\n");

  const dex = createDexScreenerClient({ fetch: fetchImpl, now });
  const poll = callsToPoll([...known, ...added], now());
  let snapshots = 0;
  for (const chain of ["solana", "robinhood"] as const) {
    if (!poll[chain].length) continue;
    try {
      for (const snap of await dex.getSnapshots(poll[chain], chain)) {
        appendFileSync(join(opts.dataDir, "history", `${safeName(snap.mint)}.jsonl`), JSON.stringify(snap) + "\n");
        snapshots += 1;
      }
    } catch (e) {
      errors.push(`dexscreener:${chain}: ${(e as Error).message}`);
    }
  }
  const metaPath = join(opts.dataDir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ lastRunAt: seenAt, calls: known.length + added.length, newCalls: added.length, snapshots, errors }, null, 2) + "\n");
  return { newCalls: added.length, snapshots, errors };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = resolve(process.env.DATA_DIR ?? "data-calls");
  const channels = (process.env.CALL_CHANNELS ?? "mad_apes_gambles").split(",").map((s) => s.trim()).filter(Boolean);
  const res = await runCalls({ dataDir, channels });
  console.log(`Calls : ${res.newCalls} nouveaux, ${res.snapshots} observations DexScreener, ${res.errors.length} erreurs.`);
  if (res.errors.length) console.error(res.errors.join("\n"));
}
