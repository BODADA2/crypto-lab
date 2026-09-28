/**
 * Blocklist de devs — H-BLOCK (face négative de H-DEV, vidéo TikTok @hellojrus, 2026-09-28).
 *
 * Les traders Axiom/Trojan utilisent « blacklist dev » : quand un token est un rug,
 * ils bannissent le wallet dev pour ne plus jamais voir ses futurs tokens dans leur
 * scope. H-DEV (Deku) est la face positive (devs qui graduent) ; H-BLOCK est la face
 * négative (devs qui rug). Les deux forment un seul registre dev à double entrée.
 *
 * Lien avec H-BUNDLE : les devs qui bundlent en série sont exactement la population
 * cible de la blocklist (rugs en série sur le même wallet). Un wallet flaggé par
 * `bundleRiskStatic` en série est un candidat naturel à `blockDev` — mais le
 * remplissage reste MANUEL ou semi-auto : voir limites ci-dessous.
 *
 * Limites honnêtes (cf. docs/research-2026-09-28-hellojrus-dev-blacklist.md) :
 * 1) Faux positifs possibles (wallet compromis, dev qui « se rachète »). La règle
 *    dure de la vidéo maximise la protection, pas la précision. Le backtest
 *    (n ≥ 30) doit mesurer « rugs évités » vs « runners filtrés par erreur » et
 *    trancher entre bannissement dur et simple pénalité de score — les deux
 *    options sont exposées ici (`isBlocklisted` vs `blocklistPenalty`).
 * 2) Avec les seuls événements `create` des scans, la détection AUTOMATIQUE d'un
 *    rug est limitée : ce module ne détecte rien tout seul. Remplissage manuel
 *    (journal de session) ou semi-auto (revue humaine d'un candidat signalé par
 *    H-BUNDLE). Aucune détection inventée.
 *
 * Persistance locale : `data/dev-blocklist.json` (wallet → entrée). Format lisible,
 * éditable à la main — c'est voulu : la blocklist est un registre humain, pas un
 * modèle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Chemin par défaut du registre local. */
export const DEFAULT_BLOCKLIST_PATH = join("data", "dev-blocklist.json");

export interface BlockEntry {
  /** Wallet du dev banni. */
  wallet: string;
  /** Motif lisible, ex. « rug observé sur MINT… », « bundle en série ». */
  reason: string;
  /** Date ISO du bannissement (premier). */
  blockedAt: string;
  /** Nombre de rugs observés pour ce wallet (incrémenté à chaque re-signalement). */
  rugsObserved: number;
  /** Origine de l'entrée : « manuel » | « semi-auto » (jamais « auto » — voir limites). */
  source: "manuel" | "semi-auto";
  /** Date ISO du dernier signalement (re-rug). */
  lastSeenAt: string;
}

/** Registre : wallet → entrée. Sérialisable en JSON tel quel. */
export type Blocklist = Record<string, BlockEntry>;

export function emptyBlocklist(): Blocklist {
  return {};
}

/** Fonction pure : le wallet est-il banni ? (insensible à la casse, tolère null). */
export function isBlocklisted(list: Blocklist, wallet: string | null | undefined): boolean {
  if (!wallet || typeof wallet !== "string") return false;
  return Object.prototype.hasOwnProperty.call(list, wallet);
}

/**
 * Fonction pure : bannit (ou re-signale) un wallet. Retourne un NOUVEAU registre,
 * l'original n'est pas modifié. Un re-signalement incrémente `rugsObserved` et met
 * à jour `lastSeenAt` sans écraser le motif d'origine.
 */
export function blockDev(
  list: Blocklist,
  wallet: string,
  opts: { reason: string; source?: "manuel" | "semi-auto"; now?: () => number } = { reason: "" },
): Blocklist {
  if (!wallet || typeof wallet !== "string") throw new Error("blockDev : wallet invalide");
  const reason = (opts.reason ?? "").trim() || "motif non précisé";
  const at = new Date((opts.now ?? Date.now)()).toISOString();
  const next: Blocklist = { ...list };
  const existing = next[wallet];
  next[wallet] = existing
    ? { ...existing, rugsObserved: existing.rugsObserved + 1, lastSeenAt: at }
    : {
        wallet,
        reason,
        blockedAt: at,
        rugsObserved: 1,
        source: opts.source ?? "manuel",
        lastSeenAt: at,
      };
  return next;
}

/** Fonction pure : retire un wallet (faux positif, dev « racheté »). Retourne un nouveau registre. */
export function unblockDev(list: Blocklist, wallet: string): Blocklist {
  if (!Object.prototype.hasOwnProperty.call(list, wallet)) return { ...list };
  const next = { ...list };
  delete next[wallet];
  return next;
}

/** Entrée pour un wallet, ou null. */
export function getEntry(list: Blocklist, wallet: string | null | undefined): BlockEntry | null {
  if (!wallet || typeof wallet !== "string") return null;
  return Object.prototype.hasOwnProperty.call(list, wallet) ? { ...(list[wallet] as BlockEntry) } : null;
}

/**
 * Pénalité de score (0..100) pour un wallet banni — l'alternative « douce » au
 * bannissement dur. Valeur de départ NON calibrée : le backtest n ≥ 30 tranche
 * entre `isBlocklisted` (exclusion) et cette pénalité (dégradation du score).
 */
export function blocklistPenalty(list: Blocklist, wallet: string | null | undefined): number {
  const entry = getEntry(list, wallet);
  if (!entry) return 0;
  // 60 de base + 10 par rug supplémentaire, plafonné à 100. Arbitraire assumé :
  // à calibrer en backtest, jamais en production sans mesure.
  return Math.min(100, 60 + (entry.rugsObserved - 1) * 10);
}

/** Nombre de wallets bannis. */
export function blocklistSize(list: Blocklist): number {
  return Object.keys(list).length;
}

/**
 * Charge le registre depuis un fichier JSON. Fichier absent ou corrompu →
 * registre vide (jamais d'exception : une blocklist illisible ne doit pas
 * casser le brief ni le scan).
 */
export function loadBlocklist(path: string = DEFAULT_BLOCKLIST_PATH): Blocklist {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const list: Blocklist = {};
    for (const [wallet, e] of Object.entries(raw as Record<string, unknown>)) {
      if (e && typeof e === "object" && typeof wallet === "string" && wallet.length > 0) {
        const entry = e as Partial<BlockEntry>;
        list[wallet] = {
          wallet,
          reason: typeof entry.reason === "string" ? entry.reason : "motif non précisé",
          blockedAt: typeof entry.blockedAt === "string" ? entry.blockedAt : new Date(0).toISOString(),
          rugsObserved: typeof entry.rugsObserved === "number" && entry.rugsObserved >= 1 ? Math.floor(entry.rugsObserved) : 1,
          source: entry.source === "semi-auto" ? "semi-auto" : "manuel",
          lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : new Date(0).toISOString(),
        };
      }
    }
    return list;
  } catch {
    return {};
  }
}

/** Sauvegarde le registre (crée le dossier parent si besoin). */
export function saveBlocklist(list: Blocklist, path: string = DEFAULT_BLOCKLIST_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2) + "\n");
}
