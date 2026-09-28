/**
 * H-NARR v2 — dimension « catalyst » du signal narratif.
 *
 * Origine : interviews Cupsey (2026-09-28) et Cented (2026-09-28).
 * - Cupsey : la fréquence d'un terme ne suffit pas ; il faut un catalyseur
 *   (compte qui lance, mention notable, viralité). « Attention + catalyst ».
 * - Cented : « every meme coin is a narrative… almost like catalyst or something
 *   like that — who could interact with this coin? » ; il achète le narratif bon
 *   « as fast as I can » et prédit le plafond du coin par la force du narratif.
 *
 * Proxy honnête avec nos données : un token a un « catalyst » mesurable quand les
 * termes de son nom/symbole chevauchent des termes EN ACCÉLÉRATION (24 h vs 7 j,
 * cf. lab/signals/narrative.ts) calculés SANS lookahead (walk-forward).
 * On ne dispose ni de X/Twitter, ni de TikTok, ni des comptes qui « lancent » :
 * l'attention collective des créateurs de tokens est notre seul observable.
 *
 * Champs utilisés : UNIQUEMENT name, symbol (+ receivedAt/at pour le walk-forward).
 * Sans chevauchement → score 0, neutre, raison explicite (« NO ACTION » logique :
 * pas de catalyst détectable ≠ mauvais token).
 *
 * Ce n'est PAS une règle d'entrée : c'est un bonus de conviction qui sert à
 * classer le régime de sortie (H-EXIT) et à prioriser l'analyse humaine.
 */
import { computeNarratives, tokenize, STOPWORDS, type NarrativeDoc, type TermStat } from "./narrative.ts";

export interface CatalystToken {
  mint: string;
  name: string;
  symbol: string;
}

export interface MatchedTerm {
  term: string;
  /** (count24h + 1) / (baselinePerDay + 1), cf. narrative.ts. */
  growth: number;
  count24h: number;
  docs24h: number;
}

export interface CatalystScore {
  /** 0..100. 0 = aucun catalyst détectable (neutre, pas un rejet). */
  score: number;
  reasons: string[];
  matchedTerms: MatchedTerm[];
}

/**
 * Termes significatifs d'un token : tokenisation partagée avec narrative.ts,
 * stopwords exclus (même liste que computeNarratives), dédupliqués,
 * $TICKER normalisé en majuscules.
 */
export function tokenTerms(name: string, symbol: string): string[] {
  const seen = new Set<string>();
  for (const w of tokenize(`${name ?? ""} ${symbol ?? ""}`)) {
    if (STOPWORDS.has(w.toLowerCase())) continue;
    if (!/^\d+$/.test(w)) seen.add(w);
  }
  return [...seen];
}

/**
 * Mapping croissance → score, documenté et volontairement conservateur :
 * score = clamp(round((growth − 1) × 20), 0, 100).
 * growth 1 → 0 (pas d'accélération) ; 2 → 20 ; 3 → 40 ; 5 → 80 ; ≥ 6 → 100.
 * Le ×5 de la note Cupsey (« un terme ×5 en 24 h = signal ») vaut donc 80.
 */
export function growthToCatalystScore(growth: number): number {
  if (!Number.isFinite(growth) || growth <= 1) return 0;
  return Math.min(100, Math.round((growth - 1) * 20));
}

/**
 * Score catalyst d'un token face à des termes en accélération déjà calculés
 * (fenêtre strictement antérieure au token — walk-forward, jamais de futur).
 * Fonction pure.
 */
export function catalystScore(token: Pick<CatalystToken, "name" | "symbol">, accelerating: TermStat[]): CatalystScore {
  const terms = tokenTerms(token.name, token.symbol);
  const byTerm = new Map(accelerating.map((t) => [t.term, t]));
  const matched: MatchedTerm[] = [];
  for (const w of terms) {
    const t = byTerm.get(w);
    if (t) matched.push({ term: w, growth: t.growth, count24h: t.count24h, docs24h: t.docs24h });
  }
  if (matched.length === 0) {
    return { score: 0, reasons: ["aucun chevauchement avec un narratif en accélération (neutre, pas un rejet)"], matchedTerms: [] };
  }
  matched.sort((a, b) => b.growth - a.growth);
  const best = matched[0] as MatchedTerm;
  const score = growthToCatalystScore(best.growth);
  const reasons = [
    `terme « ${best.term} » en accélération x${best.growth.toFixed(1)} (${best.count24h} mentions / 24 h, ${best.docs24h} documents)`,
  ];
  if (matched.length > 1) reasons.push(`${matched.length - 1} autre(s) terme(s) en accélération : ${matched.slice(1, 3).map((m) => `« ${m.term} » x${m.growth.toFixed(1)}`).join(", ")}`);
  return { score, reasons, matchedTerms: matched };
}

export interface WalkForwardOptions {
  /** Fenêtre « récente » en heures pour computeNarratives (défaut 24). */
  recentHours?: number;
  /** Fenêtre de référence en jours (défaut 7). */
  baselineDays?: number;
  /** Occurrences minimales sur 24 h (défaut 5 — volume élevé de créations). */
  minCount?: number;
  /** Documents distincts minimaux (défaut 3). */
  minDocs?: number;
  /** Termes accélérés conservés par jour (défaut 200). */
  topTerms?: number;
}

/**
 * Documents narratifs depuis des événements de création : texte = "name symbol",
 * at = receivedAt. C'est l'« attention des créateurs », notre seul observable.
 */
export function createsToDocs(creates: { name: string; symbol: string; receivedAt: string }[]): NarrativeDoc[] {
  const docs: NarrativeDoc[] = [];
  for (const c of creates) {
    const at = Date.parse(c.receivedAt);
    if (!Number.isFinite(at)) continue;
    docs.push({ at, text: `${c.name ?? ""} ${c.symbol ?? ""}`, source: "token" });
  }
  return docs.sort((a, b) => a.at - b.at);
}

/**
 * Termes en accélération par jour UTC, en walk-forward strict : pour le jour D,
 * computeNarratives est appelé avec now = début de D ; seuls les documents
 * strictement antérieurs à D sont utilisés (récent = J-1, référence = J-8..J-2).
 * Jamais de lookahead : un token créé le jour D n'est scoré que sur le passé.
 *
 * Renvoie Map<AAAA-MM-JJ, TermStat[]>.
 */
export function acceleratingTermsByDay(docs: NarrativeDoc[], days: string[], opts: WalkForwardOptions = {}): Map<string, TermStat[]> {
  const out = new Map<string, TermStat[]>();
  const past = docs.filter((d) => d.at < Date.parse(days[0] as string) + 8 * 86_400_000);
  for (const day of days) {
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const before = past.filter((d) => d.at < dayStart);
    const terms = computeNarratives(before, {
      now: () => dayStart,
      recentHours: opts.recentHours ?? 24,
      baselineDays: opts.baselineDays ?? 7,
      top: opts.topTerms ?? 200,
      minCount: opts.minCount ?? 5,
      minDocs: opts.minDocs ?? 3,
    });
    out.set(day, terms);
  }
  return out;
}

/** Score walk-forward d'une liste de tokens (champ `at` = ISO de création). */
export function scoreTokensWalkForward<T extends CatalystToken & { at: string }>(
  tokens: T[],
  termsByDay: Map<string, TermStat[]>,
): Map<string, CatalystScore> {
  const out = new Map<string, CatalystScore>();
  for (const t of tokens) {
    const day = t.at.slice(0, 10);
    const terms = termsByDay.get(day) ?? [];
    out.set(t.mint, catalystScore(t, terms));
  }
  return out;
}
