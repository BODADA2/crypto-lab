/**
 * Cycle de recherche autonome du moteur paper (§1, §2, §9).
 *
 * Un cycle :
 * 1. détermine le régime de marché (données réelles, lab/collect/chainregime.ts) ;
 * 2. vérifie le HALT (drawdown) et le budget de risque ;
 * 3. charge des candidats depuis les VRAIES données (data/history/) ;
 * 4. applique le pipeline de sélection (SÉCURITÉ → LIQUIDITÉ → ON-CHAIN → MARCHÉ → NARRATIF) ;
 * 5. score les survivants (10 dimensions) et ouvre des décisions ou des NO_TRADE ;
 * 6. simule les clôtures en walk-forward strict sur les barres suivantes (jamais de lookahead) ;
 * 7. alimente le ledger et déclenche l'apprentissage par blocs de 20.
 *
 * INTERDICTIONS : aucune donnée fabriquée ; INCONNU quand c'est absent ;
 * données insuffisantes → NO_TRADE (§12). Aucune transaction réelle — ce module
 * ne connaît même pas l'exécuteur.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UNKNOWN_AUTHORITY, type TokenSnapshot } from "../collect/types.ts";
import { loadBlocklist } from "../signals/devblocklist.ts";
import { computeVolumeSignal } from "../signals/volume.ts";
import {
  acceleratingTermsByDay,
  createsToDocs,
  scoreTokensWalkForward,
} from "../signals/catalyst.ts";
import type { TermStat } from "../signals/narrative.ts";
import { adaptationForRegime, ENGINE } from "./config.ts";
import {
  cancelDecision,
  closeDecision,
  computeMetrics,
  currentDrawdownPct,
  equityCurve,
  loadLedger,
  markLearnedThrough,
  nextDecisionId,
  openDecision,
  unlearnedCloses,
} from "./ledger.ts";
import { analyzeBlock } from "./learn.ts";
import { determineRegime } from "./regime.ts";
import { scoreCandidate } from "./score.ts";
import type {
  CycleSummary,
  DecisionClose,
  ExitReason,
  PaperDecision,
  PriceTarget,
} from "./types.ts";

export interface CycleOptions {
  rootDir: string;
  cycleId: string;
  maxTokens?: number;
  minBars?: number;
  forwardBars?: number;
  chain?: string;
}

interface Bar extends TokenSnapshot {
  fetchedAt: string;
}

function readJsonl<T>(path: string): T[] {
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* ignorée */
    }
  }
  return out;
}

interface Candidate {
  mint: string;
  bars: Bar[];
  decisionIdx: number;
  last: Bar;
}

/** Charge les candidats : fichiers data/history triés par mint (déterministe).
 * Les historiques sont clairsemés (1 à ~20 barres par token) : on exige au moins
 * 3 barres d'historique + 1 barre future ; le point de décision laisse jusqu'à
 * 12 barres futures pour la simulation walk-forward. Pas de lookahead. */
function loadCandidates(rootDir: string, maxTokens: number, minBars: number, forwardBars: number): Candidate[] {
  const dir = join(rootDir, "data", "history");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .slice(0, maxTokens * 4); // marge : certains seront rejetés (trop peu de barres)
  const out: Candidate[] = [];
  for (const f of files) {
    if (out.length >= maxTokens) break;
    const bars = readJsonl<Bar>(join(dir, f)).filter(
      (b) => b.priceUsd > 0 && b.fetchedAt,
    );
    // minBars barres d'historique + au moins 1 barre future pour la simulation.
    if (bars.length < minBars + 1) continue;
    bars.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const forwardWanted = Math.min(forwardBars, bars.length - minBars);
    const decisionIdx = bars.length - 1 - forwardWanted;
    const first = bars[0];
    const last = bars[decisionIdx];
    if (!first || !last || decisionIdx < minBars - 1) continue;
    out.push({ mint: first.mint, bars, decisionIdx, last });
  }
  return out;
}

interface CreateEvent {
  kind: string;
  mint: string;
  name?: string;
  symbol?: string;
  receivedAt?: string;
}

/** Termes en accélération par jour (walk-forward), pré-calculés une fois par cycle. */
function catalystTermsByDay(rootDir: string, days: string[]): Map<string, TermStat[]> {
  const scansDir = join(rootDir, "data", "scans");
  const empty = new Map<string, TermStat[]>();
  if (!existsSync(scansDir)) return empty;
  const creates: { name: string; symbol: string; receivedAt: string }[] = [];
  for (const f of readdirSync(scansDir).filter((f) => /^pump-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))) {
    for (const e of readJsonl<CreateEvent>(join(scansDir, f))) {
      if (e.kind === "create" && e.receivedAt) {
        creates.push({ name: e.name ?? "", symbol: e.symbol ?? "", receivedAt: e.receivedAt });
      }
    }
  }
  if (!creates.length || !days.length) return empty;
  const docs = createsToDocs(creates);
  return acceleratingTermsByDay(docs, [...days].sort());
}

interface GateResult {
  pass: boolean;
  reasons: string[];
  unknowns: string[];
}

/** Pipeline de sélection §2. Chaque porte documente ses raisons et ses INCONNU. */
function runGates(c: Candidate, minLiq: number, minAgeMin: number): GateResult {
  const reasons: string[] = [];
  const unknowns: string[] = [];
  const last = c.last;

  // SÉCURITÉ — autorités actives = élimination immédiate (risque critique).
  const mint = last.mintAuthority as string | null | undefined;
  const freeze = last.freezeAuthority as string | null | undefined;
  const activeAuth = [mint, freeze].filter(
    (a) => a !== null && a !== undefined && a !== UNKNOWN_AUTHORITY,
  );
  if (activeAuth.length > 0) {
    return { pass: false, reasons: [`SÉCURITÉ : autorité active (${activeAuth.length}) — risque critique`], unknowns };
  }
  if (mint === UNKNOWN_AUTHORITY || freeze === UNKNOWN_AUTHORITY) {
    unknowns.push("autorités mint/freeze non vérifiées on-chain");
  }

  // LIQUIDITÉ
  if (!(last.liquidityUsd > 0)) {
    return { pass: false, reasons: ["LIQUIDITÉ : liquidité inconnue (INCONNU)"], unknowns };
  }
  if (last.liquidityUsd < minLiq) {
    return {
      pass: false,
      reasons: [`LIQUIDITÉ : ${Math.round(last.liquidityUsd)} $ < ${minLiq} $`],
      unknowns,
    };
  }

  // ON-CHAIN — concentration mesurée uniquement (100 = inconnu → INCONNU, pas un refus ici ;
  // le score `risque` pénalise déjà l'aveuglement, et la criticité exige une preuve mesurée).
  const t10 = last.top10Pct;
  if (t10 < 100 && t10 > ENGINE.maxTop10Pct) {
    return { pass: false, reasons: [`ON-CHAIN : top10 mesuré à ${t10.toFixed(1)} % > ${ENGINE.maxTop10Pct} %`], unknowns };
  }
  if (t10 >= 100) unknowns.push("concentration top10 inconnue");
  if (last.holders === null || last.holders === undefined) unknowns.push("nombre de holders inconnu");
  unknowns.push("wallet du deployer inconnu (pas de vérification H-BLOCK possible)");

  // MARCHÉ — âge, volume, momentum mesurable.
  const ageMin = last.pairCreatedAt
    ? (Date.parse(last.fetchedAt) - last.pairCreatedAt) / 60_000
    : null;
  if (ageMin !== null && ageMin < minAgeMin) {
    return { pass: false, reasons: [`MARCHÉ : âge ${ageMin.toFixed(1)} min < ${minAgeMin} min`], unknowns };
  }
  if (ageMin === null) unknowns.push("âge du token inconnu");
  const v1h = last.volume1h ?? last.volume?.h1 ?? 0;
  if (!(v1h > 0)) {
    return { pass: false, reasons: ["MARCHÉ : volume 1h inconnu ou nul"], unknowns };
  }

  // NARRATIF — pas de porte dure (backtest H-NARR v2 : NO ACTION) ; l'absence de données
  // sociales est un INCONNU qui pèse sur la couverture du score, pas une élimination.
  unknowns.push("données sociales (mentions, engagement) non collectées");
  return { pass: true, reasons, unknowns };
}

function decideSetup(c: Candidate, z: number | null): string {
  if (z !== null && z >= 2) return "volume-zscore";
  const px = c.bars.slice(0, c.decisionIdx + 1).map((b) => b.priceUsd).filter((p) => p > 0).slice(-13);
  const lastPx = px[px.length - 1] ?? 0;
  if (px.length >= 13 && lastPx > Math.max(...px.slice(0, -1))) return "structure-breakout";
  return "score-composite";
}

interface SimClose {
  close: Omit<DecisionClose, "decisionId" | "closedAt" | "drawdownPct" | "setup" | "marketConditions" | "error">;
  barsUsed: number;
}

/** Simulation de clôture en walk-forward strict (barres post-décision uniquement). */
export function simulateClose(
  bars: Bar[],
  fromIdx: number,
  d: PaperDecision,
  stopPct: number,
): SimClose {
  const cost = ENGINE.entryCostPct / 200; // moitié à l'entrée, moitié à la sortie
  const entryRaw = d.entryPriceUsd!;
  const entryEff = entryRaw * (1 + cost);
  const stopPrice = entryRaw * (1 - stopPct / 100);
  const tps = d.targets;
  const taken = new Set<string>();
  let remaining = 1;
  let mfe = 1;
  let mae = 1;
  const partialExits: SimClose["close"]["partialExits"] = [];
  let exitReason: ExitReason = "time_stop";
  let lastIdx = fromIdx;
  const endIdx = Math.min(fromIdx + ENGINE.timeStopBars, bars.length - 1);

  const exitAt = (share: number, price: number, level: string) => {
    const eff = price * (1 - cost);
    partialExits.push({ level, share, priceUsd: eff });
    remaining = Math.max(0, remaining - share);
  };

  for (let i = fromIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const p = bar.priceUsd;
    if (!(p > 0)) continue;
    lastIdx = i;
    mfe = Math.max(mfe, p / entryRaw);
    mae = Math.min(mae, p / entryRaw);
    if (p <= stopPrice && remaining > 0) {
      exitAt(remaining, stopPrice, "stop");
      exitReason = "stop";
      break;
    }
    for (const tp of tps) {
      if (remaining <= 0) break;
      if (!taken.has(tp.label) && p >= tp.priceUsd) {
        taken.add(tp.label);
        exitAt(Math.min(tp.exitShare, remaining), tp.priceUsd, tp.label.toLowerCase());
      }
    }
    if (remaining <= 0) break;
  }
  if (remaining > 0) {
    const lastBar = bars[lastIdx];
    const lp = lastBar && lastBar.priceUsd > 0 ? lastBar.priceUsd : entryRaw;
    exitAt(remaining, lp, "time_stop");
  }

  let grossFrac = 0;
  for (const e of partialExits) grossFrac += e.share * (e.priceUsd / entryEff - 1);
  const resultPct = grossFrac * 100;
  const t0 = Date.parse(bars[fromIdx]?.fetchedAt ?? "");
  const t1 = Date.parse(bars[lastIdx]?.fetchedAt ?? "");
  const lastExit = partialExits.length ? partialExits[partialExits.length - 1] : undefined;
  return {
    close: {
      exitPriceUsd: lastExit ? lastExit.priceUsd : entryEff,
      resultPct,
      resultR: resultPct / stopPct,
      durationMin: Math.max(0, Math.round((t1 - t0) / 60_000)),
      mfe,
      mae,
      exitReason,
      partialExits,
    },
    barsUsed: lastIdx - fromIdx,
  };
}

export function runCycle(opts: CycleOptions): CycleSummary {
  const {
    rootDir,
    cycleId,
    maxTokens = 300,
    minBars = 3,
    forwardBars = 12,
    chain = "solana",
  } = opts;
  const nowIso = new Date().toISOString();
  const date = nowIso.slice(0, 10);

  // 1. Régime de marché (données réelles).
  const reg = determineRegime(rootDir, chain);
  const adaptation = adaptationForRegime(reg.regime);
  const notApplicable: string[] = [];

  // 2. HALT drawdown (§7).
  const dd = currentDrawdownPct(rootDir);
  const halted = dd >= ENGINE.haltDrawdownPct || adaptation.noNewTrades;
  const haltReason = dd >= ENGINE.haltDrawdownPct
    ? `drawdown ${dd.toFixed(1)} % ≥ ${ENGINE.haltDrawdownPct} % : STOP PAPER TRADING`
    : adaptation.noNewTrades
      ? `régime ${reg.regime} : aucune nouvelle position`
      : null;

  // 3. Candidats.
  const candidates = halted ? [] : loadCandidates(rootDir, maxTokens, minBars, forwardBars);
  const decisionDays = [...new Set(candidates.map((c) => c.last.fetchedAt.slice(0, 10)))].sort();
  const termsByDay = catalystTermsByDay(rootDir, decisionDays);
  const scored = scoreTokensWalkForward(
    candidates.map((c) => ({
      mint: c.mint,
      name: c.last.name ?? "",
      symbol: c.last.symbol ?? "",
      at: c.last.fetchedAt,
    })),
    termsByDay,
  );
  const catalystByMint = new Map([...scored.entries()].map(([m, s]) => [m, s.score]));

  // Blocklist (H-BLOCK) — wallet du dev inconnu dans data/history → INCONNU documenté.
  try {
    loadBlocklist(join(rootDir, "data", "dev-blocklist.json"));
  } catch {
    notApplicable.push("H-BLOCK : blocklist illisible — aucun dev exclu ce cycle");
  }

  const eliminated: CycleSummary["eliminated"] = [];
  const noTradeCount = { n: 0 };
  const noTradeCap = 30;
  let idCounter = 0;
  const newId = () => {
    if (idCounter === 0) {
      const base = nextDecisionId(rootDir);
      idCounter = parseInt(base.slice(3), 10);
    }
    return `PE-${String(idCounter++).padStart(4, "0")}`;
  };

  // Equity et budget de risque.
  const curve = equityCurve(rootDir);
  const lastPt = curve[curve.length - 1];
  let equity = lastPt ? lastPt.equity : ENGINE.virtualCapitalUsd;
  const { closed: prevClosed } = loadLedger(rootDir);
  const sortedPrev = [...prevClosed].sort((a, b) => a.close.closedAt.localeCompare(b.close.closedAt));
  let consecLosses = 0;
  for (let i = sortedPrev.length - 1; i >= 0; i--) {
    const prev = sortedPrev[i];
    if (!prev) break;
    if (prev.close.resultR <= 0) consecLosses++;
    else break;
  }
  const riskPct = consecLosses >= ENGINE.lossStreakHalveAt ? ENGINE.maxRiskPerTradePct / 2 : ENGINE.maxRiskPerTradePct;
  let openRiskUsd = 0; // risque des positions ouvertes ce cycle (les clôtures sont simulées aussitôt)
  const maxSimRisk = (equity * ENGINE.maxSimultaneousRiskPct) / 100;

  const scored2: Array<{ c: Candidate; score: ReturnType<typeof scoreCandidate>; z: number | null; unknowns: string[] }> = [];
  let maxCoverage = 0; // couverture maximale observée ce cycle (diagnostic du plafond de données)

  for (const c of candidates) {
    const gate = runGates(c, ENGINE.minLiquidityUsd * (reg.regime === "LOW LIQUIDITY" ? 2 : 1), ENGINE.minAgeMin);
    if (!gate.pass) {
      eliminated.push({ mint: c.mint, symbol: c.last.symbol, reasons: gate.reasons });
      if (gate.reasons.some((r) => r.includes("INCONNU") || r.includes("inconnu")) && noTradeCount.n < noTradeCap) {
        noTradeCount.n++;
        openDecision(rootDir, {
          id: newId(),
          kind: "no_trade",
          createdAt: nowIso,
          cycleId,
          token: { mint: c.mint, symbol: c.last.symbol, name: c.last.name, chain: c.last.chain ?? chain },
          setup: "n/a",
          entryPriceUsd: null,
          entryAt: null,
          reason: "",
          invalidation: "",
          stopPriceUsd: null,
          stopPct: null,
          targets: [],
          sizeUsd: null,
          riskUsd: null,
          riskPct: null,
          rewardRiskRatio: null,
          cancelConditions: [],
          marketRegime: reg.regime,
          score: null,
          unknowns: gate.unknowns,
          noTradeReason: gate.reasons.join(" ; "),
          status: "open",
          marketCapUsdAtEntry: null,
        });
      }
      continue;
    }
    const series = c.bars.slice(0, c.decisionIdx + 1);
    const vol = computeVolumeSignal(series as TokenSnapshot[]);
    const z = vol.components.zScore;
    const s = scoreCandidate({
      mint: c.mint,
      symbol: c.last.symbol,
      name: c.last.name,
      chain: c.last.chain ?? chain,
      series: series as TokenSnapshot[],
      catalystScore: catalystByMint.get(c.mint) ?? null,
      narrativeAccelRatio: null, // INCONNU : aucune donnée sociale collectée
      blocklisted: false, // INCONNU : wallet du dev absent de data/history
      volumeZScore5m: z,
    });
    const unknowns = [...gate.unknowns];
    for (const d of s.dimensions) if (d.missing) unknowns.push(...d.notes);
    if (s.coverage > maxCoverage) maxCoverage = s.coverage;
    if (s.eliminated) {
      eliminated.push({ mint: c.mint, symbol: c.last.symbol, reasons: [s.eliminationReason!] });
      continue;
    }
    if (s.composite < adaptation.minScore || s.coverage < ENGINE.minCoverage) {
      eliminated.push({
        mint: c.mint,
        symbol: c.last.symbol,
        reasons: [
          `score ${s.composite} < ${adaptation.minScore} ou couverture ${(s.coverage * 100).toFixed(0)} % < ${(ENGINE.minCoverage * 100).toFixed(0)} %`,
        ],
      });
      continue;
    }
    scored2.push({ c, score: s, z, unknowns: [...new Set(unknowns)] });
  }

  scored2.sort((a, b) => b.score.composite - a.score.composite);

  let paperTrades = 0;
  let open = 0;
  const maxOpen = adaptation.maxOpenPositions;
  const errors: string[] = [];

  for (const { c, score: s, z, unknowns } of scored2) {
    if (open >= maxOpen) break;
    const rUsd = (equity * riskPct) / 100;
    if (openRiskUsd + rUsd > maxSimRisk) {
      errors.push(`budget de risque simultané atteint (${maxSimRisk.toFixed(0)} $) — candidats restants ignorés`);
      break;
    }
    const stopPct = adaptation.stopPct;
    const entryRaw = c.last.priceUsd;
    const sizeUsd = rUsd / (stopPct / 100);
    const setup = decideSetup(c, z);
    const targets: PriceTarget[] = [
      { label: "TP1", priceUsd: entryRaw * (1 + ENGINE.tp1Pct / 100), pct: ENGINE.tp1Pct, exitShare: ENGINE.tpShares[0] },
      { label: "TP2", priceUsd: entryRaw * (1 + ENGINE.tp2Pct / 100), pct: ENGINE.tp2Pct, exitShare: ENGINE.tpShares[1] },
      { label: "TP3", priceUsd: entryRaw * (1 + ENGINE.tp3Pct / 100), pct: ENGINE.tp3Pct, exitShare: ENGINE.tpShares[2] },
    ];
    const topDims = [...s.dimensions].sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 3);
    const decision: PaperDecision = {
      id: newId(),
      kind: "trade",
      createdAt: nowIso,
      cycleId,
      token: { mint: c.mint, symbol: c.last.symbol, name: c.last.name, chain: c.last.chain ?? chain },
      setup,
      entryPriceUsd: entryRaw,
      entryAt: c.last.fetchedAt,
      reason: `setup ${setup} — score ${s.composite}/100 (couverture ${(s.coverage * 100).toFixed(0)} %) ; forts : ${topDims.map((d) => `${d.dimension} ${d.score}`).join(", ")}${z !== null ? ` ; z-vol ${z.toFixed(2)}` : ""}`,
      invalidation: `stop ${stopPct} % touché, ou time-stop ${ENGINE.timeStopBars} barres`,
      stopPriceUsd: entryRaw * (1 - stopPct / 100),
      stopPct,
      targets,
      sizeUsd: Math.round(sizeUsd * 100) / 100,
      riskUsd: Math.round(rUsd * 100) / 100,
      riskPct,
      rewardRiskRatio: Math.round((ENGINE.tp1Pct / stopPct) * 100) / 100,
      cancelConditions: [
        "liquidité < 10 000 $ sur re-vérification",
        `drawdown moteur > ${ENGINE.haltDrawdownPct} %`,
        "données corrompues (prix ≤ 0)",
      ],
      marketRegime: reg.regime,
      score: s,
      unknowns,
      noTradeReason: null,
      status: "open",
      marketCapUsdAtEntry: c.last.marketCapUsd ?? null,
    };
    openDecision(rootDir, decision);
    openRiskUsd += rUsd;
    open++;
    paperTrades++;

    // Clôture simulée en walk-forward strict.
    const sim = simulateClose(c.bars, c.decisionIdx, decision, stopPct);
    const closeBar = c.bars[Math.min(c.decisionIdx + sim.barsUsed, c.bars.length - 1)];
    const fullClose: DecisionClose = {
      ...sim.close,
      decisionId: decision.id,
      closedAt: closeBar ? closeBar.fetchedAt : (decision.entryAt ?? new Date().toISOString()),
      drawdownPct: 0, // recalculé via equityCurve après écriture
      setup,
      marketConditions: reg.regime,
      error: "aucune",
    };
    closeDecision(rootDir, fullClose);
    equity += ((decision.sizeUsd ?? 0) * fullClose.resultPct) / 100;
    openRiskUsd -= rUsd;
    if (fullClose.resultR <= 0) consecLosses++;
    else consecLosses = 0;
  }

  // NO_TRADE de cycle si halt.
  if (halted && haltReason) {
    openDecision(rootDir, {
      id: newId(),
      kind: "no_trade",
      createdAt: nowIso,
      cycleId,
      token: { mint: "-", symbol: "-", name: "cycle", chain },
      setup: "n/a",
      entryPriceUsd: null,
      entryAt: null,
      reason: "",
      invalidation: "",
      stopPriceUsd: null,
      stopPct: null,
      targets: [],
      sizeUsd: null,
      riskUsd: null,
      riskPct: null,
      rewardRiskRatio: null,
      cancelConditions: [],
      marketRegime: reg.regime,
      score: null,
      unknowns: [],
      noTradeReason: haltReason,
      status: "open",
      marketCapUsdAtEntry: null,
    });
    errors.push(haltReason);
  }

  const metrics = computeMetrics(rootDir);
  const { closed } = loadLedger(rootDir);
  const wins = closed.filter((d) => d.cycleId === cycleId && d.close.resultR > 0).length;
  const losses = closed.filter((d) => d.cycleId === cycleId && d.close.resultR <= 0).length;

  // Tokens "nouveaux" : créés dans les 7 jours avant la fin de la fenêtre de décision.
  const maxDecisionDate = decisionDays.length ? (decisionDays[decisionDays.length - 1] ?? date) : date;
  const cutoff = Date.parse(maxDecisionDate) - 7 * 86400_000;
  const newTokens = candidates.filter((c) => {
    const first = c.bars[0];
    return first ? Date.parse(first.fetchedAt) >= cutoff : false;
  }).length;

  // 7. Apprentissage par blocs de 20 (§5).
  const adjustments: string[] = [];
  const hypothesesToTest: string[] = [];
  const unlearned = unlearnedCloses(rootDir);
  if (unlearned.length >= ENGINE.learnBlockSize) {
    const analysis = analyzeBlock(unlearned.slice(0, ENGINE.learnBlockSize));
    adjustments.push(...analysis.notes);
    hypothesesToTest.push(...analysis.hypotheses);
    // Aucun ajustement automatique sans preuve n≥30 sur données séparées (learn.ts).
    const lastBlock = unlearned[ENGINE.learnBlockSize - 1];
    if (lastBlock) markLearnedThrough(rootDir, lastBlock.id);
  } else {
    hypothesesToTest.push(
      `bloc d'apprentissage incomplet (${unlearned.length}/${ENGINE.learnBlockSize} clôtures) — aucune conclusion`,
    );
  }

  // Diagnostic du plafond de données : si aucun trade n'est possible parce que la
  // couverture maximale observée reste sous le seuil, c'est un fait à rapporter,
  // pas un paramètre à assouplir (§12 : données insuffisantes → NO_TRADE).
  if (!halted && paperTrades === 0 && candidates.length > 0 && maxCoverage < ENGINE.minCoverage) {
    hypothesesToTest.push(
      `H-DATA-1 : couverture maximale observée ${(maxCoverage * 100).toFixed(0)} % < ${(ENGINE.minCoverage * 100).toFixed(0)} % — ` +
        `aucun token ne peut être évalué avec la collecte actuelle (pas de social, holders null, autorités UNKNOWN). ` +
        `Le moteur restera en NO_TRADE jusqu'à l'ajout de sources ; ne pas baisser le seuil sans preuve n≥30.`,
    );
  }

  if (!existsSync(join(rootDir, "data", "narratives")) || !readdirSync(join(rootDir, "data", "narratives")).length) {
    notApplicable.push("analyse sociale/narrative (mentions, engagement) : aucune donnée collectée — dimension INCONNU");
  }
  notApplicable.push("analyse de contrat on-chain (bytecode, taxes) : aucune donnée collectée — autorités toujours UNKNOWN");
  notApplicable.push("wallets deployer/insiders : data/history ne contient pas le wallet du dev — H-BLOCK inopérant sur ces données");

  return {
    cycleId,
    date,
    marketRegime: reg.regime,
    regimeNote: `${reg.note} (adaptation : ${adaptation.note})`,
    tokensAnalyzed: candidates.length,
    newTokens,
    eliminated,
    noTrades: halted ? 1 : candidates.length - paperTrades,
    noTradesPersisted: noTradeCount.n + (halted ? 1 : 0),
    paperTrades,
    wins,
    losses,
    open: 0, // les clôtures sont simulées aussitôt en walk-forward (papier historique)
    metrics,
    errors,
    adjustments,
    hypothesesToTest,
    opportunities: [],
    notApplicable,
    halted,
  };
}

/** Marque les décisions ouvertes restantes comme annulées (fin de cycle). */
export function finalizeCycle(rootDir: string, reason: string): void {
  const { decisions } = loadLedger(rootDir);
  for (const d of decisions) {
    if (d.status === "open" && d.kind === "trade") cancelDecision(rootDir, d.id, reason);
  }
}
