/**
 * Extraction des variables X (wallet behavior / early buyers) à t0 / pré-t0.
 * Toutes les valeurs sont recomputées depuis buyers[] ; les métriques du
 * fichier servent de garde-fou (écart > 1e-6 => null + flag, jamais inventé).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EarlyBuyersFile,
  WalletFeatures,
} from "./types.ts";
import { ARRIVAL_RANK_N } from "./types.ts";

/** Lecture tolérante : null si fichier incomplet (backfill en cours). */
export function readEarlyBuyersFile(filePath: string): EarlyBuyersFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof d["mint"] !== "string") return null;
  const buyersRaw = d["buyers"];
  if (!Array.isArray(buyersRaw) || buyersRaw.length < 2) return null;
  const buyers = buyersRaw
    .filter(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && typeof (b as Record<string, unknown>)["wallet"] === "string",
    )
    .map((b) => ({
      wallet: String(b["wallet"]),
      blockTime: typeof b["blockTime"] === "number" ? (b["blockTime"] as number) : null,
      slot: typeof b["slot"] === "number" ? (b["slot"] as number) : null,
      rank: typeof b["rank"] === "number" ? (b["rank"] as number) : 0,
      amountRaw: toBigInt(b["amountRaw"]),
    }));
  if (buyers.length < 2) return null;

  const m = d["metrics"] as Record<string, unknown> | undefined;
  const s = d["sells"] as Record<string, unknown> | undefined;
  const metrics =
    m && typeof m["buyerCount"] === "number"
      ? {
          buyerCount: m["buyerCount"] as number,
          top5_share: numOrNull(m["top5_share"]),
          gini: numOrNull(m["gini"]),
          same_slot_max: numOrNull(m["same_slot_max"]),
          totalRaw: toBigInt(m["totalRaw"]),
          truncated: m["truncated"] === true,
        }
      : null;
  const details = Array.isArray(s?.["details"])
    ? (s!["details"] as unknown[])
        .filter(
          (x): x is Record<string, unknown> =>
            typeof x === "object" && x !== null,
        )
        .map((x) => ({
          wallet: String(x["wallet"] ?? ""),
          soldFrac: numOrNull(x["soldFrac"]) ?? 0,
          covered: x["covered"] === true,
        }))
    : [];
  const sells =
    s && typeof s["sellersOver50"] === "number"
      ? {
          windowSec: typeof s["windowSec"] === "number" ? (s["windowSec"] as number) : 300,
          walletsChecked: typeof s["walletsChecked"] === "number" ? (s["walletsChecked"] as number) : 0,
          walletsCovered: typeof s["walletsCovered"] === "number" ? (s["walletsCovered"] as number) : 0,
          sellersOver50: s["sellersOver50"] as number,
          details,
        }
      : null;

  return {
    mint: d["mint"] as string,
    buyers,
    metrics,
    sells,
    truncated: metrics?.truncated ?? (d["truncated"] === true),
  };
}

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v));
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  return 0n;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Gini des montants (0 = égalité parfaite). */
export function giniOf(amounts: bigint[]): number | null {
  if (amounts.length < 2) return null;
  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const total = sorted.reduce((a, b) => a + b, 0n);
  if (total === 0n) return null;
  const n = sorted.length;
  let num = 0n;
  for (let i = 0; i < n; i++) num += BigInt(2 * (i + 1) - n - 1) * sorted[i]!;
  // Gini = num / (n * total) ; calcul en flottant sur des BigInt sûrs.
  return Number(num) / (n * Number(total));
}

/** Part des top-N par montant (tri décroissant). */
export function topNAmountShare(amounts: bigint[], n: number): number | null {
  if (amounts.length === 0) return null;
  const sorted = [...amounts].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const total = sorted.reduce((a, b) => a + b, 0n);
  if (total === 0n) return null;
  const top = sorted.slice(0, n).reduce((a, b) => a + b, 0n);
  return Number(top) / Number(total);
}

/**
 * Calcule toutes les features X d'un token.
 * @param overlapSets map wallet -> nombre de tokens où le wallet apparaît
 *        (construite sur l'ensemble des fichiers ; statistique descriptive,
 *        aucun seuil appris => pas de fuite du lien X->Y).
 */
export function computeFeatures(
  file: EarlyBuyersFile,
  overlapSets: Map<string, number> | null,
): WalletFeatures {
  const byRank = [...file.buyers].sort((a, b) => a.rank - b.rank);
  const amounts = byRank.map((b) => b.amountRaw);

  // Garde-fous : top5_share et gini recomputés doivent matcher les metrics.
  const top5re = topNAmountShare(amounts, 5);
  const ginire = giniOf(amounts);
  const m = file.metrics;
  const top5Share =
    m?.top5_share != null && top5re != null && Math.abs(m.top5_share - top5re) < 1e-6
      ? m.top5_share
      : null;
  const gini =
    m?.gini != null && ginire != null && Math.abs(m.gini - ginire) < 1e-6 ? m.gini : null;

  // Vitesse d'arrivée : blockTime(rank N ou dernier) - blockTime(rank 0).
  const t0 = byRank[0]!.blockTime;
  const tN = byRank[Math.min(ARRIVAL_RANK_N, byRank.length - 1)]!.blockTime;
  const arrivalSpanSec = t0 != null && tN != null ? tN - t0 : null;

  const gaps: number[] = [];
  for (let i = 1; i < byRank.length; i++) {
    const a = byRank[i - 1]!.blockTime;
    const b = byRank[i]!.blockTime;
    if (a != null && b != null) gaps.push(b - a);
  }
  gaps.sort((x, y) => x - y);
  const medianInterArrivalSec =
    gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : null;

  // Overlap inter-tokens : part des buyers vus sur >=2 tokens du dataset.
  let overlapFrac: number | null = null;
  if (overlapSets) {
    const wallets = new Set(byRank.map((b) => b.wallet));
    let seen = 0;
    for (const w of wallets) if ((overlapSets.get(w) ?? 0) >= 2) seen++;
    overlapFrac = wallets.size > 0 ? seen / wallets.size : null;
  }

  // Rétention : soldFrac médian des wallets couverts à +5 min post-migration.
  let medianSoldFrac: number | null = null;
  let sellersOver50: number | null = null;
  if (file.sells) {
    sellersOver50 = file.sells.sellersOver50;
    const covered = file.sells.details
      .filter((d) => d.covered)
      .map((d) => d.soldFrac)
      .sort((a, b) => a - b);
    medianSoldFrac =
      covered.length > 0 ? covered[Math.floor(covered.length / 2)]! : null;
  }

  return {
    mint: file.mint,
    buyerCount: byRank.length,
    top5Share,
    gini,
    sameSlotMax: m?.same_slot_max ?? null,
    arrivalSpanSec,
    medianInterArrivalSec,
    top1AmountShare: topNAmountShare(amounts, 1),
    overlapFrac,
    sellersOver50,
    medianSoldFrac,
    devHistory: null, // NON DISPONIBLE : aucun registre dev pré-calculé pour ces mints.
    truncated: file.truncated,
  };
}

/** Construit la map wallet -> nombre de tokens où il apparaît. */
export function buildOverlapMap(files: EarlyBuyersFile[]): Map<string, number> {
  const perToken = files.map((f) => new Set(f.buyers.map((b) => b.wallet)));
  const counts = new Map<string, number>();
  for (const set of perToken)
    for (const w of set) counts.set(w, (counts.get(w) ?? 0) + 1);
  return counts;
}

/** Liste les fichiers earlybuyers exploitables d'un répertoire. */
export function listEarlyBuyerFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .sort();
}
