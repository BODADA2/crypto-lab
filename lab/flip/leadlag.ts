/**
 * FLIP ENGINE — Branch B, Sprint 1 — H-FLIP-10 : lead-lag inter-venues.
 *
 * Méthode : pour chaque cascade détectée sur Binance (5m), on cherche le creux
 * (E1 : min low ; E2 : max high) sur chaque venue dans ±windowMin autour de
 * l'événement, sur des barres 5m alignées. lag_s = t_creux_HL − t_creux_Binance.
 * lag > 0 → Binance mène ; lag < 0 → Hyperliquid mène.
 *
 * Caveat de résolution : barres 5m ⇒ lag quantifié par pas de 300 s ;
 * barres 1m ⇒ pas de 60 s. |lag| sous le seuil = indiscernable de 0.
 * Documenté, pas contourné.
 */
const HL = "https://api.hyperliquid.xyz/info";

export interface HLCandle { t: number; o: number; h: number; l: number; c: number; v: number; }

/** candleSnapshot HL 5m paginé (5000 bougies/req, poids 20).
 *  DATA ISSUE (2026-09-28) : l'historique 5m servi est limité aux ~5000 dernières
 *  bougies (~17j) — startTime ancien ignoré (retourne les plus récentes) et
 *  endTime ancien retourne []. Inutilisable pour le discovery. Conservé pour
 *  usage temps réel / fenêtres récentes uniquement. */
export async function fetchHLCandles(coin: string, startMs: number, endMs: number): Promise<HLCandle[]> {
  const out: HLCandle[] = [];
  let cursor = startMs;
  for (let page = 0; page < 60; page++) {
    const res = await fetch(HL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin, interval: "5m", startTime: cursor, endTime: endMs },
      }),
    });
    if (!res.ok) throw new Error(`HL candleSnapshot HTTP ${res.status}`);
    const arr = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
    if (arr.length === 0) break;
    for (const e of arr) {
      if (e.t < startMs || e.t > endMs) continue;
      const c = Number(e.c);
      if (!Number.isFinite(c) || c <= 0) continue;
      out.push({ t: e.t, o: Number(e.o), h: Number(e.h), l: Number(e.l), c, v: Number(e.v) });
    }
    const lastT = arr[arr.length - 1]!.t;
    if (lastT >= endMs || arr.length < 5000) break;
    cursor = lastT + 1;
    await new Promise((r) => setTimeout(r, 400));
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((r, i, a) => i === 0 || r.t !== a[i - 1]?.t);
}

export interface TroughHit { t: number; px: number; }

function findExtreme(
  bars: Array<{ t: number; l: number; h: number }>,
  tCenter: number,
  windowMin: number,
  dir: -1 | 1,
): TroughHit | null {
  const w = windowMin * 60_000;
  let best: TroughHit | null = null;
  for (const b of bars) {
    if (Math.abs(b.t - tCenter) > w) continue;
    const px = dir === -1 ? b.l : b.h;
    if (!Number.isFinite(px) || px <= 0) continue;
    if (!best || (dir === -1 ? px < best.px : px > best.px)) best = { t: b.t, px };
  }
  return best;
}

export interface LeadLagPoint {
  tCascade: number;
  type: "E1" | "E2";
  lagS: number | null; // (t_HL − t_Binance) en secondes ; null si creux introuvable
  tRef: number | null;
  tOther: number | null;
}

export interface BarLike { t: number; l: number; h: number; }

/**
 * Aligne les creux/pics autour de chaque cascade.
 * tCascadeRef = open de la barre de cascade (référence commune aux deux séries).
 * Générique : barres 5m, 1m, ou bougies HL.
 */
export function alignTroughs(
  cascades: Array<{ t: number; type: "E1" | "E2" }>,
  refBars: BarLike[],
  otherBars: BarLike[],
  windowMin = 30,
): LeadLagPoint[] {
  return cascades.map((c) => {
    const dir: -1 | 1 = c.type === "E1" ? -1 : 1;
    const b = findExtreme(refBars, c.t, windowMin, dir);
    const h = findExtreme(otherBars, c.t, windowMin, dir);
    if (!b || !h) return { tCascade: c.t, type: c.type, lagS: null, tRef: b?.t ?? null, tOther: h?.t ?? null };
    return { tCascade: c.t, type: c.type, lagS: (h.t - b.t) / 1000, tRef: b.t, tOther: h.t };
  });
}

export interface LeadLagSummary {
  n: number; // cascades communes avec lag mesuré
  nNull: number;
  medianLagS: number;
  iqrLagS: [number, number];
  refLeads: number; // lag > +discernS : la référence (perp) creuse en premier
  otherLeads: number; // lag < −discernS : l'autre série (spot) creuse en premier
  tied: number; // |lag| ≤ 300s (indiscernable)
  leaderShare: number; // max(refLeads, otherLeads) / (refLeads + otherLeads) ; NaN si 0
}

/** Résolution : seuil de discernabilité paramétrable (300 s pour barres 5m, 60 s pour 1m). */
export function summarizeLeadLag(points: LeadLagPoint[], discernS = 300): LeadLagSummary {
  const lags = points.map((p) => p.lagS).filter((x): x is number => x !== null);
  const nNull = points.length - lags.length;
  const sorted = [...lags].sort((a, b) => a - b);
  const q = (p: number) => {
    if (!sorted.length) return NaN;
    const r = (p / 100) * (sorted.length - 1);
    const lo = sorted[Math.floor(r)]!, hi = sorted[Math.ceil(r)]!;
    return lo + (hi - lo) * (r - Math.floor(r));
  };
  const refLeads = lags.filter((l) => l > discernS).length;
  const otherLeads = lags.filter((l) => l < -discernS).length;
  const tied = lags.filter((l) => Math.abs(l) <= discernS).length;
  const decisive = refLeads + otherLeads;
  return {
    n: lags.length, nNull,
    medianLagS: q(50), iqrLagS: [q(25), q(75)],
    refLeads, otherLeads, tied,
    leaderShare: decisive ? Math.max(refLeads, otherLeads) / decisive : NaN,
  };
}
