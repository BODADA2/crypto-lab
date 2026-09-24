// Cross-check multi-signal (chantier 4) — fonction pure, hors ligne, déterministe.
//
// Question à laquelle il répond : combien de FAMILLES de signaux INDÉPENDANTES convergent ?
// Un boost payé sur DexScreener fait monter le volume (market), les holders (onchain) et les mentions Reddit (human)
// en même temps : trois signaux, UNE cause. Ils comptent pour une seule famille. La convergence mesure l'indépendance
// des causes, pas le nombre de signaux.

/**
 * Signal d'entrée du cross-check.
 * À ALIGNER SUR lab/strategies/types.ts (`StrategySignal`, chantier 2 en cours dans un autre chantier) : ce dernier porte
 * `strength` en 0–100 (ici 0..1 → diviser par 100) et n'a pas encore de `family` ni de `cause` ; l'adaptateur
 * StrategySignal → SignalInput devra les fournir (famille d'après la stratégie, cause d'après la source de l'événement).
 * Les champs ci-dessous sont le minimum dont le cross-check a besoin.
 */
export interface SignalInput {
  /** Identifiant unique du signal (ex. "volume-spike-5m:<mint>:<ts>"). */
  id: string;
  /** Famille de la source. */
  family: SignalFamily;
  /**
   * Cause racine : identifiant de la source ou de l'événement qui a produit le signal.
   * Ex. "dexscreener-boost:<mint>", "pumpportal:<mint>", "reddit:<postId>", "helius-wallet:<address>".
   * Deux signaux portant la même cause ne sont PAS indépendants, quelle que soit leur famille.
   */
  cause: string;
  /** Force du signal, 0..1 (informative : n'entre pas dans la convergence, sert aux avertissements). */
  strength: number;
  /** Horodatage ISO 8601 du signal. */
  ts: string;
  /** Nom de la stratégie ou du collecteur émetteur (informatif). */
  source?: string;
  note?: string;
}

export type SignalFamily = "human" | "market" | "onchain" | "project" | "macro";
export const SIGNAL_FAMILIES: readonly SignalFamily[] = ["human", "market", "onchain", "project", "macro"];

export type Conviction = "FAIBLE" | "MOYENNE" | "FORTE";

export interface CrossCheckOptions {
  /** Âge max d'un signal (minutes) par rapport à `now` ; plus vieux = ignoré avec avertissement. Défaut 60. */
  maxAgeMinutes?: number;
  /** Force minimale pour qu'un signal soit retenu (0..1). Défaut 0 (tout signal valide compte). */
  minStrength?: number;
}

export interface CauseGroup {
  cause: string;
  families: SignalFamily[];
  signalIds: string[];
  /** Famille retenue pour cette cause dans le décompte de convergence (null si la cause n'apporte rien de neuf). */
  countedAs: SignalFamily | null;
}

export interface CrossCheckResult {
  /** Nombre de familles distinctes appuyées par des causes distinctes : 0..5. */
  convergence: number;
  /** Familles retenues (une par cause indépendante). */
  families: SignalFamily[];
  conviction: Conviction;
  /** Explication en clair de l'indépendance mesurée. */
  independence: string;
  warnings: string[];
  /** Regroupement par cause racine (transparence). */
  causes: CauseGroup[];
  /** Signaux retenus / ignorés (avec la raison). */
  used: string[];
  ignored: Array<{ id: string; reason: string }>;
}

/** Seuils de conviction, explicites et publics. 1 famille = FAIBLE quelle que soit la force. */
export const CONVICTION_THRESHOLDS = { MOYENNE: 2, FORTE: 4 } as const;

const ISO_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTs(v: unknown): number | null {
  if (typeof v !== "string" || !ISO_STRICT.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function toMs(now: Date | string | number): number | null {
  if (now instanceof Date) return Number.isNaN(now.getTime()) ? null : now.getTime();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return parseTs(now);
}

export function convictionFor(convergence: number): Conviction {
  if (convergence >= CONVICTION_THRESHOLDS.FORTE) return "FORTE";
  if (convergence >= CONVICTION_THRESHOLDS.MOYENNE) return "MOYENNE";
  return "FAIBLE";
}

/**
 * Couplage maximum causes → familles (Kuhn, augmenting paths) : chaque cause ne peut appuyer qu'UNE famille, chaque famille
 * ne peut être appuyée que par UNE cause. La taille du couplage = nombre de familles appuyées par des causes distinctes.
 * Les tailles sont minuscules (≤ 5 familles), la complexité n'a aucune importance ; l'optimalité, si : un glouton
 * assignerait « boost → market » puis ne saurait plus où mettre « pumpportal → market » alors que « boost → onchain »
 * libérait la place.
 */
function maxMatching(groups: Array<{ families: SignalFamily[] }>): Array<SignalFamily | null> {
  const matchFamily = new Map<SignalFamily, number>(); // famille → index du groupe qui l'appuie
  const tryAssign = (g: number, seen: Set<SignalFamily>): boolean => {
    for (const f of groups[g]!.families) {
      if (seen.has(f)) continue;
      seen.add(f);
      const holder = matchFamily.get(f);
      if (holder === undefined || tryAssign(holder, seen)) {
        matchFamily.set(f, g);
        return true;
      }
    }
    return false;
  };
  for (let g = 0; g < groups.length; g++) tryAssign(g, new Set());
  const assigned: Array<SignalFamily | null> = groups.map(() => null);
  for (const [f, g] of matchFamily) assigned[g] = f;
  return assigned;
}

/** Cross-check pur : ne lève jamais, toute entrée invalide devient un avertissement. */
export function crossCheck(signals: readonly SignalInput[], now: Date | string | number, opts: CrossCheckOptions = {}): CrossCheckResult {
  const warnings: string[] = [];
  const ignored: Array<{ id: string; reason: string }> = [];
  const used: string[] = [];
  const maxAgeMs = (opts.maxAgeMinutes ?? 60) * 60_000;
  const minStrength = opts.minStrength ?? 0;
  const nowMs = toMs(now);

  const empty = (independence: string): CrossCheckResult => ({
    convergence: 0,
    families: [],
    conviction: "FAIBLE",
    independence,
    warnings,
    causes: [],
    used,
    ignored,
  });

  if (nowMs === null) {
    warnings.push("horloge invalide : aucun signal évalué");
    return empty("horloge invalide");
  }
  if (!Array.isArray(signals) || signals.length === 0) {
    warnings.push("aucun signal fourni");
    return empty("aucun signal");
  }

  // 1. Filtrage : validité, fraîcheur, force.
  const valid: SignalInput[] = [];
  const seenIds = new Set<string>();
  signals.forEach((s, i) => {
    const id = s && typeof s.id === "string" && s.id.length > 0 ? s.id : `#${i}`;
    if (!s || typeof s !== "object") return void ignored.push({ id, reason: "signal non-objet" });
    if (seenIds.has(id)) return void ignored.push({ id, reason: "id dupliqué" });
    if (!SIGNAL_FAMILIES.includes(s.family)) return void ignored.push({ id, reason: `famille inconnue « ${String(s.family)} »` });
    if (typeof s.cause !== "string" || s.cause.trim().length === 0) {
      return void ignored.push({ id, reason: "cause racine absente : indépendance non prouvable, signal ignoré (choix conservateur)" });
    }
    const ts = parseTs(s.ts);
    if (ts === null) return void ignored.push({ id, reason: "ts invalide (ISO 8601 avec fuseau requis)" });
    if (ts > nowMs + 5 * 60_000) return void ignored.push({ id, reason: "ts dans le futur" });
    if (nowMs - ts > maxAgeMs) return void ignored.push({ id, reason: `périmé (${Math.round((nowMs - ts) / 60_000)} min > ${maxAgeMs / 60_000})` });
    if (typeof s.strength !== "number" || !Number.isFinite(s.strength) || s.strength < 0 || s.strength > 1) {
      return void ignored.push({ id, reason: "strength doit être un nombre 0..1" });
    }
    if (s.strength < minStrength) return void ignored.push({ id, reason: `strength ${s.strength} < ${minStrength}` });
    seenIds.add(id);
    valid.push({ ...s, id });
  });
  for (const ig of ignored) warnings.push(`signal ${ig.id} ignoré : ${ig.reason}`);
  if (valid.length === 0) return empty("aucun signal valide");

  // 2. Regroupement par cause racine (normalisée : trim + minuscules).
  const byCause = new Map<string, { families: Set<SignalFamily>; ids: string[] }>();
  for (const s of valid) {
    const key = s.cause.trim().toLowerCase();
    const g = byCause.get(key) ?? { families: new Set<SignalFamily>(), ids: [] };
    g.families.add(s.family);
    g.ids.push(s.id);
    byCause.set(key, g);
    used.push(s.id);
  }
  const causeKeys = [...byCause.keys()].sort();
  const groups = causeKeys.map((cause) => {
    const g = byCause.get(cause)!;
    return { cause, families: SIGNAL_FAMILIES.filter((f) => g.families.has(f)), signalIds: [...g.ids].sort() };
  });

  // 3. Convergence = couplage maximum causes → familles.
  const assigned = maxMatching(groups);
  const causes: CauseGroup[] = groups.map((g, i) => ({ ...g, countedAs: assigned[i] ?? null }));
  const families = SIGNAL_FAMILIES.filter((f) => assigned.includes(f));
  const convergence = families.length;

  // 4. Avertissements de transparence.
  for (const c of causes) {
    if (c.families.length > 1) {
      warnings.push(`cause commune « ${c.cause} » : ${c.signalIds.length} signaux sur ${c.families.length} familles (${c.families.join(", ")}) comptés pour UNE famille${c.countedAs ? ` (${c.countedAs})` : ""}`);
    } else if (c.countedAs === null) {
      warnings.push(`cause « ${c.cause} » (${c.families[0]}) n'apporte pas de famille nouvelle : famille déjà appuyée par une autre cause`);
    }
  }
  const strengths = valid.map((s) => s.strength);
  const meanStrength = strengths.reduce((a, b) => a + b, 0) / strengths.length;
  if (convergence >= CONVICTION_THRESHOLDS.MOYENNE && meanStrength < 0.3) {
    warnings.push(`convergence ${convergence} mais force moyenne faible (${meanStrength.toFixed(2)}) : signaux nombreux mais ténus`);
  }
  if (convergence <= 1 && valid.length >= 3) {
    warnings.push(`${valid.length} signaux mais ${convergence} famille indépendante : forte suspicion de cause unique`);
  }
  const missing = SIGNAL_FAMILIES.filter((f) => !families.includes(f));

  const conviction = convictionFor(convergence);
  const independence =
    `${valid.length} signal(aux) valide(s), ${causeKeys.length} cause(s) racine(s) distincte(s), ${convergence} famille(s) indépendante(s) : ` +
    (families.length > 0 ? families.join(" + ") : "aucune") +
    (missing.length > 0 ? ` ; sans appui indépendant : ${missing.join(", ")}` : "") +
    `. Conviction ${conviction} (seuils : MOYENNE ≥ ${CONVICTION_THRESHOLDS.MOYENNE}, FORTE ≥ ${CONVICTION_THRESHOLDS.FORTE} ; 1 famille = FAIBLE quelle que soit la force).`;

  return { convergence, families, conviction, independence, warnings, causes, used, ignored };
}
