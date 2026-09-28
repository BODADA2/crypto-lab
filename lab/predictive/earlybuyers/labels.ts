/**
 * Phase 2 — labels futurs (distribution du token APRÈS t0).
 *
 *  - y1h / y6h / y24h : rendements futurs via universe.futureReturns
 *    (prix nettoyés des ticks aberrants ; null si horizon non couvert) ;
 *  - ddMax24h : min(prix_nettoyé / prix_t0 - 1) sur (t0, t0+24h], ticks
 *    aberrants ignorés (aberrantMask) ; null si < 3 ticks couvrent la fenêtre ;
 *  - dd30_24h / dd50_24h / dd80_24h : ddMax24h <= -0.30 / -0.50 / -0.80 ;
 *  - survival_X_24h = !ddX_24h.
 *
 * DATA_ERROR permanent : le mint SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3
 * (glitch DexScreener : 192 $ → 0,0038 $ → 192 $, soit +4 939 704 %) est exclu
 * du calcul principal : tous ses labels = null + flag dataError = true.
 * L'analyse secondaire WITH_VALID_EXTREME_EVENTS (run.ts) ré-inclut ces mints
 * pour mesurer l'effet de l'outlier — jamais comme mesure principale.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenSnapshot } from "../../types.ts";
import {
  aberrantMask,
  findT0,
  futureReturns,
  HORIZON_LABELS,
  HORIZONS_MS,
  splitUniverse,
} from "../universe.ts";
import type { Labels } from "./types.ts";

/** Mints dont les prix sont corrompus (glitch de données connu). */
export const DATA_ERROR_MINTS: ReadonlySet<string> = new Set([
  "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3",
]);

const H24 = 24 * 3_600_000;

function readSeries(mint: string): TokenSnapshot[] | null {
  try {
    const raw = readFileSync(join("data/history", `${mint}.jsonl`), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;
    return lines.map((l) => JSON.parse(l) as TokenSnapshot);
  } catch {
    return null;
  }
}

function nullLabels(
  mint: string,
  t0ms: number,
  dataError: boolean,
): Labels {
  return {
    mint,
    universe: splitUniverse(mint),
    t0ms,
    y1h: null,
    y6h: null,
    y24h: null,
    ddMax24h: null,
    dd30_24h: null,
    dd50_24h: null,
    dd80_24h: null,
    survival_30_24h: null,
    survival_50_24h: null,
    survival_80_24h: null,
    dataError,
  };
}

export function computeLabels(
  mint: string,
  opts: { includeDataError?: boolean } = {},
): Labels {
  const series = readSeries(mint);
  const universe = splitUniverse(mint);
  const isDataError = DATA_ERROR_MINTS.has(mint);
  if (isDataError && !opts.includeDataError) {
    // Labels neutralisés : le glitch ne doit contaminer aucune mesure principale.
    return nullLabels(mint, 0, true);
  }
  if (!series) return nullLabels(mint, 0, false);
  const sorted = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0idx = findT0(sorted);
  if (t0idx < 0) return nullLabels(mint, 0, isDataError);
  const t0ms = Date.parse(sorted[t0idx]!.fetchedAt);
  const t0price = sorted[t0idx]!.priceUsd;
  const mask = aberrantMask(sorted);

  // Rendements futurs (prix nettoyés).
  const fr = futureReturns(sorted, HORIZONS_MS);
  const yByHorizon = new Map<number, number>();
  for (const r of fr) yByHorizon.set(r.horizonMs, r.ret);
  const y = (h: number): number | null => yByHorizon.get(h) ?? null;

  // Drawdown max sur (t0, t0+24h], ticks aberrants ignorés.
  const inWindow: number[] = [];
  for (let i = t0idx + 1; i < sorted.length; i++) {
    const t = Date.parse(sorted[i]!.fetchedAt);
    if (t <= t0ms || t > t0ms + H24) continue;
    if (mask[i]) continue; // tick aberrant ignoré (ex. glitch)
    const p = sorted[i]!.priceUsd;
    if (p <= 0) continue;
    inWindow.push(p / t0price - 1);
  }
  const ddMax24h = inWindow.length >= 3 ? Math.min(...inWindow) : null;
  const dd = (thr: number): boolean | null =>
    ddMax24h == null ? null : ddMax24h <= thr;
  const dd30 = dd(-0.3);
  const dd50 = dd(-0.5);
  const dd80 = dd(-0.8);

  return {
    mint,
    universe,
    t0ms,
    y1h: y(HORIZONS_MS[0]!),
    y6h: y(HORIZONS_MS[1]!),
    y24h: y(HORIZONS_MS[2]!),
    ddMax24h,
    dd30_24h: dd30,
    dd50_24h: dd50,
    dd80_24h: dd80,
    survival_30_24h: dd30 == null ? null : !dd30,
    survival_50_24h: dd50 == null ? null : !dd50,
    survival_80_24h: dd80 == null ? null : !dd80,
    dataError: isDataError,
  };
}

export { HORIZON_LABELS };

/* ================================================================== */
/* Phase 2.2 — labels étendus (§6 spec, gelés 2026-09-28)               */
/*                                                                      */
/*  - graduated_7d : événement `migrate` observé dans                    */
/*    data/scans/pump-*.jsonl avec receivedAt dans (t0ms, t0ms+7j].      */
/*    Source = scans DexScreener (biaisée vers les tokens chauds) :      */
/*    l'absence d'événement = NON OBSERVÉ, pas une preuve de             */
/*    non-graduation (borne honnête).                                   */
/*  - death_liq_7d : liquidité < 1000 USD sur le dernier snapshot,       */
/*    uniquement si la série couvre ≥ 7j post-t0 (sinon null) ;          */
/*    liquidité 0 = inconnue (TokenSnapshot) → null.                     */
/*  - death_price_7d : prix < 1% du prix t0 sur le dernier tick           */
/*    non-aberrant, mêmes conditions de couverture (sinon null).         */
/*  - death_dd80_24h : ALIAS documenté de dd80_24h (définition de mort   */
/*    par drawdown sur la fenêtre 24h).                                  */
/*  - deathAgreement : les définitions de mort NON-NULL sont-elles       */
/*    d'accord ? (sensibilité aux définitions).                         */
/*                                                                      */
/* Tout le reste (Labels de base, DATA_ERROR_MINTS) est INCHANGÉ.        */
/* ================================================================== */

const D7 = 7 * 24 * 3_600_000;
const DEATH_LIQ_USD = 1000;
const DEATH_PRICE_FRAC = 0.01;

/**
 * Lecteur LOCAL des temps de migration (ne pas importer
 * lab/signals/run-earlybuyers.ts — séparation collecte/recherche).
 * Retourne, par mint, TOUS les receivedAt (ms) des événements `migrate`
 * trouvés dans scansDir/pump-*.jsonl, triés croissants.
 */
export function readMigrationTimes(scansDir: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let files: string[] = [];
  try {
    files = readdirSync(scansDir)
      .filter((f) => f.startsWith("pump-") && f.endsWith(".jsonl"))
      .sort();
  } catch {
    return out; // répertoire absent : carte vide, jamais d'exception
  }
  for (const f of files) {
    let lines: string[];
    try {
      lines = readFileSync(join(scansDir, f), "utf-8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as {
          kind?: unknown;
          mint?: unknown;
          receivedAt?: unknown;
        };
        if (ev.kind !== "migrate") continue;
        if (typeof ev.mint !== "string" || typeof ev.receivedAt !== "string")
          continue;
        const t = Date.parse(ev.receivedAt);
        if (Number.isNaN(t)) continue;
        const arr = out.get(ev.mint) ?? [];
        arr.push(t);
        out.set(ev.mint, arr);
      } catch {
        // Ligne corrompue : ignorée (jamais d'exception sur données sales).
      }
    }
  }
  for (const arr of out.values()) arr.sort((a, b) => a - b);
  return out;
}

/**
 * Règle de graduation pure (testable) : true si ≥1 temps de migration
 * dans (t0ms, t0ms+7j] ; false si aucun ; null si t0ms inconnu
 * (t0ms <= 0 — la fenêtre serait dégénérée).
 */
export function graduatedFromMigrations(
  t0ms: number,
  migrationTimesMs: number[],
): boolean | null {
  if (!(t0ms > 0)) return null;
  for (const t of migrationTimesMs) {
    if (t > t0ms && t <= t0ms + D7) return true;
  }
  return false;
}

/**
 * Définitions de mort par liquidité / prix sur la série in-memory
 * (série TRIÉE par fetchedAt croissant). Pure et testable.
 *
 * Conditions communes : t0 trouvé (findT0) ET série couvrant ≥ 7j
 * post-t0 (maxFetchedAt - t0ms >= 7j). Sinon les deux = null.
 *  - death_liq_7d : dernier snapshot avec liquiditéUsd < 1000 USD ;
 *    liquidité <= 0 = inconnue → null.
 *  - death_price_7d : dernier tick (fetchedAt > t0ms, prix > 0,
 *    non-aberrant) avec prix < 1% du prix t0 ; aucun → null.
 */
export function deathLabelsFromSeries(sorted: TokenSnapshot[]): {
  t0ms: number;
  death_liq_7d: boolean | null;
  death_price_7d: boolean | null;
} {
  const t0idx = findT0(sorted);
  if (t0idx < 0) return { t0ms: 0, death_liq_7d: null, death_price_7d: null };
  const t0ms = Date.parse(sorted[t0idx]!.fetchedAt);
  const t0price = sorted[t0idx]!.priceUsd;
  const maxT = Date.parse(sorted[sorted.length - 1]!.fetchedAt);
  if (!(maxT - t0ms >= D7)) {
    // Couverture insuffisante : on ne peut pas juger l'état à 7j.
    return { t0ms, death_liq_7d: null, death_price_7d: null };
  }
  // --- mort par liquidité : dernier snapshot de la série ---
  const lastLiq = sorted[sorted.length - 1]!.liquidityUsd;
  const death_liq_7d =
    lastLiq <= 0 ? null : lastLiq < DEATH_LIQ_USD;

  // --- mort par prix : dernier tick non-aberrant post-t0 ---
  const mask = aberrantMask(sorted);
  let death_price_7d: boolean | null = null;
  for (let i = sorted.length - 1; i > t0idx; i--) {
    const t = Date.parse(sorted[i]!.fetchedAt);
    if (t <= t0ms) continue;
    const p = sorted[i]!.priceUsd;
    if (p <= 0 || mask[i]) continue; // tick aberrant ou prix invalide : ignoré
    death_price_7d = t0price > 0 ? p < DEATH_PRICE_FRAC * t0price : null;
    break;
  }
  return { t0ms, death_liq_7d, death_price_7d };
}

/**
 * Durée (heures) jusqu'au premier passage sous -50% — entrée du Cox PH.
 * Événement : premier tick nettoyé (non-aberrant) de (t0, t0+24h] avec
 * prix/t0price - 1 <= -0.50. Censure : min(t0+24h, dernier tick de la
 * fenêtre). null si < 3 ticks exploitables dans la fenêtre (même règle
 * que ddMax24h — non observable).
 */
export function dd50TimeToEvent(
  mint: string,
): { tHours: number; event: boolean } | null {
  const series = readSeries(mint);
  if (!series) return null;
  const sorted = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0idx = findT0(sorted);
  if (t0idx < 0) return null;
  const t0ms = Date.parse(sorted[t0idx]!.fetchedAt);
  const t0price = sorted[t0idx]!.priceUsd;
  if (!(t0price > 0)) return null;
  const mask = aberrantMask(sorted);
  const ticks: Array<{ t: number; ret: number }> = [];
  for (let i = t0idx + 1; i < sorted.length; i++) {
    const t = Date.parse(sorted[i]!.fetchedAt);
    if (t <= t0ms || t > t0ms + H24) continue;
    if (mask[i]) continue;
    const p = sorted[i]!.priceUsd;
    if (p <= 0) continue;
    ticks.push({ t, ret: p / t0price - 1 });
  }
  if (ticks.length < 3) return null;
  for (const tick of ticks) {
    if (tick.ret <= -0.5) {
      return { tHours: (tick.t - t0ms) / 3_600_000, event: true };
    }
  }
  const lastT = ticks[ticks.length - 1]!.t;
  return {
    tHours: Math.min((lastT - t0ms) / 3_600_000, H24 / 3_600_000),
    event: false,
  };
}

/** Labels étendus : base + graduation 7j + définitions de mort + accord. */
export interface ExtendedLabels extends Labels {
  /** Événement migrate observé dans (t0ms, t0ms+7j] ; null si t0 inconnu. */
  graduated_7d: boolean | null;
  /** Liquidité < 1000 USD au dernier snapshot (série ≥ 7j post-t0). */
  death_liq_7d: boolean | null;
  /** Prix < 1% du prix t0 au dernier tick non-aberrant (série ≥ 7j). */
  death_price_7d: boolean | null;
  /** ALIAS documenté de dd80_24h (mort par drawdown, fenêtre 24h). */
  death_dd80_24h: boolean | null;
  /**
   * Sensibilité aux définitions : defs = noms des définitions non-null
   * évaluées ; agree = sont-elles toutes d'accord ? null si < 2
   * définitions non-null (pas de comparaison possible).
   */
  deathAgreement: { defs: string[]; agree: boolean | null };
}

const DEATH_DEF_NAMES = ["death_liq_7d", "death_price_7d", "death_dd80_24h"] as const;

/**
 * Sensibilité aux définitions (pure, testable) : les définitions NON-NULL
 * sont-elles d'accord ? defs = noms des définitions non-null évaluées ;
 * agree = null si < 2 définitions non-null.
 */
export function computeDeathAgreement(
  defs: Array<{ name: string; v: boolean | null }>,
): { defs: string[]; agree: boolean | null } {
  const nonNull = defs.filter((d) => d.v != null);
  return {
    defs: nonNull.map((d) => d.name),
    agree:
      nonNull.length < 2
        ? null
        : nonNull.every((d) => d.v === nonNull[0]!.v),
  };
}

export function computeExtendedLabels(
  mint: string,
  opts: {
    includeDataError?: boolean;
    /** Répertoire des scans (défaut : data/scans). */
    scansDir?: string;
    /** Carte pré-chargée (évite de relire les scans à chaque mint). */
    migrationTimes?: Map<string, number[]>;
  } = {},
): ExtendedLabels {
  const base = computeLabels(mint, { includeDataError: opts.includeDataError });
  const migMap =
    opts.migrationTimes ?? readMigrationTimes(opts.scansDir ?? "data/scans");

  if (base.dataError || !(base.t0ms > 0)) {
    // Labels neutralisés (glitch) ou t0 inconnu : extensions = null.
    return {
      ...base,
      graduated_7d: null,
      death_liq_7d: null,
      death_price_7d: null,
      death_dd80_24h: base.dd80_24h, // alias : null ici aussi
      deathAgreement: { defs: [], agree: null },
    };
  }

  const graduated_7d = graduatedFromMigrations(
    base.t0ms,
    migMap.get(mint) ?? [],
  );

  const series = readSeries(mint);
  let death_liq_7d: boolean | null = null;
  let death_price_7d: boolean | null = null;
  if (series) {
    const sorted = [...series].sort((a, b) =>
      a.fetchedAt.localeCompare(b.fetchedAt),
    );
    const dl = deathLabelsFromSeries(sorted);
    death_liq_7d = dl.death_liq_7d;
    death_price_7d = dl.death_price_7d;
  }

  const death_dd80_24h: boolean | null = base.dd80_24h; // alias documenté
  const deathAgreement = computeDeathAgreement([
    { name: DEATH_DEF_NAMES[0], v: death_liq_7d },
    { name: DEATH_DEF_NAMES[1], v: death_price_7d },
    { name: DEATH_DEF_NAMES[2], v: death_dd80_24h },
  ]);
  return {
    ...base,
    graduated_7d,
    death_liq_7d,
    death_price_7d,
    death_dd80_24h,
    deathAgreement,
  };
}
