/**
 * Phase 2 — modèles (APRÈS les tests simples, jamais avant).
 *
 *  - Régression logistique : descente de gradient batch, régularisation L2,
 *    features standardisées, pure TypeScript.
 *  - Random forest minimal : bagging d'arbres CART (profondeur <= 4,
 *    mtry = sqrt(p), min 2 échantillons pour splitter), pure TypeScript,
 *    avec précision out-of-bag (OOB).
 *
 * PAS de deep learning. Règle d'honnêteté (appliquée dans run.ts) : si le
 * modèle complexe « gagne » mais que les tests simples (stats.ts) ne montrent
 * rien → résultat marqué SUSPECT, jamais présenté comme un signal.
 */
import { mulberry32 } from "./stats.ts";

export interface ModelInput {
  /** Lignes : features numériques (aucun null — filtré en amont). */
  X: number[][];
  /** Label binaire. */
  y: boolean[];
  featureNames: string[];
}

export interface ModelReport {
  model: "logistic" | "random_forest";
  nTrain: number;
  nFeatures: number;
  trainAcc: number | null;
  trainAUC: number | null;
  /** Précision de la classe majoritaire (plancher à battre). */
  baselineAcc: number | null;
  /** RF uniquement : précision out-of-bag. */
  oobAcc: number | null;
  converged: boolean;
  note: string | null;
}

/* ------------------------------------------------------------------ */
/* Utilitaires */
/* ------------------------------------------------------------------ */

function standardize(X: number[][]): { Xs: number[][]; means: number[]; stds: number[] } {
  const p = X[0]?.length ?? 0;
  const n = X.length;
  const means = new Array<number>(p).fill(0);
  const stds = new Array<number>(p).fill(0);
  for (let j = 0; j < p; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i]![j]!;
    means[j] = s / Math.max(1, n);
  }
  for (let j = 0; j < p; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += (X[i]![j]! - means[j]!) ** 2;
    stds[j] = Math.sqrt(s / Math.max(1, n)) || 1;
  }
  const Xs = X.map((row) => row.map((v, j) => (v - means[j]!) / stds[j]!));
  return { Xs, means, stds };
}

function auc(scores: number[], y: boolean[]): number | null {
  const n = scores.length;
  const nPos = y.filter(Boolean).length;
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) return null;
  const order = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let rankSum = 0;
  order.forEach((idx, pos) => {
    if (y[idx]) rankSum += pos + 1;
  });
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function accuracy(pred: boolean[], y: boolean[]): number {
  let ok = 0;
  for (let i = 0; i < y.length; i++) if (pred[i] === y[i]) ok++;
  return ok / Math.max(1, y.length);
}

/* ------------------------------------------------------------------ */
/* Régression logistique (batch GD + L2) */
/* ------------------------------------------------------------------ */

export function trainLogistic(
  input: ModelInput,
  opts: { lr?: number; iters?: number; l2?: number } = {},
): ModelReport {
  const { lr = 0.1, iters = 2000, l2 = 1.0 } = opts;
  const n = input.X.length;
  const p = input.featureNames.length;
  if (n === 0 || p === 0) {
    return {
      model: "logistic", nTrain: 0, nFeatures: p, trainAcc: null,
      trainAUC: null, baselineAcc: null, oobAcc: null,
      converged: false, note: "pas de données d'entraînement",
    };
  }
  const { Xs } = standardize(input.X);
  const w = new Array<number>(p + 1).fill(0); // dernier = biais
  const sig = (z: number): number => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
  let prevLoss = Infinity;
  let converged = false;
  for (let it = 0; it < iters; it++) {
    const grad = new Array<number>(p + 1).fill(0);
    let loss = 0;
    for (let i = 0; i < n; i++) {
      let z = w[p]!;
      for (let j = 0; j < p; j++) z += w[j]! * Xs[i]![j]!;
      const pr = sig(z);
      const t = input.y[i] ? 1 : 0;
      loss += -(t * Math.log(Math.max(pr, 1e-12)) + (1 - t) * Math.log(Math.max(1 - pr, 1e-12)));
      const err = pr - t;
      for (let j = 0; j < p; j++) grad[j]! += err * Xs[i]![j]!;
      grad[p]! += err;
    }
    loss /= n;
    for (let j = 0; j < p; j++) {
      loss += (l2 / (2 * n)) * w[j]! * w[j]!;
      grad[j]! = grad[j]! / n + (l2 / n) * w[j]!;
    }
    grad[p]! /= n;
    for (let j = 0; j <= p; j++) w[j]! -= lr * grad[j]!;
    if (Math.abs(prevLoss - loss) < 1e-9) {
      converged = true;
      break;
    }
    prevLoss = loss;
  }
  const scores: number[] = [];
  const pred: boolean[] = [];
  for (let i = 0; i < n; i++) {
    let z = w[p]!;
    for (let j = 0; j < p; j++) z += w[j]! * Xs[i]![j]!;
    const pr = sig(z);
    scores.push(pr);
    pred.push(pr >= 0.5);
  }
  const nPos = input.y.filter(Boolean).length;
  return {
    model: "logistic",
    nTrain: n,
    nFeatures: p,
    trainAcc: accuracy(pred, input.y),
    trainAUC: auc(scores, input.y),
    baselineAcc: Math.max(nPos, n - nPos) / n,
    oobAcc: null,
    converged,
    note: converged ? null : "non convergé en 2000 itérations",
  };
}

/* ------------------------------------------------------------------ */
/* Random forest minimal (bagging CART, profondeur <= 4) */
/* ------------------------------------------------------------------ */

interface TreeNode {
  leaf: boolean;
  prob: number; // P(y=1) dans le nœud
  feature?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
}

function gini(counts: [number, number]): number {
  const t = counts[0] + counts[1];
  if (t === 0) return 0;
  const p0 = counts[0] / t;
  const p1 = counts[1] / t;
  return 1 - p0 * p0 - p1 * p1;
}

function buildTree(
  X: number[][],
  y: boolean[],
  idx: number[],
  depth: number,
  maxDepth: number,
  mtry: number,
  rnd: () => number,
): TreeNode {
  let n1 = 0;
  for (const i of idx) if (y[i]) n1++;
  const node: TreeNode = { leaf: true, prob: idx.length ? n1 / idx.length : 0.5 };
  if (depth >= maxDepth || idx.length < 2 || n1 === 0 || n1 === idx.length) return node;

  const p = X[0]?.length ?? 0;
  const feats = new Set<number>();
  while (feats.size < Math.min(mtry, p)) feats.add(Math.floor(rnd() * p));

  let bestGain = 0;
  let bestF = -1;
  let bestT = 0;
  const parentGini = gini([idx.length - n1, n1]);
  for (const f of feats) {
    const vals = idx.map((i) => X[i]![f]!).sort((a, b) => a - b);
    for (let k = 1; k < vals.length; k++) {
      if (vals[k] === vals[k - 1]) continue;
      const t = (vals[k]! + vals[k - 1]!) / 2;
      let l0 = 0, l1 = 0, r0 = 0, r1 = 0;
      for (const i of idx) {
        if (X[i]![f]! <= t) { if (y[i]) l1++; else l0++; }
        else { if (y[i]) r1++; else r0++; }
      }
      const lt = l0 + l1, rt = r0 + r1;
      if (lt === 0 || rt === 0) continue;
      const gain = parentGini - (lt / idx.length) * gini([l0, l1]) - (rt / idx.length) * gini([r0, r1]);
      if (gain > bestGain) { bestGain = gain; bestF = f; bestT = t; }
    }
  }
  if (bestF < 0) return node;
  const li = idx.filter((i) => X[i]![bestF]! <= bestT);
  const ri = idx.filter((i) => X[i]![bestF]! > bestT);
  node.leaf = false;
  node.feature = bestF;
  node.threshold = bestT;
  node.left = buildTree(X, y, li, depth + 1, maxDepth, mtry, rnd);
  node.right = buildTree(X, y, ri, depth + 1, maxDepth, mtry, rnd);
  return node;
}

function predictTree(node: TreeNode, x: number[]): number {
  let c: TreeNode = node;
  while (!c.leaf) {
    c = x[c.feature!]! <= c.threshold! ? c.left! : c.right!;
  }
  return c.prob;
}

export function trainRandomForest(
  input: ModelInput,
  opts: { nTrees?: number; maxDepth?: number; seed?: number } = {},
): ModelReport {
  const { nTrees = 100, maxDepth = 4, seed = 7 } = opts;
  const n = input.X.length;
  const p = input.featureNames.length;
  if (n < 4 || p === 0) {
    return {
      model: "random_forest", nTrain: n, nFeatures: p, trainAcc: null,
      trainAUC: null, baselineAcc: null, oobAcc: null,
      converged: false, note: "données insuffisantes (n<4)",
    };
  }
  const rnd = mulberry32(seed);
  const mtry = Math.max(1, Math.floor(Math.sqrt(p)));
  const trees: TreeNode[] = [];
  const oobVotes: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < nTrees; t++) {
    const bag = new Set<number>();
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n);
      idx.push(j);
      bag.add(j);
    }
    const tree = buildTree(input.X, input.y, idx, 0, maxDepth, mtry, rnd);
    trees.push(tree);
    for (let i = 0; i < n; i++) {
      if (!bag.has(i)) oobVotes[i]!.push(predictTree(tree, input.X[i]!));
    }
  }
  const oobPred: boolean[] = [];
  const oobY: boolean[] = [];
  for (let i = 0; i < n; i++) {
    if (oobVotes[i]!.length === 0) continue;
    const avg = oobVotes[i]!.reduce((a, b) => a + b, 0) / oobVotes[i]!.length;
    oobPred.push(avg >= 0.5);
    oobY.push(input.y[i]!);
  }
  const scores = input.X.map((x) => {
    let s = 0;
    for (const tr of trees) s += predictTree(tr, x);
    return s / trees.length;
  });
  const pred = scores.map((s) => s >= 0.5);
  const nPos = input.y.filter(Boolean).length;
  return {
    model: "random_forest",
    nTrain: n,
    nFeatures: p,
    trainAcc: accuracy(pred, input.y),
    trainAUC: auc(scores, input.y),
    baselineAcc: Math.max(nPos, n - nPos) / n,
    oobAcc: oobY.length ? accuracy(oobPred, oobY) : null,
    converged: true,
    note: null,
  };
}
