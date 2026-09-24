// Grille TRADE vs BUILD (chantier 8, codée avec le chantier 4) — 12 critères notés 1..5 pour chaque option.
//
// Convention : 5 = très favorable à l'option, 1 = très défavorable. Chaque critère porte un poids public (défaut 1).
// Sortie : TRADE | BUILD | TRADE_AND_BUILD | NO_ACTION, avec les totaux, les seuils et une explication ligne par ligne.
// Seuils explicites (modifiables par l'appelant, jamais implicites) :
//   - minScorePct : total ≥ 60 % du maximum pour qu'une option soit « viable » ;
//   - marginPct  : écart ≥ 10 % du maximum pour préférer une option à l'autre ; sinon les deux (si viables).
//   - veto : un critère « risque » ou « capital » noté 1 rend l'option non viable, quel que soit le total.

export const TRADE_VS_BUILD_CRITERIA = [
  "vitesse",
  "capital",
  "concurrence",
  "difficulte",
  "traction",
  "potentiel",
  "avantageInformationnel",
  "cout",
  "risque",
  "temps",
  "automatisation",
  "revenus",
] as const;

export type Criterion = (typeof TRADE_VS_BUILD_CRITERIA)[number];

export const CRITERION_LABELS: Record<Criterion, string> = {
  vitesse: "vitesse d'exécution (délai avant résultat)",
  capital: "capital requis (5 = presque rien)",
  concurrence: "concurrence (5 = faible)",
  difficulte: "difficulté (5 = facile)",
  traction: "traction observée (demande réelle)",
  potentiel: "potentiel (plafond du gain)",
  avantageInformationnel: "avantage informationnel (ce qu'on sait que les autres ignorent)",
  cout: "coût d'un échec (5 = faible)",
  risque: "risque de perte totale (5 = faible)",
  temps: "temps humain requis (5 = peu)",
  automatisation: "automatisable (5 = entièrement)",
  revenus: "revenus récurrents (5 = oui, durables)",
};

/** Critères dont une note de 1 rend l'option non viable. */
export const VETO_CRITERIA: readonly Criterion[] = ["risque", "capital"];

export type Score15 = 1 | 2 | 3 | 4 | 5;

export interface CriterionScores {
  trade: Score15;
  build: Score15;
  note?: string;
}

export type TradeVsBuildInput = Record<Criterion, CriterionScores>;

export interface TradeVsBuildOptions {
  /** Poids par critère (défaut 1 partout). */
  weights?: Partial<Record<Criterion, number>>;
  /** Viabilité : total ≥ minScorePct × max. Défaut 60. */
  minScorePct?: number;
  /** Préférence : écart ≥ marginPct × max. Défaut 10. */
  marginPct?: number;
}

export type TradeVsBuildDecision = "TRADE" | "BUILD" | "TRADE_AND_BUILD" | "NO_ACTION";

export interface TradeVsBuildRow {
  criterion: Criterion;
  label: string;
  weight: number;
  trade: number;
  build: number;
  tradeWeighted: number;
  buildWeighted: number;
  note?: string;
}

export interface TradeVsBuildResult {
  decision: TradeVsBuildDecision;
  tradeTotal: number;
  buildTotal: number;
  maxTotal: number;
  tradeViable: boolean;
  buildViable: boolean;
  thresholds: { minScore: number; margin: number; minScorePct: number; marginPct: number };
  vetoes: Array<{ option: "trade" | "build"; criterion: Criterion }>;
  rows: TradeVsBuildRow[];
  problems: string[];
  explanation: string;
}

const isScore = (v: unknown): v is Score15 => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;

/** Pure, ne lève jamais : une grille invalide donne NO_ACTION avec la liste des problèmes. */
export function tradeVsBuild(input: TradeVsBuildInput, opts: TradeVsBuildOptions = {}): TradeVsBuildResult {
  const problems: string[] = [];
  const minScorePct = opts.minScorePct ?? 60;
  const marginPct = opts.marginPct ?? 10;
  const weights: Record<Criterion, number> = Object.fromEntries(TRADE_VS_BUILD_CRITERIA.map((c) => [c, opts.weights?.[c] ?? 1])) as Record<Criterion, number>;
  for (const c of TRADE_VS_BUILD_CRITERIA) {
    const w = weights[c];
    if (!Number.isFinite(w) || w < 0) problems.push(`poids ${c} invalide`);
  }
  if (!input || typeof input !== "object") problems.push("grille absente");

  const rows: TradeVsBuildRow[] = [];
  let tradeTotal = 0;
  let buildTotal = 0;
  let maxTotal = 0;
  const vetoes: TradeVsBuildResult["vetoes"] = [];
  for (const c of TRADE_VS_BUILD_CRITERIA) {
    const s = input && typeof input === "object" ? input[c] : undefined;
    const w = Number.isFinite(weights[c]) && weights[c] >= 0 ? weights[c] : 0;
    if (!s || !isScore(s.trade) || !isScore(s.build)) {
      problems.push(`critère ${c} : notes trade/build entières 1..5 attendues`);
      rows.push({ criterion: c, label: CRITERION_LABELS[c], weight: w, trade: 0, build: 0, tradeWeighted: 0, buildWeighted: 0 });
      continue;
    }
    const tw = s.trade * w;
    const bw = s.build * w;
    tradeTotal += tw;
    buildTotal += bw;
    maxTotal += 5 * w;
    if (VETO_CRITERIA.includes(c) && s.trade === 1) vetoes.push({ option: "trade", criterion: c });
    if (VETO_CRITERIA.includes(c) && s.build === 1) vetoes.push({ option: "build", criterion: c });
    rows.push({ criterion: c, label: CRITERION_LABELS[c], weight: w, trade: s.trade, build: s.build, tradeWeighted: tw, buildWeighted: bw, ...(s.note ? { note: s.note } : {}) });
  }

  const minScore = (minScorePct / 100) * maxTotal;
  const margin = (marginPct / 100) * maxTotal;
  const thresholds = { minScore, margin, minScorePct, marginPct };
  if (problems.length > 0 || maxTotal <= 0) {
    return { decision: "NO_ACTION", tradeTotal, buildTotal, maxTotal, tradeViable: false, buildViable: false, thresholds, vetoes, rows, problems: problems.length > 0 ? problems : ["poids nuls"], explanation: `NO_ACTION : grille invalide (${problems.join(" ; ") || "poids nuls"})` };
  }

  const tradeViable = tradeTotal >= minScore && !vetoes.some((v) => v.option === "trade");
  const buildViable = buildTotal >= minScore && !vetoes.some((v) => v.option === "build");
  let decision: TradeVsBuildDecision;
  if (!tradeViable && !buildViable) decision = "NO_ACTION";
  else if (tradeViable && !buildViable) decision = "TRADE";
  else if (!tradeViable && buildViable) decision = "BUILD";
  else if (tradeTotal - buildTotal >= margin) decision = "TRADE";
  else if (buildTotal - tradeTotal >= margin) decision = "BUILD";
  else decision = "TRADE_AND_BUILD";

  const lines = rows.map((r) => `${r.label} : trade ${r.trade}, build ${r.build}${r.weight !== 1 ? ` (poids ${r.weight})` : ""}${r.note ? ` — ${r.note}` : ""}`);
  const explanation =
    `${decision} — trade ${tradeTotal}/${maxTotal} (${tradeViable ? "viable" : "non viable"}), build ${buildTotal}/${maxTotal} (${buildViable ? "viable" : "non viable"}) ; ` +
    `seuil de viabilité ${minScore} (${minScorePct} %), marge de préférence ${margin} (${marginPct} %)` +
    (vetoes.length > 0 ? ` ; vetos : ${vetoes.map((v) => `${v.option} (${v.criterion} = 1)`).join(", ")}` : "") +
    `.\n${lines.join("\n")}`;
  return { decision, tradeTotal, buildTotal, maxTotal, tradeViable, buildViable, thresholds, vetoes, rows, problems, explanation };
}
