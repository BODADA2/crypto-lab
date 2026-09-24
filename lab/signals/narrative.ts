/**
 * Signal « narratif émergent » : termes dont la fréquence sur 24 h accélère par rapport
 * à leur fréquence quotidienne moyenne des 7 jours précédents.
 *
 * Sources = documents horodatés (titre + texte) provenant de Reddit, GitHub (nom + description)
 * et noms/symboles des tokens créés/migrés (PumpPortal, DexScreener).
 * Sortie : top 10 termes en accélération avec comptes et facteur de croissance.
 */

export interface NarrativeDoc {
  /** Epoch ms. */
  at: number;
  text: string;
  source: "reddit" | "github" | "token" | string;
}

export interface TermStat {
  term: string;
  count24h: number;
  /** Moyenne quotidienne sur la fenêtre de référence. */
  baselinePerDay: number;
  /** Total sur la fenêtre de référence. */
  count7d: number;
  /** (count24h + 1) / (baselinePerDay + 1) : > 1 = accélération. */
  growth: number;
  sources: Record<string, number>;
  /** Nombre de documents distincts sur 24 h contenant le terme. */
  docs24h: number;
}

export interface NarrativeOptions {
  now?: () => number;
  /** Fenêtre récente en heures (défaut 24). */
  recentHours?: number;
  /** Fenêtre de référence en jours (défaut 7). */
  baselineDays?: number;
  /** Nombre de termes renvoyés (défaut 10). */
  top?: number;
  /** Occurrences minimales sur 24 h pour être candidat (défaut 3). */
  minCount?: number;
  /** Documents distincts minimaux sur 24 h (anti-spam : un seul post répété ne compte pas). */
  minDocs?: number;
  extraStopwords?: Iterable<string>;
}

/** Stopwords FR/EN + jargon crypto trop générique pour être un narratif. */
export const STOPWORDS = new Set<string>(
  `
a an and are as at be been but by can could do for from has have he her his how i if in into is it its just
me my no not of on or our out so than that the their them then there these they this to up us was we were what
when where which who will with would you your yes new all any more most very via like get got one two
le la les de des du un une et ou en au aux ce cette ces est sont pour par pas plus sur avec dans que qui
ne se son sa ses il elle ils elles nous vous je tu on mais donc car ni
solana sol token tokens coin coins crypto memecoin memecoins meme pump pumpfun launch launched
buy sell buying selling price chart moon mooning dev devs project community holders holder liquidity lp
wallet wallets airdrop presale ca contract address dex dexscreener raydium jupiter telegram twitter discord
http https www com org io app reddit github rust typescript javascript python api sdk bot bots
`
    .split(/\s+/)
    .filter(Boolean),
);

/** Tokenisation simple : minuscules, mots de 3–24 caractères alphanumériques (garde $ticker en majuscule). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$?[a-zA-Z][a-zA-Z0-9]{2,23}/g)) {
    const w = m[0];
    if (w.startsWith("$")) out.push(w.toUpperCase());
    else if (/^[0-9a-fA-F]{16,}$/.test(w)) continue;
    else out.push(w.toLowerCase());
  }
  return out;
}

export function computeNarratives(docs: NarrativeDoc[], opts: NarrativeOptions = {}): TermStat[] {
  const now = opts.now ?? (() => Date.now());
  const t = now();
  const recentMs = (opts.recentHours ?? 24) * 3_600_000;
  const baselineDays = opts.baselineDays ?? 7;
  const baselineMs = baselineDays * 86_400_000;
  const top = opts.top ?? 10;
  const minCount = opts.minCount ?? 3;
  const minDocs = opts.minDocs ?? 2;
  const stop = new Set(STOPWORDS);
  for (const s of opts.extraStopwords ?? []) stop.add(s.toLowerCase());

  const recent = new Map<string, TermStat>();
  const base = new Map<string, number>();

  for (const d of docs) {
    const age = t - d.at;
    if (age < 0 || age > recentMs + baselineMs) continue;
    const isRecent = age <= recentMs;
    const terms = tokenize(d.text).filter((w) => !stop.has(w) && !/^\d+$/.test(w));
    const distinct = new Set(terms);
    for (const w of terms) {
      if (isRecent) {
        const s = recent.get(w) ?? { term: w, count24h: 0, baselinePerDay: 0, count7d: 0, growth: 0, sources: {}, docs24h: 0 };
        s.count24h += 1;
        s.sources[d.source] = (s.sources[d.source] ?? 0) + 1;
        recent.set(w, s);
      } else {
        base.set(w, (base.get(w) ?? 0) + 1);
      }
    }
    if (isRecent) for (const w of distinct) if (recent.has(w)) (recent.get(w) as TermStat).docs24h += 1;
  }

  const stats: TermStat[] = [];
  for (const s of recent.values()) {
    if (s.count24h < minCount || s.docs24h < minDocs) continue;
    s.count7d = base.get(s.term) ?? 0;
    s.baselinePerDay = s.count7d / baselineDays;
    s.growth = (s.count24h + 1) / (s.baselinePerDay + 1);
    stats.push(s);
  }
  return stats.sort((a, b) => b.growth - a.growth || b.count24h - a.count24h || a.term.localeCompare(b.term)).slice(0, top);
}
