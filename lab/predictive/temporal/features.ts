/**
 * DOMAINE 5/5 — TEMPORAL STRUCTURE (phase DÉCOUVERTE).
 *
 * Variables X temporelles mesurées à t0 (ou pré-t0), en temps réel (ms) —
 * la cadence des snapshots est irrégulière, aucun pas de temps constant
 * n'est supposé.
 *
 * Question clé : ce qui prédit Y, est-ce le NIVEAU (prix haut, croissance
 * forte) ou la FORME (accélération, jeunesse) ? Les deux familles sont
 * testées séparément.
 *
 * Définitions (toutes à prix nettoyés des ticks aberrants) :
 * - agePairMs      : t0 − pairCreatedAt (null si pairCreatedAt null)
 * - ageTokenMs     : t0 − createdAt (null si illisible)
 * - growthPreT0PerH: pente log-prix/heure entre le premier snapshot valide
 *                    pré-t0 et t0  [NIVEAU : « croissance forte »]
 * - accelPerH2     : pente(log-prix/h) seconde moitié pré-t0→t0 MOINS pente
 *                    première moitié [FORME : accélération vs décélération]
 * - accelSign      : signe de accelPerH2
 * - interSnapMeanMs: durée moyenne entre snapshots pré-t0 [activité]
 * - hourUTC        : heure décimale UTC de t0 (effet session, cyclique)
 * - priceAtT0, liqAtT0 : niveau à t0 [NIVEAU]
 *
 * time-to-liquidity (create→t0) = agePairMs par définition : une seule
 * variable, pas deux (constaté, pas supposé — voir doc).
 */
import type { TokenSnapshot } from "../../types.ts";
import { aberrantMask, findT0 } from "../universe.ts";

const HOUR_MS = 3_600_000;
const MIN_DT_MS = 60_000; // pente exige ≥60 s d'écart (anti division par ~0)

export interface TemporalFeatures {
  mint: string;
  t0Time: number;
  nSnaps: number;
  nPreT0: number;
  agePairMs: number | null;
  ageTokenMs: number | null;
  growthPreT0PerH: number | null;
  accelPerH2: number | null;
  accelSign: -1 | 0 | 1 | null;
  interSnapMeanMs: number | null;
  hourUTC: number;
  priceAtT0: number;
  liqAtT0: number;
}

interface Pt {
  t: number;
  p: number;
}

function logSlope(a: Pt, b: Pt): number | null {
  const dtH = (b.t - a.t) / HOUR_MS;
  if (dtH * HOUR_MS < MIN_DT_MS || a.p <= 0 || b.p <= 0) return null;
  return (Math.log(b.p) - Math.log(a.p)) / dtH;
}

/** Variables temporelles d'une série. null si pas de t0 exploitable. */
export function temporalFeatures(series: TokenSnapshot[]): TemporalFeatures | null {
  if (series.length === 0) return null;
  const s = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0 = findT0(s);
  if (t0 < 0) return null;
  const mask = aberrantMask(s);
  if (mask[t0]) return null; // entrée corrompue : on ne mesure pas Y dessus
  const t0snap = s[t0]!;
  if (t0snap.priceUsd <= 0) return null;
  const t0Time = Date.parse(t0snap.fetchedAt);

  // Points pré-t0 valides (prix > 0, non aberrants), en ordre chronologique.
  const pre: Pt[] = [];
  for (let i = 0; i < t0; i++) {
    if (!mask[i] && s[i]!.priceUsd > 0) {
      pre.push({ t: Date.parse(s[i]!.fetchedAt), p: s[i]!.priceUsd });
    }
  }

  // Âges.
  const pairC = t0snap.pairCreatedAt;
  const agePairMs = pairC == null ? null : t0Time - pairC;
  const createdMs = Date.parse(t0snap.createdAt);
  const ageTokenMs = Number.isFinite(createdMs) ? t0Time - createdMs : null;

  // Croissance pré-t0 : premier point valide → t0.
  let growthPreT0PerH: number | null = null;
  if (pre.length > 0) {
    growthPreT0PerH = logSlope(pre[0]!, { t: t0Time, p: t0snap.priceUsd });
  }

  // Accélération : points pré-t0 + t0, ≥3 points requis.
  let accelPerH2: number | null = null;
  let accelSign: -1 | 0 | 1 | null = null;
  const withT0: Pt[] = [...pre, { t: t0Time, p: t0snap.priceUsd }];
  if (withT0.length >= 3) {
    const tMid = (withT0[0]!.t + withT0[withT0.length - 1]!.t) / 2;
    const first = withT0.filter((x) => x.t <= tMid);
    const second = withT0.filter((x) => x.t > tMid);
    if (first.length >= 2 && second.length >= 2) {
      const s1 = logSlope(first[0]!, first[first.length - 1]!);
      const s2 = logSlope(second[0]!, second[second.length - 1]!);
      if (s1 !== null && s2 !== null) {
        accelPerH2 = s2 - s1;
        accelSign = accelPerH2 > 0 ? 1 : accelPerH2 < 0 ? -1 : 0;
      }
    } else if (first.length >= 2 && second.length === 1) {
      // Cas limite : un seul point en 2e moitié — pente 1re moitié vs
      // segment (dernier point 1re moitié → point 2e moitié).
      const s1 = logSlope(first[0]!, first[first.length - 1]!);
      const s2 = logSlope(first[first.length - 1]!, second[0]!);
      if (s1 !== null && s2 !== null) {
        accelPerH2 = s2 - s1;
        accelSign = accelPerH2 > 0 ? 1 : accelPerH2 < 0 ? -1 : 0;
      }
    }
  }

  // Activité pré-t0 : durée moyenne entre snapshots (tous, même sans prix).
  let interSnapMeanMs: number | null = null;
  if (t0 >= 2) {
    const times: number[] = [];
    for (let i = 0; i <= t0; i++) times.push(Date.parse(s[i]!.fetchedAt));
    const diffs: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i]! - times[i - 1]!;
      if (d > 0) diffs.push(d);
    }
    if (diffs.length > 0) interSnapMeanMs = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  }

  const d = new Date(t0Time);
  const hourUTC = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;

  return {
    mint: t0snap.mint,
    t0Time,
    nSnaps: s.length,
    nPreT0: pre.length,
    agePairMs,
    ageTokenMs,
    growthPreT0PerH,
    accelPerH2,
    accelSign,
    interSnapMeanMs,
    hourUTC,
    priceAtT0: t0snap.priceUsd,
    liqAtT0: t0snap.liquidityUsd,
  };
}

/** Encodage cyclique de l'heure pour Spearman (effet session sans a priori). */
export function hourCyclic(hourUTC: number): { sin: number; cos: number } {
  const a = (2 * Math.PI * hourUTC) / 24;
  return { sin: Math.sin(a), cos: Math.cos(a) };
}
