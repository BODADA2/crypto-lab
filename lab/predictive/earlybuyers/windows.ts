/**
 * Phase 2 — définitions SÉPARÉES des early buyers (§3 de la spec d'Hervé).
 *
 * UNE seule définition (le set pré-t0) existait : les autres étaient
 * confondues silencieusement. Chaque définition produit un FeatureSet
 * SÉPARÉ et comparable — on ne mélange jamais deux fenêtres dans un même
 * calcul.
 *
 *  - "pre_t0_set"   : identité — le comportement actuel (set pré-t0) ;
 *  - "first_block"  : buyers dont le slot = slot minimum du set ;
 *  - "first_5_slots": buyers dont le slot <= slot_min + 4 ;
 *  - "first_60s"    : buyers dont blockTimeMs <= min_blockTimeMs + 60_000 ;
 *  - "first_300s"   : buyers dont blockTimeMs <= min_blockTimeMs + 300_000.
 *
 * Règle temporelle : les fenêtres ne font que FILTRER le set pré-t0
 * (déjà ≤ t0ms) — aucun buyer postérieur n'est introduit.
 */
import type { SnapshotBuyer } from "./types.ts";

export type WindowDef = "pre_t0_set" | "first_block" | "first_5_slots" | "first_60s" | "first_300s";

export const WINDOW_DEFS: Array<{ def: WindowDef; desc: string }> = [
  {
    def: "pre_t0_set",
    desc: "identité : set pré-t0 complet (comportement actuel, inchangé)",
  },
  {
    def: "first_block",
    desc: "buyers arrivés dans le premier slot observé (snipers stricto sensu)",
  },
  {
    def: "first_5_slots",
    desc: "buyers arrivés dans les 5 premiers slots observés",
  },
  {
    def: "first_60s",
    desc: "buyers arrivés dans les 60 premières secondes (blockTime)",
  },
  {
    def: "first_300s",
    desc: "buyers arrivés dans les 300 premières secondes (blockTime)",
  },
];

/**
 * Applique une fenêtre au set. "pre_t0_set" retourne le tableau tel quel
 * (identité). Les autres filtrent depuis min(slot)/min(blockTimeMs) du set
 * et préservent l'ordre d'entrée. Si aucun slot non-null n'existe,
 * first_block/first_5_slots retournent [] (documenté, pas silencieux).
 */
export function applyWindow(buyers: SnapshotBuyer[], def: WindowDef): SnapshotBuyer[] {
  if (def === "pre_t0_set") return buyers;
  if (buyers.length === 0) return [];

  if (def === "first_block" || def === "first_5_slots") {
    const slots = buyers.map((b) => b.slot).filter((s): s is number => s != null);
    if (slots.length === 0) return [];
    const minSlot = Math.min(...slots);
    const maxSlot = def === "first_block" ? minSlot : minSlot + 4;
    return buyers.filter((b) => b.slot != null && b.slot >= minSlot && b.slot <= maxSlot);
  }

  const minTs = Math.min(...buyers.map((b) => b.blockTimeMs));
  const horizonMs = def === "first_60s" ? 60_000 : 300_000;
  return buyers.filter((b) => b.blockTimeMs <= minTs + horizonMs);
}
