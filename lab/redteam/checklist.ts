// Red team codé (chantier 4) — les vérifications de la section 9 du mandat comme fonctions pures.
//
// Entrées : instantané du token (lab/types.ts), signaux + cross-check (lab/signals/crosscheck.ts), preuves
// complémentaires (RedteamEvidence : ce que l'instantané ne contient pas encore — wash trading, bots, LP, taxes…).
// Sortie : un item par vérification { id, status: OK | WARN | VETO | UNKNOWN, evidence } et un verdict global.
//
// Règles de verdict :
//   - un VETO, quel que soit l'item, → NO_TRADE ;
//   - un UNKNOWN sur un critère DUR (autorités, extensions, concentration, honeypot, liquidité) → NO_TRADE aussi :
//     ne pas savoir si on peut vendre, c'est ne pas pouvoir acheter ;
//   - sinon WARN s'il y a au moins un WARN ou un UNKNOWN doux, sinon OK.
//
// Levée du veto : UNIQUEMENT par `humanOverride: { by, reason, ts }` passé à l'appel — jamais par un champ d'un fichier
// du dépôt. Et même levé ici, le veto ne lève RIEN sur la machine d'Hervé : l'exécuteur reconstruit son propre
// instantané et le Risk Engine (lab/risk/engine.ts) re-vérifie autorités, extensions, top 10 et liquidité avec la
// politique locale, qui ignore `humanOverride`. La seule façon d'exécuter malgré un critère dur est de changer la
// politique locale à la main. Ce module protège l'analyse ; le Risk Engine protège le capital.

import type { TokenSnapshot } from "../types.ts";
import type { CrossCheckResult, SignalInput } from "../signals/crosscheck.ts";

export type CheckStatus = "OK" | "WARN" | "VETO" | "UNKNOWN";

export const CHECK_IDS = [
  "insiders",
  "linkedWallets",
  "concentration",
  "washTrading",
  "artificialVolume",
  "bots",
  "artificialLiquidity",
  "honeypot",
  "taxes",
  "mintFreezeAuthority",
  "contractExtensions",
  "rugRisk",
  "fakeEngagement",
  "socialManipulation",
  "narrativeExhausted",
  "pumpTooAdvanced",
  "holderDistribution",
  "contradictoryInfo",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

/** Critères DURS : VETO ou UNKNOWN = NO_TRADE. Ce sont aussi ceux que le Risk Engine re-vérifie localement. */
export const HARD_CHECKS: readonly CheckId[] = ["mintFreezeAuthority", "contractExtensions", "concentration", "honeypot", "artificialLiquidity"];

export interface CheckItem {
  id: CheckId;
  label: string;
  status: CheckStatus;
  evidence: string;
  hard: boolean;
}

/** Preuves complémentaires (toutes optionnelles ; absentes = UNKNOWN sur l'item concerné). Parts en fraction 0..1. */
export interface RedteamEvidence {
  /** Part de l'offre achetée dans les premiers blocs par des wallets liés au déployeur. */
  insiderSupplyShare?: number;
  /** Part de l'offre détenue par des wallets financés depuis une même source. */
  linkedWalletsSupplyShare?: number;
  washTradingShare?: number;
  botTradeShare?: number;
  /** Nombre de traders uniques sur 24 h. */
  uniqueTraders24h?: number;
  /** Part de la liquidité verrouillée ou brûlée. */
  lpLockedShare?: number;
  /** Achats et ventes OBSERVÉS (transactions réussies) sur la fenêtre récente. */
  buysObserved?: number;
  sellsObserved?: number;
  /** Taxe de transfert en points de base (0 = aucune). */
  transferTaxBps?: number;
  /** Part de l'offre détenue par le déployeur. */
  deployerSupplyShare?: number;
  /** Part d'engagement social attribuée à des bots / comptes neufs. */
  socialBotShare?: number;
  /** Promotion payante active (boost DexScreener, influenceurs payés). */
  paidPromotion?: boolean;
  narrativeAgeHours?: number;
  /** Accélération du narratif (taux 24 h / taux 7 j). */
  narrativeAccelRatio?: number;
  /** Variation de prix sur 24 h en % (ou depuis le plus bas récent). */
  priceChange24hPct?: number;
  /** Contradictions relevées entre sources (texte libre). */
  contradictions?: string[];
}

export interface RedteamThresholds {
  maxTop10Pct: number;
  minLiquidityUsd: number;
  maxTransferTaxBps: number;
  minHolders: number;
  warnHolders: number;
  maxPriceChange24hPct: number;
  warnPriceChange24hPct: number;
  maxNarrativeAgeHours: number;
  warnNarrativeAgeHours: number;
}

/** Seuils par défaut — alignés sur policy.example.json pour les critères durs. */
export const DEFAULT_THRESHOLDS: RedteamThresholds = {
  maxTop10Pct: 40,
  minLiquidityUsd: 20_000,
  maxTransferTaxBps: 500,
  minHolders: 30,
  warnHolders: 100,
  maxPriceChange24hPct: 300,
  warnPriceChange24hPct: 100,
  maxNarrativeAgeHours: 168,
  warnNarrativeAgeHours: 72,
};

export interface HumanOverride {
  by: string;
  reason: string;
  /** ISO 8601 avec fuseau ; doit dater de moins de 24 h et ne pas être dans le futur. */
  ts: string;
}

export interface RedteamInput {
  snapshot: TokenSnapshot | null | undefined;
  signals?: readonly SignalInput[];
  crossCheck?: CrossCheckResult | null;
  evidence?: RedteamEvidence;
  thresholds?: Partial<RedteamThresholds>;
  humanOverride?: HumanOverride;
}

export type RedteamVerdict = "OK" | "WARN" | "NO_TRADE";

export interface RedteamResult {
  verdict: RedteamVerdict;
  items: CheckItem[];
  vetoes: CheckId[];
  unknownHard: CheckId[];
  warnings: CheckId[];
  /** Vrai si un NO_TRADE a été levé par un humain (le verdict devient WARN, jamais OK). */
  overridden: boolean;
  override?: { by: string; reason: string; ts: string; lifted: CheckId[] };
  summary: string;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pct = (x: number): string => `${Math.round(x * 1000) / 10} %`;
const ISO_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

type Ctx = { s: TokenSnapshot | null; e: RedteamEvidence; t: RedteamThresholds; cc: CrossCheckResult | null; signals: readonly SignalInput[] };
type Check = { label: string; run: (c: Ctx) => { status: CheckStatus; evidence: string } };

const CHECKS: Record<CheckId, Check> = {
  insiders: {
    label: "insiders (premiers blocs, wallets liés au déployeur)",
    run: ({ e }) => {
      if (!num(e.insiderSupplyShare)) return { status: "UNKNOWN", evidence: "part insider inconnue (pas d'analyse des premiers blocs)" };
      const v = e.insiderSupplyShare;
      if (v > 0.3) return { status: "VETO", evidence: `insiders détiennent ${pct(v)} de l'offre > 30 %` };
      if (v > 0.1) return { status: "WARN", evidence: `insiders détiennent ${pct(v)} de l'offre > 10 %` };
      return { status: "OK", evidence: `insiders ${pct(v)} ≤ 10 %` };
    },
  },
  linkedWallets: {
    label: "wallets liés (même source de financement)",
    run: ({ e }) => {
      if (!num(e.linkedWalletsSupplyShare)) return { status: "UNKNOWN", evidence: "part des wallets liés inconnue" };
      const v = e.linkedWalletsSupplyShare;
      if (v > 0.25) return { status: "VETO", evidence: `wallets liés ${pct(v)} > 25 %` };
      if (v > 0.1) return { status: "WARN", evidence: `wallets liés ${pct(v)} > 10 %` };
      return { status: "OK", evidence: `wallets liés ${pct(v)} ≤ 10 %` };
    },
  },
  concentration: {
    label: "concentration (top 10)",
    run: ({ s, t }) => {
      if (!s || !num(s.top10Pct)) return { status: "UNKNOWN", evidence: "top10Pct absent" };
      if (s.top10Pct > t.maxTop10Pct) return { status: "VETO", evidence: `top 10 = ${s.top10Pct} % > ${t.maxTop10Pct} %` };
      if (s.top10Pct > t.maxTop10Pct * 0.75) return { status: "WARN", evidence: `top 10 = ${s.top10Pct} % (> 75 % du seuil ${t.maxTop10Pct})` };
      return { status: "OK", evidence: `top 10 = ${s.top10Pct} % ≤ ${t.maxTop10Pct} %` };
    },
  },
  washTrading: {
    label: "wash trading",
    run: ({ e }) => {
      if (!num(e.washTradingShare)) return { status: "UNKNOWN", evidence: "part de wash trading inconnue" };
      const v = e.washTradingShare;
      if (v > 0.5) return { status: "VETO", evidence: `wash trading ${pct(v)} > 50 %` };
      if (v > 0.2) return { status: "WARN", evidence: `wash trading ${pct(v)} > 20 %` };
      return { status: "OK", evidence: `wash trading ${pct(v)} ≤ 20 %` };
    },
  },
  artificialVolume: {
    label: "volume artificiel (volume / liquidité, volume / trader)",
    run: ({ s, e }) => {
      if (!s || !num(s.volume24h) || !num(s.liquidityUsd) || s.liquidityUsd <= 0) return { status: "UNKNOWN", evidence: "volume 24 h ou liquidité absents" };
      const ratio = s.volume24h / s.liquidityUsd;
      const perTrader = num(e.uniqueTraders24h) && e.uniqueTraders24h > 0 ? s.volume24h / e.uniqueTraders24h : null;
      if (ratio > 100) return { status: "VETO", evidence: `volume 24 h = ${Math.round(ratio)} × la liquidité (> 100)` };
      if (perTrader !== null && perTrader > 50_000) return { status: "VETO", evidence: `${Math.round(perTrader)} USD de volume par trader unique (> 50 k)` };
      if (ratio > 30) return { status: "WARN", evidence: `volume 24 h = ${Math.round(ratio)} × la liquidité (> 30)` };
      if (perTrader !== null && perTrader > 10_000) return { status: "WARN", evidence: `${Math.round(perTrader)} USD de volume par trader unique (> 10 k)` };
      return { status: "OK", evidence: `volume/liquidité ${ratio.toFixed(1)}${perTrader !== null ? `, ${Math.round(perTrader)} USD/trader` : ", traders uniques inconnus"}` };
    },
  },
  bots: {
    label: "bots (part des transactions automatisées)",
    run: ({ e }) => {
      if (!num(e.botTradeShare)) return { status: "UNKNOWN", evidence: "part des bots inconnue" };
      const v = e.botTradeShare;
      if (v > 0.7) return { status: "VETO", evidence: `bots ${pct(v)} des transactions > 70 %` };
      if (v > 0.4) return { status: "WARN", evidence: `bots ${pct(v)} > 40 %` };
      return { status: "OK", evidence: `bots ${pct(v)} ≤ 40 %` };
    },
  },
  artificialLiquidity: {
    label: "liquidité (seuil, verrouillage)",
    run: ({ s, e, t }) => {
      if (!s || !num(s.liquidityUsd)) return { status: "UNKNOWN", evidence: "liquidité absente" };
      if (s.liquidityUsd < t.minLiquidityUsd) return { status: "VETO", evidence: `liquidité ${s.liquidityUsd} USD < ${t.minLiquidityUsd}` };
      if (num(e.lpLockedShare) && e.lpLockedShare < 0.5) return { status: "WARN", evidence: `liquidité ${s.liquidityUsd} USD OK mais LP verrouillée à ${pct(e.lpLockedShare)} seulement` };
      if (!num(e.lpLockedShare)) return { status: "WARN", evidence: `liquidité ${s.liquidityUsd} USD ≥ ${t.minLiquidityUsd}, verrouillage LP inconnu` };
      return { status: "OK", evidence: `liquidité ${s.liquidityUsd} USD, LP verrouillée ${pct(e.lpLockedShare)}` };
    },
  },
  honeypot: {
    label: "honeypot (ventes observées)",
    run: ({ e }) => {
      if (!num(e.buysObserved) || !num(e.sellsObserved)) return { status: "UNKNOWN", evidence: "achats/ventes observés inconnus : impossible de prouver qu'on peut vendre" };
      if (e.buysObserved > 0 && e.sellsObserved === 0) return { status: "VETO", evidence: `${e.buysObserved} achats et AUCUNE vente observée` };
      if (e.buysObserved === 0 && e.sellsObserved === 0) return { status: "UNKNOWN", evidence: "aucune transaction observée" };
      if (e.sellsObserved < e.buysObserved * 0.05) return { status: "WARN", evidence: `${e.sellsObserved} ventes pour ${e.buysObserved} achats (< 5 %)` };
      return { status: "OK", evidence: `${e.sellsObserved} ventes observées pour ${e.buysObserved} achats` };
    },
  },
  taxes: {
    label: "taxes de transfert",
    run: ({ s, e, t }) => {
      if (num(e.transferTaxBps)) {
        if (e.transferTaxBps > t.maxTransferTaxBps) return { status: "VETO", evidence: `taxe ${e.transferTaxBps} bps > ${t.maxTransferTaxBps}` };
        if (e.transferTaxBps > 0) return { status: "WARN", evidence: `taxe ${e.transferTaxBps} bps` };
        return { status: "OK", evidence: "aucune taxe" };
      }
      if (s && Array.isArray(s.riskyExtensions)) {
        return s.riskyExtensions.some((x) => /fee|tax/i.test(x))
          ? { status: "VETO", evidence: `extension de taxe détectée : ${s.riskyExtensions.join(", ")}` }
          : { status: "OK", evidence: "aucune extension de taxe (RPC)" };
      }
      return { status: "UNKNOWN", evidence: "taxe inconnue" };
    },
  },
  mintFreezeAuthority: {
    label: "mint / freeze authority",
    run: ({ s }) => {
      if (!s || !("mintAuthority" in s) || !("freezeAuthority" in s)) return { status: "UNKNOWN", evidence: "autorités absentes de l'instantané" };
      const bad: string[] = [];
      if (s.mintAuthority) bad.push(`mint authority ${s.mintAuthority}`);
      if (s.freezeAuthority) bad.push(`freeze authority ${s.freezeAuthority}`);
      if (bad.length > 0) return { status: "VETO", evidence: bad.join(" ; ") };
      return { status: "OK", evidence: "mint et freeze authority révoquées" };
    },
  },
  contractExtensions: {
    label: "contrat / extensions Token-2022",
    run: ({ s }) => {
      if (!s || !Array.isArray(s.riskyExtensions)) return { status: "UNKNOWN", evidence: "extensions non vérifiées (riskyExtensions absent)" };
      if (s.riskyExtensions.length > 0) return { status: "VETO", evidence: `extensions dangereuses : ${s.riskyExtensions.join(", ")}` };
      return { status: "OK", evidence: "aucune extension dangereuse" };
    },
  },
  rugRisk: {
    label: "risque de rug (LP, déployeur)",
    run: ({ e }) => {
      if (!num(e.lpLockedShare) && !num(e.deployerSupplyShare)) return { status: "UNKNOWN", evidence: "LP et part du déployeur inconnues" };
      const notes: string[] = [];
      let status: CheckStatus = "OK";
      if (num(e.deployerSupplyShare)) {
        if (e.deployerSupplyShare > 0.3) return { status: "VETO", evidence: `déployeur détient ${pct(e.deployerSupplyShare)} > 30 %` };
        if (e.deployerSupplyShare > 0.1) { status = "WARN"; notes.push(`déployeur ${pct(e.deployerSupplyShare)} > 10 %`); } else notes.push(`déployeur ${pct(e.deployerSupplyShare)}`);
      } else notes.push("part du déployeur inconnue");
      if (num(e.lpLockedShare)) {
        if (e.lpLockedShare < 0.5) { status = "WARN"; notes.push(`LP verrouillée ${pct(e.lpLockedShare)} < 50 %`); } else notes.push(`LP verrouillée ${pct(e.lpLockedShare)}`);
      } else { status = "WARN"; notes.push("LP inconnue"); }
      return { status, evidence: notes.join(" ; ") };
    },
  },
  fakeEngagement: {
    label: "faux engagement (bots sociaux, comptes neufs)",
    run: ({ e }) => {
      if (!num(e.socialBotShare)) return { status: "UNKNOWN", evidence: "part de faux engagement inconnue" };
      const v = e.socialBotShare;
      if (v > 0.5) return { status: "VETO", evidence: `faux engagement ${pct(v)} > 50 %` };
      if (v > 0.25) return { status: "WARN", evidence: `faux engagement ${pct(v)} > 25 %` };
      return { status: "OK", evidence: `faux engagement ${pct(v)} ≤ 25 %` };
    },
  },
  socialManipulation: {
    label: "manipulation sociale (promotion payée, cause unique)",
    run: ({ e, cc }) => {
      const notes: string[] = [];
      let status: CheckStatus = "OK";
      if (e.paidPromotion === true) { status = "WARN"; notes.push("promotion payante active"); }
      if (cc) {
        const common = cc.warnings.filter((w) => w.startsWith("cause commune"));
        if (common.length > 0) { status = "WARN"; notes.push(...common); }
        if (cc.convergence <= 1 && cc.used.length >= 3) { status = "WARN"; notes.push(`${cc.used.length} signaux, ${cc.convergence} famille indépendante`); }
      }
      if (e.paidPromotion === undefined && !cc) return { status: "UNKNOWN", evidence: "ni promotion ni cross-check fournis" };
      return { status, evidence: notes.length > 0 ? notes.join(" ; ") : "aucune promotion payée détectée, causes indépendantes" };
    },
  },
  narrativeExhausted: {
    label: "narrative épuisée",
    run: ({ e, t }) => {
      if (!num(e.narrativeAgeHours) && !num(e.narrativeAccelRatio)) return { status: "UNKNOWN", evidence: "âge et accélération du narratif inconnus" };
      if (num(e.narrativeAgeHours) && e.narrativeAgeHours > t.maxNarrativeAgeHours) return { status: "VETO", evidence: `narratif vieux de ${e.narrativeAgeHours} h > ${t.maxNarrativeAgeHours}` };
      const notes: string[] = [];
      let status: CheckStatus = "OK";
      if (num(e.narrativeAgeHours) && e.narrativeAgeHours > t.warnNarrativeAgeHours) { status = "WARN"; notes.push(`narratif vieux de ${e.narrativeAgeHours} h > ${t.warnNarrativeAgeHours}`); }
      if (num(e.narrativeAccelRatio) && e.narrativeAccelRatio < 1) { status = "WARN"; notes.push(`accélération ${e.narrativeAccelRatio.toFixed(2)} < 1 (le terme ralentit)`); }
      return { status, evidence: notes.length > 0 ? notes.join(" ; ") : `narratif ${num(e.narrativeAgeHours) ? `${e.narrativeAgeHours} h` : "âge inconnu"}, accélération ${num(e.narrativeAccelRatio) ? e.narrativeAccelRatio.toFixed(2) : "inconnue"}` };
    },
  },
  pumpTooAdvanced: {
    label: "pump trop avancé",
    run: ({ e, t }) => {
      if (!num(e.priceChange24hPct)) return { status: "UNKNOWN", evidence: "variation 24 h inconnue" };
      if (e.priceChange24hPct > t.maxPriceChange24hPct) return { status: "VETO", evidence: `+${Math.round(e.priceChange24hPct)} % en 24 h > ${t.maxPriceChange24hPct} %` };
      if (e.priceChange24hPct > t.warnPriceChange24hPct) return { status: "WARN", evidence: `+${Math.round(e.priceChange24hPct)} % en 24 h > ${t.warnPriceChange24hPct} %` };
      return { status: "OK", evidence: `${Math.round(e.priceChange24hPct)} % en 24 h` };
    },
  },
  holderDistribution: {
    label: "distribution des holders",
    run: ({ s, t }) => {
      if (!s || !num(s.holders)) return { status: "UNKNOWN", evidence: "nombre de holders inconnu" };
      if (s.holders < t.minHolders) return { status: "VETO", evidence: `${s.holders} holders < ${t.minHolders}` };
      if (s.holders < t.warnHolders) return { status: "WARN", evidence: `${s.holders} holders < ${t.warnHolders}` };
      return { status: "OK", evidence: `${s.holders} holders` };
    },
  },
  contradictoryInfo: {
    label: "information contradictoire",
    run: ({ s, e, signals }) => {
      const found: string[] = [...(Array.isArray(e.contradictions) ? e.contradictions : [])];
      if (s) {
        if (num(s.volume24h) && s.volume24h > 0 && num(s.holders) && s.holders === 0) found.push("volume 24 h > 0 mais 0 holder");
        if (num(s.liquidityUsd) && s.liquidityUsd > 0 && (!num(s.priceUsd) || s.priceUsd <= 0)) found.push("liquidité > 0 mais prix ≤ 0");
        if (num(s.volume5m) && num(s.volume1h) && s.volume5m > s.volume1h) found.push("volume 5 min > volume 1 h");
        if (num(s.volume1h) && num(s.volume24h) && s.volume1h > s.volume24h) found.push("volume 1 h > volume 24 h");
      }
      const causes = new Map<string, Set<string>>();
      for (const sig of signals) {
        if (!sig || typeof sig.cause !== "string") continue;
        const set = causes.get(sig.id) ?? new Set();
        set.add(sig.cause);
        causes.set(sig.id, set);
      }
      for (const [id, set] of causes) if (set.size > 1) found.push(`signal ${id} déclaré avec ${set.size} causes différentes`);
      if (found.length >= 3) return { status: "VETO", evidence: found.join(" ; ") };
      if (found.length > 0) return { status: "WARN", evidence: found.join(" ; ") };
      return { status: "OK", evidence: "aucune contradiction relevée" };
    },
  },
};

function overrideProblems(o: HumanOverride | undefined, nowMs: number): string[] {
  if (!o) return ["absent"];
  const p: string[] = [];
  if (typeof o.by !== "string" || o.by.trim().length === 0) p.push("by manquant");
  if (typeof o.reason !== "string" || o.reason.trim().length < 10) p.push("reason manquante ou trop courte (≥ 10 caractères)");
  if (typeof o.ts !== "string" || !ISO_STRICT.test(o.ts) || Number.isNaN(Date.parse(o.ts))) p.push("ts invalide (ISO 8601 avec fuseau)");
  else {
    const t = Date.parse(o.ts);
    if (t > nowMs + 5 * 60_000) p.push("ts dans le futur");
    if (nowMs - t > 24 * 3600_000) p.push("override de plus de 24 h");
  }
  return p;
}

/** Exécute la checklist. Pure, ne lève jamais : une entrée absente donne UNKNOWN, jamais OK. */
export function runChecklist(input: RedteamInput, now: Date | string | number = 0): RedteamResult {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  const ctx: Ctx = {
    s: input && input.snapshot && typeof input.snapshot === "object" ? input.snapshot : null,
    e: input && input.evidence && typeof input.evidence === "object" ? input.evidence : {},
    t: { ...DEFAULT_THRESHOLDS, ...(input?.thresholds ?? {}) },
    cc: input?.crossCheck ?? null,
    signals: Array.isArray(input?.signals) ? input.signals : [],
  };
  const items: CheckItem[] = CHECK_IDS.map((id) => {
    const hard = HARD_CHECKS.includes(id);
    try {
      const r = CHECKS[id].run(ctx);
      return { id, label: CHECKS[id].label, status: r.status, evidence: r.evidence, hard };
    } catch (e) {
      return { id, label: CHECKS[id].label, status: "UNKNOWN", evidence: `erreur interne : ${(e as Error).message}`, hard };
    }
  });
  const vetoes = items.filter((i) => i.status === "VETO").map((i) => i.id);
  const unknownHard = items.filter((i) => i.hard && i.status === "UNKNOWN").map((i) => i.id);
  const warnings = items.filter((i) => i.status === "WARN" || (i.status === "UNKNOWN" && !i.hard)).map((i) => i.id);

  let verdict: RedteamVerdict = vetoes.length > 0 || unknownHard.length > 0 ? "NO_TRADE" : warnings.length > 0 ? "WARN" : "OK";
  let overridden = false;
  let override: RedteamResult["override"];
  const notes: string[] = [];
  if (verdict === "NO_TRADE" && input?.humanOverride !== undefined) {
    const problems = overrideProblems(input.humanOverride, Number.isFinite(nowMs) ? nowMs : 0);
    if (problems.length === 0) {
      overridden = true;
      verdict = "WARN"; // jamais OK : un veto levé reste visible
      override = { by: input.humanOverride.by.trim(), reason: input.humanOverride.reason.trim(), ts: input.humanOverride.ts, lifted: [...vetoes, ...unknownHard] };
      notes.push(`veto levé par ${override.by} (${override.ts}) : ${override.reason} — le Risk Engine local re-vérifiera les critères durs et IGNORE cette levée`);
    } else {
      notes.push(`humanOverride refusé : ${problems.join(", ")}`);
    }
  }
  const summary =
    `${verdict}${overridden ? " (veto levé par un humain)" : ""} — ${vetoes.length} VETO${vetoes.length ? ` (${vetoes.join(", ")})` : ""}, ` +
    `${unknownHard.length} UNKNOWN dur${unknownHard.length ? ` (${unknownHard.join(", ")})` : ""}, ${warnings.length} WARN/UNKNOWN doux` +
    (notes.length > 0 ? `. ${notes.join(". ")}` : "");
  return { verdict, items, vetoes, unknownHard, warnings, overridden, ...(override ? { override } : {}), summary };
}
