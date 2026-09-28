/**
 * Hypothèse 5 — sniping pump.fun (docs/preregistration-memecoins.md). Données séparées dans `data-snipe/`.
 *
 * Pendant l'écoute PumpPortal (job de 10 min), un échantillon fixe des nouveaux tokens est suivi :
 *   - prix de départ p0 = état de la courbe juste après la création (vSolInBondingCurve ÷ vTokensInBondingCurve,
 *     en SOL par token) — le meilleur prix qu'un sniper puisse espérer ;
 *   - puis prix DexScreener (paire pump.fun, cotée en SOL) à +60 s et +300 s.
 * Aucune souscription payante, aucun achat : on observe seulement.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DexPair, DexScreenerClient } from "./dexscreener.ts";
import type { PumpEvent } from "./types.ts";

export const SNIPE_CHECKPOINTS_S = [60, 300] as const;
/** Marge avant la fin de la fenêtre d'écoute pour le dernier relevé. */
export const SNIPE_MARGIN_MS = 30_000;
export const SNIPE_MAX_PER_WINDOW = 40;

export interface SnipeCheck {
  /** Âge visé (s). */
  target: number;
  /** Âge réel au relevé (s). */
  age: number;
  /** Prix en SOL par token ; null = token absent de DexScreener. */
  p: number | null;
  liqUsd: number | null;
  buysM5: number | null;
  sellsM5: number | null;
}

export interface SnipeRecord {
  mint: string;
  symbol: string | null;
  createdAt: string;
  /** Prix de départ en SOL par token (courbe après l'achat du créateur). */
  p0: number;
  devBuySol: number | null;
  checks: SnipeCheck[];
}

/** Échantillon déterministe : ~1 token sur 4, choisi par l'adresse (aucun choix humain). */
export function inSample(mint: string): boolean {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return h % 4 === 0;
}

/** Prix de départ depuis un événement de création PumpPortal (null si les champs manquent). */
export function startPrice(ev: PumpEvent): number | null {
  const raw = (ev.raw ?? {}) as Record<string, unknown>;
  const vSol = Number(raw.vSolInBondingCurve);
  const vTok = Number(raw.vTokensInBondingCurve);
  if (Number.isFinite(vSol) && Number.isFinite(vTok) && vSol > 0 && vTok > 0) return vSol / vTok;
  return null;
}

/** Paire pump.fun (ou à défaut la plus liquide) cotée en SOL pour ce mint. */
export function pickSolPair(pairs: DexPair[], mint: string): DexPair | null {
  const mine = pairs.filter((p) => p.chainId === "solana" && p.baseToken.address === mint && p.quoteToken.symbol === "SOL");
  if (!mine.length) return null;
  return mine.find((p) => p.dexId === "pumpfun") ?? mine.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}

export interface SnipeTracker {
  onCreate(ev: PumpEvent): void;
  /** Relève les points dus ; à appeler toutes les ~20 s. */
  tick(): Promise<void>;
  /** Relève ce qui reste dû puis écrit les enregistrements complets. */
  finish(): Promise<{ written: number; tracked: number }>;
  readonly size: number;
}

export function createSnipeTracker(opts: { dex: DexScreenerClient; dataDir: string; windowEndMs: number; now?: () => number; max?: number }): SnipeTracker {
  const now = opts.now ?? (() => Date.now());
  const max = opts.max ?? SNIPE_MAX_PER_WINDOW;
  const recs = new Map<string, { rec: SnipeRecord; createdMs: number; pending: number[] }>();
  let busy = false;

  async function poll(force: boolean) {
    if (busy) return;
    busy = true;
    try {
      const t = now();
      const due = [...recs.values()].filter((r) => r.pending.length && (force || t - r.createdMs >= (r.pending[0] as number) * 1000));
      if (!due.length) return;
      let pairs: DexPair[] = [];
      try {
        pairs = await opts.dex.getPairsByTokens(due.map((r) => r.rec.mint));
      } catch {
        return; // réessayé au prochain passage
      }
      const at = now();
      for (const r of due) {
        const target = r.pending.shift() as number;
        const pair = pickSolPair(pairs, r.rec.mint);
        const p = pair?.priceNative !== undefined ? Number(pair.priceNative) : NaN;
        r.rec.checks.push({
          target,
          age: Math.round((at - r.createdMs) / 1000),
          p: Number.isFinite(p) && p > 0 ? p : null,
          liqUsd: pair?.liquidity?.usd ?? null,
          buysM5: pair?.txns?.m5?.buys ?? null,
          sellsM5: pair?.txns?.m5?.sells ?? null,
        });
      }
    } finally {
      busy = false;
    }
  }

  return {
    get size() {
      return recs.size;
    },
    onCreate(ev) {
      if (ev.kind !== "create" || recs.size >= max || recs.has(ev.mint) || !inSample(ev.mint)) return;
      const createdMs = Date.parse(ev.receivedAt);
      const last = SNIPE_CHECKPOINTS_S[SNIPE_CHECKPOINTS_S.length - 1] as number;
      if (!Number.isFinite(createdMs) || createdMs + last * 1000 + SNIPE_MARGIN_MS > opts.windowEndMs) return;
      const p0 = startPrice(ev);
      if (p0 === null) return;
      recs.set(ev.mint, {
        rec: { mint: ev.mint, symbol: ev.symbol, createdAt: ev.receivedAt, p0, devBuySol: ev.solAmount, checks: [] },
        createdMs,
        pending: [...SNIPE_CHECKPOINTS_S],
      });
    },
    tick: () => poll(false),
    async finish() {
      // Les relevés déjà dus sont faits ; un relevé pas encore dû n'est jamais forcé (âge incorrect).
      await poll(false);
      const complete = [...recs.values()].filter((r) => r.pending.length === 0).map((r) => r.rec);
      if (complete.length) {
        mkdirSync(opts.dataDir, { recursive: true });
        const file = join(opts.dataDir, `snipes-${new Date(now()).toISOString().slice(0, 10)}.jsonl`);
        appendFileSync(file, complete.map((r) => JSON.stringify(r)).join("\n") + "\n");
      }
      return { written: complete.length, tracked: recs.size };
    },
  };
}
