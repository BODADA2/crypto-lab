/**
 * Détection "late discovery" — audit 2026-09-28 (docs/audit-late-discovery-2026-09-28.md,
 * relecture critique : docs/unbiased-tracking-spec-2026-09-28.md §6).
 *
 * Constat : ~0,9 % des événements `create` PumpPortal ne sont pas des observations à la
 * création. Le collecteur émet un `create` tardif avec un état de courbe figé quand il
 * découvre un token déjà chaud/migré (ex. tuple constant
 * (85.005359057, 115.005359056806, 279900000, 410.8801681200643), 607/607 migrés,
 * délai create→migrate = 0).
 *
 * Règle : un `create` observé avec `vSolInBondingCurve >= 85` (seuil de graduation
 * pump.fun) n'est PAS une observation à la création. Validée empiriquement sur 5 jours
 * (68 466 creates) : 0 faux positif sur 67 845 creates genuine (max genuine : vSol =
 * 84,32), et 14 late-discoveries capturées en plus du tuple exact (qui est subsumé).
 *
 * Limites connues :
 * - `pool: "bonk"` : les creates ne portent jamais `vSolInBondingCurve` → la règle ne
 *   peut pas se déclencher (ni détection, ni faux positif).
 * - Zone grise 80–85 SOL : un token découvert à vSol = 84 reste compté genuine
 *   (conservateur par design ; un vrai devBuy à 54 SOL existe).
 * - Ne s'applique qu'aux événements `kind === "create"` (une migration a vSol >= 85
 *   par définition).
 */
export const GRADUATION_VSOL_SOL = 85;

export interface LateDiscoveryLike {
  kind?: unknown;
  raw?: unknown;
}

/** `true` si l'événement est une découverte tardive avérée. Fonction pure (testée). */
export function detectLateDiscovery(ev: LateDiscoveryLike): boolean {
  if (ev?.kind !== "create") return false;
  const raw = ev.raw as Record<string, unknown> | null | undefined;
  const v = raw?.vSolInBondingCurve;
  if (v === null || v === undefined) return false;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= GRADUATION_VSOL_SOL;
}

/**
 * Compatibilité ascendante : les lignes JSONL écrites avant le flag utilisent la
 * détection à la volée. Les nouvelles lignes portent `lateDiscovery` directement.
 */
export function lateDiscoveryOf(ev: { kind?: unknown; raw?: unknown; lateDiscovery?: unknown }): boolean {
  if (typeof ev.lateDiscovery === "boolean") return ev.lateDiscovery;
  return detectLateDiscovery(ev);
}
