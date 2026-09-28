/**
 * FLIP ENGINE — Branch B. Stockage JSONL sous data/flip/ (Branch B uniquement).
 * Lignes = tableaux JSON compacts [t, ...] pour limiter le volume.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const DATA_DIR = "/home/hatch/workspace/crypto-lab/repo/data/flip";

/** Écrit des lignes (tableaux) en JSONL (streaming, gros volumes). */
export function writeJsonl(name: string, rows: unknown[][]): Promise<string> {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = join(DATA_DIR, name);
  const ws = createWriteStream(p);
  for (const r of rows) ws.write(JSON.stringify(r) + "\n");
  return new Promise<string>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("finish", () => resolve(p));
    ws.end();
  });
}

/** Écrit de façon synchrone (petits volumes). */
export function writeJsonlSync(name: string, rows: unknown[][]): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = join(DATA_DIR, name);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return p;
}

/** Lit un JSONL → tableaux. */
export async function readJsonl(name: string): Promise<unknown[][]> {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) throw new Error(`JSONL manquant: ${p}`);
  const out: unknown[][] = [];
  const rl = createInterface({ input: (await import("node:fs")).createReadStream(p), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t) as unknown[]);
  }
  return out;
}

export function readJsonlSync(name: string): unknown[][] {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) throw new Error(`JSONL manquant: ${p}`);
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown[]);
}

export function writeJson(name: string, data: unknown): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = join(DATA_DIR, name);
  writeFileSync(p, JSON.stringify(data, null, 1));
  return p;
}
