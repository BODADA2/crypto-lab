/**
 * Phase 2 — analyse de survie (§8 spec) : Cox PH + Kaplan-Meier, pure TS.
 *
 * Question : la composition des early buyers (features X) est-elle associée
 * au TEMPS jusqu'au premier passage sous -50% (événement) ?
 *
 *  - fitCoxPH : vraisemblance partielle de Cox, gestion des ex-aequo par
 *    Breslow, Newton-Raphson (max 100 itérations) avec recherche linéaire.
 *    Les colonnes de X sont centrées-réduites en interne pour la stabilité
 *    numérique ; les coefficients sont reconvertis à l'échelle d'origine.
 *  - kaplanMeier : courbe de survie non paramétrique par temps d'événement.
 *  - concordance : indice C de Harrell sur les scores de risque (X·coef).
 *
 * GARDE D'HONNÊTETÉ : si non-convergence OU n < 30 → converged = false et
 * concordance = null. Un résultat non convergé n'est JAMAIS interprété.
 * Aucun deep learning, aucun tuning : méthode classique, ordre respecté.
 */

export interface CoxInput {
  /** Durées en heures jusqu'à l'événement ou censure (> 0). */
  durations: number[];
  /** true = événement (passage sous -50%) ; false = censure. */
  events: boolean[];
  /** Matrice n × p (lignes = tokens, colonnes = features). */
  X: number[][];
  featureNames: string[];
}

export interface CoxResult {
  /** Coefficients (échelle d'origine des features). */
  coef: number[];
  /** Hazard ratios = exp(coef). */
  hr: number[];
  /** Erreurs-types (racine de la diagonale de l'inverse du Hessien). */
  se: number[];
  /** p-values de Wald (approximation normale) ; NaN si se non définie. */
  pWald: number[];
  /** Indice C de Harrell ; null si non-convergent ou n < 30. */
  concordance: number | null;
  converged: boolean;
  /** Nombre de lignes valides utilisées. */
  n: number;
}

const MAX_ITER = 100;
const TOL_STEP = 1e-8;
const TOL_LLIK = 1e-10;
const TOL_GRAD = 1e-6;
const MIN_N = 30;

/** Approximation de erf (Abramowitz & Stegun 7.1.26) pour la p-value de Wald. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t) *
      Math.exp(-ax * ax);
  return s * y;
}

function phi(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Résolution A·x = b par élimination de Gauss (pivot partiel) ; null si singulière. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < 1e-12) return null; // singulière
    if (piv !== col) {
      const tmp = M[col]!;
      M[col] = M[piv]!;
      M[piv] = tmp;
    }
    const d = M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / d;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

interface CleanRow {
  t: number;
  e: boolean;
  x: number[]; // standardisé
}

/**
 * Log-vraisemblance partielle (Breslow), gradient et Hessien.
 * Les lignes sont TRIÉES par durée croissante.
 */
function partialLikelihood(
  rows: CleanRow[],
  beta: number[],
): { ll: number; grad: number[]; hess: number[][] } {
  const p = beta.length;
  const eta = rows.map((r) => r.x.reduce((s, v, k) => s + v * beta[k]!, 0));
  let ll = 0;
  const grad = new Array<number>(p).fill(0);
  const hess = Array.from({ length: p }, () => new Array<number>(p).fill(0));

  // Groupes d'ex-aequo sur les temps d'événement.
  let i = 0;
  while (i < rows.length) {
    const t = rows[i]!.t;
    // Ensemble à risque : toutes les lignes avec durée >= t (triées).
    const riskIdx: number[] = [];
    for (let j = i; j < rows.length; j++) riskIdx.push(j);
    // Max eta pour la stabilité numérique.
    let m = -Infinity;
    for (const j of riskIdx) if (eta[j]! > m) m = eta[j]!;
    let sumW = 0;
    const sumWX = new Array<number>(p).fill(0);
    for (const j of riskIdx) {
      const w = Math.exp(eta[j]! - m);
      sumW += w;
      for (let k = 0; k < p; k++) sumWX[k]! += w * rows[j]!.x[k]!;
    }
    // Événements à ce temps t.
    let d = 0;
    const sumEX = new Array<number>(p).fill(0);
    let j = i;
    while (j < rows.length && rows[j]!.t === t) {
      if (rows[j]!.e) {
        d++;
        for (let k = 0; k < p; k++) sumEX[k]! += rows[j]!.x[k]!;
      }
      j++;
    }
    if (d > 0 && sumW > 0) {
      let sumEtaE = 0;
      let jj = i;
      while (jj < rows.length && rows[jj]!.t === t) {
        if (rows[jj]!.e) sumEtaE += eta[jj]!;
        jj++;
      }
      ll += sumEtaE - d * (Math.log(sumW) + m);
      for (let k = 0; k < p; k++) grad[k]! += sumEX[k]! - (d * sumWX[k]!) / sumW;
      // Hessien (défini positif) : d * (E[xx'] - E[x]E[x]').
      const mean = sumWX.map((v) => v / sumW);
      const sumWXX: number[][] = Array.from({ length: p }, () =>
        new Array<number>(p).fill(0),
      );
      for (const rj of riskIdx) {
        const w = Math.exp(eta[rj]! - m);
        for (let k = 0; k < p; k++)
          for (let l = 0; l < p; l++)
            sumWXX[k]![l]! += w * rows[rj]!.x[k]! * rows[rj]!.x[l]!;
      }
      for (let k = 0; k < p; k++)
        for (let l = 0; l < p; l++)
          hess[k]![l]! +=
            (d * (sumWXX[k]![l]! / sumW - mean[k]! * mean[l]!)) ;
    }
    i = j;
  }
  return { ll, grad, hess };
}

/** Indice C de Harrell : P(score_i > score_j | i événement avant j). */
function harrellC(durations: number[], events: boolean[], scores: number[]): number | null {
  let conc = 0;
  let total = 0;
  for (let i = 0; i < durations.length; i++) {
    if (!events[i]) continue;
    for (let j = 0; j < durations.length; j++) {
      if (i === j || durations[j]! <= durations[i]!) continue;
      total++;
      if (scores[i]! > scores[j]!) conc += 1;
      else if (scores[i]! === scores[j]!) conc += 0.5;
    }
  }
  return total > 0 ? conc / total : null;
}

function emptyResult(p: number, n: number): CoxResult {
  return {
    coef: new Array<number>(p).fill(0),
    hr: new Array<number>(p).fill(1),
    se: new Array<number>(p).fill(NaN),
    pWald: new Array<number>(p).fill(NaN),
    concordance: null,
    converged: false,
    n,
  };
}

export function fitCoxPH(input: CoxInput): CoxResult {
  const { durations, events, X, featureNames } = input;
  const p = featureNames.length;

  // 1. Nettoyage : lignes finies uniquement.
  const clean: Array<{ t: number; e: boolean; x: number[] }> = [];
  for (let i = 0; i < durations.length; i++) {
    const t = durations[i]!;
    const row = X[i];
    if (!(t > 0 && Number.isFinite(t))) continue;
    if (!row || row.length !== p) continue;
    if (row.some((v) => !Number.isFinite(v))) continue;
    clean.push({ t, e: events[i] === true, x: [...row] });
  }
  const n = clean.length;
  if (n < MIN_N) return emptyResult(p, n); // n insuffisant : jamais interprété
  if (!clean.some((r) => r.e)) return emptyResult(p, n); // aucun événement

  // 2. Centrage-réduction (stabilité numérique) ; colonnes constantes écartées.
  const means = new Array<number>(p).fill(0);
  const sds = new Array<number>(p).fill(0);
  for (let k = 0; k < p; k++) {
    const col = clean.map((r) => r.x[k]!);
    const m = col.reduce((a, b) => a + b, 0) / n;
    means[k] = m;
    const v = col.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
    sds[k] = Math.sqrt(v);
  }
  const active = sds.map((s) => s > 0);
  const pa = active.filter(Boolean).length;
  if (pa === 0) return emptyResult(p, n);

  const rows: CleanRow[] = clean
    .map((r) => ({
      t: r.t,
      e: r.e,
      x: r.x
        .map((v, k) => ((v - means[k]!) / sds[k]!) as number)
        .filter((_, k) => active[k]),
    }))
    .sort((a, b) => a.t - b.t);

  // 3. Newton-Raphson avec recherche linéaire (max 100 itérations).
  let beta = new Array<number>(pa).fill(0);
  let prevLl = -Infinity;
  let converged = false;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const { ll, grad, hess } = partialLikelihood(rows, beta);
    if (!Number.isFinite(ll)) break;
    // Déjà à l'optimum : le gradient est nul (la recherche linéaire
    // exigerait sinon une amélioration stricte impossible).
    const maxGrad = Math.max(...grad.map((g) => Math.abs(g)));
    if (maxGrad < TOL_GRAD) {
      converged = true;
      prevLl = ll;
      break;
    }
    const step = solveLinear(hess, grad);
    if (step == null) break; // Hessien singulier : non-convergence
    // Recherche linéaire : on accepte un pas qui n'améliore pas strictement
    // mais ne dégrade pas (près de l'optimum, l'amélioration tombe sous le
    // bruit flottant) ; la convergence est tranchée par |Δll| / |pas|.
    let alpha = 1;
    let newBeta: number[] | null = null;
    let newLl = -Infinity;
    for (let ls = 0; ls < 12; ls++) {
      const cand = beta.map((b, k) => b + alpha * step[k]!);
      const r = partialLikelihood(rows, cand);
      if (Number.isFinite(r.ll) && r.ll >= ll - 1e-9) {
        newBeta = cand;
        newLl = r.ll;
        break;
      }
      alpha /= 2;
    }
    if (newBeta == null) break; // aucun pas acceptable : non-convergence
    const maxStep = Math.max(...newBeta.map((b, k) => Math.abs(b - beta[k]!)));
    beta = newBeta;
    if (maxStep < TOL_STEP || Math.abs(newLl - prevLl) < TOL_LLIK) {
      converged = true;
      prevLl = newLl;
      break;
    }
    prevLl = newLl;
  }

  if (!converged) return emptyResult(p, n);

  // 4. Erreurs-types : diagonale de l'inverse du Hessien final.
  const { hess } = partialLikelihood(rows, beta);
  const seStd = new Array<number>(pa).fill(NaN);
  // Inverse via résolution colonne par colonne.
  const inv: number[][] = [];
  let invertible = true;
  for (let c = 0; c < pa; c++) {
    const e = new Array<number>(pa).fill(0);
    e[c] = 1;
    const col = solveLinear(hess, e);
    if (col == null) {
      invertible = false;
      break;
    }
    inv.push(col);
  }
  if (invertible) {
    for (let k = 0; k < pa; k++) {
      const v = inv[k]![k]!;
      seStd[k] = v > 0 ? Math.sqrt(v) : NaN;
    }
  }

  // 5. Reconversion à l'échelle d'origine.
  const coef = new Array<number>(p).fill(0);
  const se = new Array<number>(p).fill(NaN);
  const hr = new Array<number>(p).fill(1);
  const pWald = new Array<number>(p).fill(NaN);
  let ai = 0;
  for (let k = 0; k < p; k++) {
    if (!active[k]) continue; // colonne constante : coef 0, se NaN
    const b = beta[ai]! / sds[k]!;
    const s = seStd[ai]! / sds[k]!;
    coef[k] = b;
    se[k] = s;
    hr[k] = Math.exp(b);
    if (Number.isFinite(s) && s > 0) {
      const z = Math.abs(b / s);
      pWald[k] = 2 * (1 - phi(z));
    }
    ai++;
  }

  // 6. Concordance sur les scores de risque (échelle d'origine).
  const scores = clean.map((r) =>
    r.x.reduce((acc, v, k) => acc + v * coef[k]!, 0),
  );
  const concordance = harrellC(
    clean.map((r) => r.t),
    clean.map((r) => r.e),
    scores,
  );

  return { coef, hr, se, pWald, concordance, converged: true, n };
}

/**
 * Courbe de Kaplan-Meier : [{t: 0, s: 1}, ...] aux temps d'événement
 * distincts (t > 0). S(t) = Π (1 - d_i / n_i). Les censures réduisent
 * l'ensemble à risque sans faire chuter la courbe.
 */
export function kaplanMeier(
  durations: number[],
  events: boolean[],
): Array<{ t: number; s: number }> {
  const pts: Array<{ t: number; e: boolean }> = [];
  for (let i = 0; i < durations.length; i++) {
    const t = durations[i]!;
    if (t > 0 && Number.isFinite(t)) pts.push({ t, e: events[i] === true });
  }
  pts.sort((a, b) => a.t - b.t);
  const out: Array<{ t: number; s: number }> = [{ t: 0, s: 1 }];
  let s = 1;
  let i = 0;
  while (i < pts.length) {
    const t = pts[i]!.t;
    let d = 0;
    let j = i;
    while (j < pts.length && pts[j]!.t === t) {
      if (pts[j]!.e) d++;
      j++;
    }
    const atRisk = pts.length - i;
    if (d > 0) {
      s *= 1 - d / atRisk;
      out.push({ t, s });
    }
    i = j;
  }
  return out;
}
