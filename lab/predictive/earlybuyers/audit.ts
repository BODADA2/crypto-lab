/**
 * Phase 2 — audit anti-fuite temporelle.
 *
 * Pour CHAQUE feature de CHAQUE token : tsMs <= t0ms, sans exception.
 * tsMs = timestamp maximum des sources de données de la feature.
 * Une seule violation → { pass: false, violations } et le runner DOIT
 * échouer (process.exit non-zéro) avec identification précise du couple
 * (mint, feature) fautif.
 *
 * Cet audit est le garde-fou contre la contamination qui a invalidé la
 * Phase 1 (features `sellersOver50` / `medianSoldFrac` calculées sur des
 * ventes POST-migration : l'information n'existait pas à t0).
 */
import type { FeatureSet } from "./types.ts";

export interface LeakageViolation {
  mint: string;
  feature: string;
  tsMs: number;
  t0ms: number;
  /** Dépassement en secondes (tsMs - t0ms) / 1000. */
  overSec: number;
}

export interface AuditResult {
  pass: boolean;
  checked: number;
  violations: LeakageViolation[];
}

/**
 * Vérifie que toutes les features de tous les jeux sont antérieures ou
 * égales à leur t0. Tolérance zéro : tsMs > t0ms, même d'1 ms, = violation.
 */
export function auditAntiLeakage(featureSets: FeatureSet[]): AuditResult {
  const violations: LeakageViolation[] = [];
  let checked = 0;
  for (const fs of featureSets) {
    for (const [key, fv] of Object.entries(fs.features)) {
      checked++;
      if (!Number.isFinite(fv.tsMs)) {
        violations.push({
          mint: fs.mint,
          feature: key,
          tsMs: fv.tsMs,
          t0ms: fs.t0ms,
          overSec: Number.NaN,
        });
        continue;
      }
      if (fv.tsMs > fs.t0ms) {
        violations.push({
          mint: fs.mint,
          feature: key,
          tsMs: fv.tsMs,
          t0ms: fs.t0ms,
          overSec: (fv.tsMs - fs.t0ms) / 1000,
        });
      }
    }
  }
  return { pass: violations.length === 0, checked, violations };
}

/** Formatte les violations pour un message d'échec explicite. */
export function formatViolations(v: LeakageViolation[]): string {
  return v
    .map(
      (x) =>
        `  - ${x.mint} / ${x.feature} : tsMs=${new Date(x.tsMs).toISOString()} > t0ms=${new Date(x.t0ms).toISOString()} (dépassement ${x.overSec.toFixed(1)} s)`,
    )
    .join("\n");
}
