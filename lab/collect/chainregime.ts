/**
 * Indicateur de régime de volume par chaîne — quotidien, pensé pour le brief.
 *
 * Origine : interview Cupsey (2026-09-28) §2.3 — « indicateur de régime par
 * chaîne dans le brief » : ne pas parier sur une chaîne, mais savoir dans quel
 * régime de volume on se trouve avant d'y chercher des plays.
 *
 * Calculé depuis data/scans/pump-AAAA-MM-JJ.jsonl (chaîne Solana pour l'instant).
 * Structure multi-chaînes dès le départ : chaque chaîne a son `chain`,
 * son chargeur et son historique ; le régime d'une chaîne ne dépend que de
 * SON propre passé (jamais de comparaison inter-chaînes).
 *
 * Régime = percentile du nombre de créations du jour vs. sa propre base
 * trailing (défaut 7 jours glissants, jour courant exclu) :
 *   p < 10  → "famine"    (quasi aucune création : marché mort)
 *   p < 35  → "calme"
 *   p < 65  → "normal"
 *   p < 90  → "chaud"
 *   p ≥ 90  → "frénésie"  (pic d'activité : bruit maximal, sélectivité requise)
 * Seuils documentés ; < 3 jours d'historique → régime "inconnu" (NO ACTION).
 *
 * Fonctions pures + chargeurs tolérants (lignes invalides ignorées).
 * Aucune donnée inventée : sans scans, le chargeur renvoie [] et le brief
 * affiche « aucune donnée ».
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ChainRegimeName = "famine" | "calme" | "normal" | "chaud" | "frénésie" | "inconnu";

export interface DailyChainStats {
  /** Identifiant chaîne, ex. "solana". Clé de partition du régime. */
  chain: string;
  /** AAAA-MM-JJ (UTC). */
  date: string;
  creates: number;
  migrates: number;
  /** Somme des solAmount initiaux (SOL). */
  totalSolIn: number;
  /** Médiane des marketCapSol à la création (SOL). */
  medianMcapSol: number;
}

export interface ChainRegime extends DailyChainStats {
  /** Taux de migration = migrates / creates (null si creates = 0). */
  migrationRate: number | null;
  /** Percentile 0..100 des créations vs base trailing. */
  createsPercentile: number | null;
  regime: ChainRegimeName;
  /** Phrase prête pour le brief, avec source. */
  briefLine: string;
}

export interface RegimeOptions {
  /** Jours d'historique trailing (défaut 7). */
  baselineDays?: number;
  /** Jours min d'historique requis (défaut 3), sinon "inconnu". */
  minHistoryDays?: number;
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)} %`);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Percentile empirique de x dans la base (0..100). */
function percentile(x: number, base: number[]): number | null {
  if (!base.length) return null;
  const le = base.filter((b) => b <= x).length;
  return (le / base.length) * 100;
}

function regimeOf(p: number | null): ChainRegimeName {
  if (p === null) return "inconnu";
  if (p < 10) return "famine";
  if (p < 35) return "calme";
  if (p < 65) return "normal";
  if (p < 90) return "chaud";
  return "frénésie";
}

/**
 * Charge les stats quotidiennes depuis data/scans/pump-AAAA-MM-JJ.jsonl.
 * `chain` = identifiant logique (défaut "solana") ; `fileMatch` permet à une
 * future chaîne d'utiliser d'autres fichiers (point d'extension multi-chaînes).
 */
export function loadDailyStatsFromScans(
  scansDir: string,
  chain = "solana",
  fileMatch: RegExp = /^pump-(\d{4}-\d{2}-\d{2})\.jsonl$/,
): DailyChainStats[] {
  const out: DailyChainStats[] = [];
  if (!existsSync(scansDir)) return out;
  const files = readdirSync(scansDir)
    .filter((f) => fileMatch.test(f))
    .sort();
  for (const f of files) {
    const m = f.match(fileMatch);
    const date = m?.[1];
    if (!date) continue;
    let creates = 0;
    let migrates = 0;
    let totalSolIn = 0;
    const mcaps: number[] = [];
    for (const line of readFileSync(join(scansDir, f), "utf8").split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        const e = JSON.parse(l) as { kind?: string; solAmount?: number; marketCapSol?: number };
        if (e.kind === "create") {
          creates += 1;
          if (typeof e.solAmount === "number" && Number.isFinite(e.solAmount)) totalSolIn += e.solAmount;
          if (typeof e.marketCapSol === "number" && Number.isFinite(e.marketCapSol)) mcaps.push(e.marketCapSol);
        } else if (e.kind === "migrate") {
          migrates += 1;
        }
      } catch {
        /* ligne corrompue : ignorée */
      }
    }
    out.push({ chain, date, creates, migrates, totalSolIn, medianMcapSol: median(mcaps) });
  }
  return out;
}

/**
 * Point d'extension multi-chaînes : un chargeur par chaîne.
 * Exemple futur : { solana: (dir) => loadDailyStatsFromScans(dir, "solana"),
 *                  base:   (dir) => loadDailyStatsFromScans(dir, "base", /^base-(\d{4}-\d{2}-\d{2})\.jsonl$/) }
 */
export type ChainStatsLoader = (scansDir: string) => DailyChainStats[];

export function loadAllChains(scansDir: string, loaders: Record<string, ChainStatsLoader>): DailyChainStats[] {
  return Object.values(loaders).flatMap((load) => load(scansDir));
}

/** Calcule le régime de chaque jour (chaque chaîne indépendamment). Fonction pure. */
export function computeChainRegimes(allStats: DailyChainStats[], opts: RegimeOptions = {}): ChainRegime[] {
  const baselineDays = opts.baselineDays ?? 7;
  const minHistory = opts.minHistoryDays ?? 3;
  const out: ChainRegime[] = [];
  const byChain = new Map<string, DailyChainStats[]>();
  for (const s of allStats) {
    const arr = byChain.get(s.chain) ?? [];
    arr.push(s);
    byChain.set(s.chain, arr);
  }
  for (const [, stats] of byChain) {
    const sorted = [...stats].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i] as DailyChainStats;
      const base = sorted.slice(Math.max(0, i - baselineDays), i).map((x) => x.creates);
      const p = base.length >= minHistory ? percentile(s.creates, base) : null;
      const regime = regimeOf(p);
      const migrationRate = s.creates > 0 ? s.migrates / s.creates : null;
      const briefLine =
        regime === "inconnu"
          ? `Régime ${s.chain} le ${s.date} : inconnu (historique insuffisant : ${base.length} j < ${minHistory} requis).`
          : `Régime ${s.chain} le ${s.date} : ${regime} — ${s.creates.toLocaleString("fr-CA")} créations (percentile ${p?.toFixed(0)} / base ${base.length} j), ${s.migrates} migrations (${pct(migrationRate)}), ${s.totalSolIn.toFixed(1)} SOL initiaux, mcap médiane ${s.medianMcapSol.toFixed(1)} SOL.`;
      out.push({ ...s, migrationRate, createsPercentile: p, regime, briefLine });
    }
  }
  return out.sort((a, b) => a.chain.localeCompare(b.chain) || a.date.localeCompare(b.date));
}

/** Lignes prêtes pour la section ON-CHAIN / MARKET du brief quotidien. */
export function formatRegimeBriefLines(regimes: ChainRegime[], source: string): string[] {
  if (!regimes.length) return [`Régime de volume : aucune donnée (source : ${source}).`];
  const latest = new Map<string, ChainRegime>();
  for (const r of regimes) latest.set(r.chain, r);
  return [...latest.values()].map((r) => `${r.briefLine} (source : ${source})`);
}
