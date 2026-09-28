/**
 * SPRINT 2C — famille F : audit du champ `creator` dans data/scans
 * (hypothèse H-S2C-F1 : CREATOR_HISTORY_AS_OF_T0).
 *
 * La reconstruction de l'historique creator exige un champ creator /
 * deployer fiable dans les scans. S'il est absent, on ne l'invente PAS :
 * verdict DATA ISSUE avec mesure de ce qui manque.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCANS_DIR = "data/scans";
const HISTORY_DIR = "data/history";

export interface CreatorAudit {
  nScanFiles: number;
  nTokenRecords: number;
  /** Part des token records avec un champ creator/deployer non vide. */
  nWithCreator: number;
  /** Noms de champs contenant "creator"/"deployer" trouvés (tous scans). */
  creatorFieldNames: string[];
  /** Distribution des valeurs mintAuthority dans data/history. */
  mintAuthorityValues: Array<{ value: string; count: number }>;
  /** Exemple de clés d'un token record (pour documenter l'absence). */
  sampleKeys: string[];
}

const CREATOR_LIKE = /creator|deployer|authority/i;

function creatorValue(rec: Record<string, unknown>): unknown {
  for (const k of Object.keys(rec)) {
    if (CREATOR_LIKE.test(k) && k !== "mintAuthority" && k !== "freezeAuthority") {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  return null;
}

export function auditCreator(): CreatorAudit {
  const files = readdirSync(SCANS_DIR).filter((f) => f.endsWith(".json"));
  const fieldNames = new Set<string>();
  let nTokenRecords = 0;
  let nWithCreator = 0;
  let sampleKeys: string[] = [];
  for (const f of files) {
    let d: unknown;
    try {
      d = JSON.parse(readFileSync(join(SCANS_DIR, f), "utf-8"));
    } catch {
      continue;
    }
    const tokens = (d as { tokens?: unknown[] }).tokens;
    if (!Array.isArray(tokens)) continue;
    for (const t of tokens) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      nTokenRecords++;
      if (sampleKeys.length === 0) sampleKeys = Object.keys(rec).sort();
      for (const k of Object.keys(rec)) if (CREATOR_LIKE.test(k)) fieldNames.add(k);
      if (creatorValue(rec) != null) nWithCreator++;
    }
  }

  // mintAuthority dans data/history (première ligne de chaque jsonl).
  const authCounts = new Map<string, number>();
  const hfiles = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".jsonl"));
  for (const f of hfiles) {
    try {
      const first = readFileSync(join(HISTORY_DIR, f), "utf-8").split("\n")[0]!;
      const rec = JSON.parse(first) as Record<string, unknown>;
      const v = typeof rec.mintAuthority === "string" ? rec.mintAuthority : "(absent)";
      authCounts.set(v, (authCounts.get(v) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  const mintAuthorityValues = [...authCounts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  return {
    nScanFiles: files.length,
    nTokenRecords,
    nWithCreator,
    creatorFieldNames: [...fieldNames].sort(),
    mintAuthorityValues,
    sampleKeys,
  };
}
