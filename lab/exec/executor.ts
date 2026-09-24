// Exécuteur — la seule boucle qui touche au ledger. Tourne uniquement sur la machine d'Hervé.
// Ordre d'un cycle : intégrité du code → kill switch (cliquet) → politique locale → conditions live → ledger local chaîné
// → cotations réelles → pour chaque intent : vérification locale du token → Risk Engine → ledger PENDING → exécution
// → ledger final → archivage → export du ledger vers le dépôt (écriture seule).
// CLI : npx tsx lab/exec/executor.ts --once --paper   (ou --live, --watch <secondes>, --repo <dépôt de données>)
// Ne JAMAIS lancer via `npm run` : package.json est dans le dépôt (voir README).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutionMode, Intent, LedgerEntry, LedgerFees, LedgerFill, PortfolioState, RiskPolicy, TokenSnapshot } from "../types.ts";
import { evaluate, loadPolicy, resolvePolicyPath, type IntentV2 } from "../risk/engine.ts";
import { isKilled, latchKill } from "./killswitch.ts";
import { computeFees, equityOf, executeBuy, executeSell, type FillParams } from "./paper.ts";
import { verifyIntegrity, type IntegrityResult } from "./integrity.ts";
import { createDefaultVerifier, type LocalVerifier } from "./verify.ts";
import {
  appendChainedLedger,
  exportLedger,
  findOrphanPending,
  loadOrCreateLedgerKey,
  readChainedLedger,
  readLedger,
  rebuildPortfolio,
  writeFileAtomic,
} from "../ledger/ledger.ts";
import {
  ATA_RENT_SOL,
  LAMPORTS_PER_SOL,
  SOL_MINT,
  createJupiterClient,
  loadSigner,
  solPriceFromQuote,
  type JupiterClient,
  type Signer,
} from "../swap/jupiter.ts";

export interface MarketParams {
  fxCadPerUsd: number;
  /** En live, TOUJOURS remplacé par le devis Jupiter SOL→USDC. */
  solPriceUsd: number;
  priorityFeeSol: number;
}

export interface ExecutorOptions {
  /** Dépôt de données (intents/, data/, export du ledger). */
  repoRoot: string;
  /** Racine du code exécuté (défaut : le dépôt contenant ce fichier). Sert à la vérification d'intégrité. */
  codeRoot?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  /** paper par défaut. */
  mode?: ExecutionMode;
  now?: () => Date;
  /** Instantanés du dépôt (défaut : data/tokens/<mint>.json). Uniquement en paper NON vérifié. */
  loadSnapshot?: (mint: string) => TokenSnapshot | null;
  /** Source de marché injectable (FX CAD/USD, priority fee ; SOL en paper). Défaut : Banque du Canada + Jupiter. */
  market?: () => MarketParams | Promise<MarketParams>;
  /** Vérificateur local (RPC + DexScreener). Défaut : construit depuis SOLANA_RPC_URL. */
  verifier?: LocalVerifier;
  /** Exiger un vérificateur même en paper (défaut : false — le paper sans vérificateur est accepté avec avertissement). */
  requireVerifier?: boolean;
  /** Client Jupiter (live). Injecté en test, jamais appelé en paper. */
  jupiter?: JupiterClient;
  /** Signataire (live). Défaut : ~/.crypto-lab/keypair.json. */
  signer?: Signer;
  policyPath?: string;
  log?: (msg: string) => void;
}

export interface ProcessedIntent {
  file: string;
  intentId: string;
  decision: LedgerEntry["decision"];
  reasons: string[];
}

export interface RunResult {
  mode: ExecutionMode;
  killed: boolean;
  killSources: string[];
  integrity?: IntegrityResult;
  /** Erreur bloquante : rien n'a été exécuté. */
  error?: string;
  warnings: string[];
  processed: ProcessedIntent[];
}

export interface Paths {
  intentsDir: string;
  processedDir: string;
  /** Ledger local chaîné : source de vérité unique. */
  ledgerPath: string;
  ledgerKeyPath: string;
  /** Export en écriture seule vers le dépôt. */
  ledgerExportPath: string;
  marketPath: string;
  tokensDir: string;
  keypairPath: string;
}

export function pathsFor(repoRoot: string, home: string): Paths {
  const local = path.join(home, ".crypto-lab");
  return {
    intentsDir: path.join(repoRoot, "intents"),
    processedDir: path.join(repoRoot, "intents", "processed"),
    ledgerPath: path.join(local, "ledger", "trades.jsonl"),
    ledgerKeyPath: path.join(local, "ledger.key"),
    ledgerExportPath: path.join(repoRoot, "ledger", "trades.jsonl"),
    marketPath: path.join(local, "market.json"),
    tokensDir: path.join(repoRoot, "data", "tokens"),
    keypairPath: path.join(local, "keypair.json"),
  };
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isMint = (v: unknown): v is string => typeof v === "string" && BASE58.test(v);

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Lecture d'un instantané du dépôt : mint validé, chemin confiné à data/tokens, liens symboliques refusés. */
function defaultLoadSnapshot(tokensDir: string): (mint: string) => TokenSnapshot | null {
  return (mint) => {
    if (!isMint(mint)) return null;
    const file = path.join(tokensDir, `${mint}.json`);
    if (!isInside(tokensDir, file) || isSymlink(file)) return null;
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf8")) as TokenSnapshot;
    } catch {
      return null;
    }
  };
}

/** Source de marché par défaut : FX Banque du Canada (USD→CAD) ; SOL via Jupiter en live. Jamais de constante. */
export function createDefaultMarket(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): () => Promise<MarketParams> {
  return async () => {
    const priorityFeeSol = Number(env.PRIORITY_FEE_SOL ?? "0.0005");
    if (env.PAPER_FX_CAD_PER_USD || env.PAPER_SOL_PRICE_USD) {
      // Mode paper hors ligne, explicite (voir README) : jamais utilisé en live (solPriceUsd est remplacé, fx contrôlé).
      return { fxCadPerUsd: Number(env.PAPER_FX_CAD_PER_USD), solPriceUsd: Number(env.PAPER_SOL_PRICE_USD), priorityFeeSol };
    }
    const res = await fetchImpl("https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1");
    if (!res.ok) throw new Error(`Banque du Canada ${res.status}`);
    const body = (await res.json()) as { observations?: Array<{ FXUSDCAD?: { v?: string } }> };
    const fx = Number(body.observations?.[0]?.FXUSDCAD?.v);
    if (!Number.isFinite(fx) || fx <= 0) throw new Error("taux FXUSDCAD absent");
    const jup = createJupiterClient({ rpcUrl: env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", fetchImpl, apiKey: env.JUPITER_API_KEY });
    return { fxCadPerUsd: fx, solPriceUsd: await solPriceFromQuote(jup), priorityFeeSol };
  };
}

function listIntentFiles(intentsDir: string): string[] {
  if (!fs.existsSync(intentsDir)) return [];
  return fs
    .readdirSync(intentsDir, { withFileTypes: true })
    .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.endsWith(".json"))
    .map((d) => d.name)
    .sort();
}

function moveToProcessed(paths: Paths, name: string): void {
  fs.mkdirSync(paths.processedDir, { recursive: true });
  let target = path.join(paths.processedDir, name);
  if (fs.existsSync(target)) target = path.join(paths.processedDir, `${Date.now()}-${name}`);
  fs.renameSync(path.join(paths.intentsDir, name), target);
}

interface MarketRecord {
  fxCadPerUsd: number;
  solPriceUsd: number;
  at: string;
}

/** Bornes de vraisemblance : refus si écart > 20 % avec la dernière valeur locale. */
export function checkMarketPlausibility(current: MarketParams, last: MarketRecord | null, maxDeviation = 0.2): string | null {
  for (const [name, v] of [["fxCadPerUsd", current.fxCadPerUsd], ["solPriceUsd", current.solPriceUsd]] as const) {
    if (!Number.isFinite(v) || v <= 0) return `MARCHE_INVALIDE: ${name} = ${String(v)}`;
  }
  if (!Number.isFinite(current.priorityFeeSol) || current.priorityFeeSol < 0) return "MARCHE_INVALIDE: priorityFeeSol";
  if (last) {
    for (const name of ["fxCadPerUsd", "solPriceUsd"] as const) {
      const prev = last[name];
      if (Number.isFinite(prev) && prev > 0 && Math.abs(current[name] / prev - 1) > maxDeviation) {
        return `MARCHE_INVRAISEMBLABLE: ${name} ${current[name]} vs dernière valeur locale ${prev} (écart > ${maxDeviation * 100} %)`;
      }
    }
  }
  return null;
}

interface ExecOutcome {
  fill: LedgerFill;
  fees: LedgerFees;
  pnlCad?: number;
  portfolio: PortfolioState;
}

async function executeLive(
  intent: Intent,
  sizeCad: number,
  snapshot: TokenSnapshot,
  portfolio: PortfolioState,
  market: MarketParams,
  policy: RiskPolicy,
  jupiter: JupiterClient,
  signer: Signer,
  now: Date,
): Promise<ExecOutcome> {
  // decimals provient du RPC (snapshot construit localement), jamais d'un fichier du dépôt ni de l'intent.
  const decimals = snapshot.decimals;
  if (snapshot.source !== "local-verify" || !Number.isInteger(decimals) || (decimals as number) < 0) {
    throw new Error("live : instantané non vérifié localement (decimals RPC requis)");
  }
  const unit = 10 ** (decimals as number);
  const fx = market.fxCadPerUsd;
  const sol = market.solPriceUsd;
  const feeParams: FillParams = {
    priceUsd: snapshot.priceUsd,
    fxCadPerUsd: fx,
    slippageBps: intent.maxSlippageBps,
    solPriceUsd: sol,
    priorityFeeSol: market.priorityFeeSol,
    now,
    timeZone: policy.forbiddenWindow.timeZone,
  };
  const checkImpact = (impactPct: number): void => {
    if (!Number.isFinite(impactPct) || impactPct * 100 > intent.maxSlippageBps || impactPct * 100 > policy.maxSlippageBps) {
      throw new Error(`IMPACT_PRIX: ${impactPct} % > ${Math.min(intent.maxSlippageBps, policy.maxSlippageBps)} bps`);
    }
  };
  const pos = portfolio.positions.find((p) => p.mint === intent.mint);

  if (intent.kind === "BUY") {
    // Borne dure en SOL calculée avec les cotations RÉELLES : jamais plus que le plafond par position.
    const lamports = BigInt(Math.floor((sizeCad / fx / sol) * LAMPORTS_PER_SOL));
    const maxLamports = BigInt(Math.floor((policy.maxPositionSizeCad / fx / sol) * LAMPORTS_PER_SOL));
    if (lamports <= 0n || lamports > maxLamports) throw new Error(`BORNE_SOL: ${lamports} lamports > ${maxLamports}`);
    const quote = await jupiter.getQuote({ inputMint: SOL_MINT, outputMint: intent.mint, amount: lamports, slippageBps: intent.maxSlippageBps });
    checkImpact(quote.priceImpactPct);
    const { swapTransaction } = await jupiter.buildSwapTx(quote, signer.publicKey);
    const signed = await signer.sign(swapTransaction);
    const { txid } = await jupiter.sendTransaction(signed);

    // sizeCad re-dérivé du SOL réellement engagé ; le loyer ATA (nouvelle position) sort aussi du cash et entre au coût.
    const swapCad = (Number(lamports) / LAMPORTS_PER_SOL) * sol * fx;
    const fees = computeFees(swapCad, feeParams);
    if (!pos) {
      fees.ataRentCad = ATA_RENT_SOL * sol * fx;
      fees.totalCad += fees.ataRentCad;
    }
    const grossCad = swapCad + (fees.ataRentCad ?? 0);
    const netCad = grossCad - fees.totalCad;
    const qty = Number(quote.outAmount) / unit;
    if (!(qty > 0) || netCad <= 0) throw new Error("live : quantité reçue nulle ou frais supérieurs au montant");
    const next = structuredClone(portfolio);
    next.cashCad -= grossCad;
    const markCad = qty * snapshot.priceUsd * fx;
    const np = next.positions.find((p) => p.mint === intent.mint);
    if (np) {
      np.qty += qty;
      np.costCad += grossCad;
      np.markCad = np.qty * snapshot.priceUsd * fx;
    } else {
      next.positions.push({ mint: intent.mint, symbol: snapshot.symbol, qty, costCad: grossCad, openedAt: now.toISOString(), markCad, lastPriceUsd: snapshot.priceUsd, markedAt: now.toISOString() });
    }
    next.peakEquityCad = Math.max(next.peakEquityCad, equityOf(next));
    return { portfolio: next, fill: { priceUsd: netCad / fx / qty, fxCadPerUsd: fx, qty, grossCad, netCad, slippageBps: intent.maxSlippageBps, txid }, fees };
  }

  if (!pos) throw new Error("live : aucune position");
  const refPriceCad = snapshot.priceUsd * fx;
  const wanted = sizeCad / refPriceCad;
  const soldQty = wanted >= pos.qty * 0.999 ? pos.qty : wanted;
  const amount = BigInt(Math.floor(soldQty * unit));
  if (amount <= 0n) throw new Error("live : quantité à vendre nulle");
  const quote = await jupiter.getQuote({ inputMint: intent.mint, outputMint: SOL_MINT, amount, slippageBps: intent.maxSlippageBps });
  checkImpact(quote.priceImpactPct);
  const { swapTransaction } = await jupiter.buildSwapTx(quote, signer.publicKey);
  const signed = await signer.sign(swapTransaction);
  const { txid } = await jupiter.sendTransaction(signed);

  // Comptabilité PESSIMISTE tant qu'il n'y a pas de confirmation on-chain : devis × (1 − slippage max) − frais.
  const grossCad = (Number(quote.outAmount) / LAMPORTS_PER_SOL) * sol * fx;
  const fees = computeFees(grossCad, feeParams);
  const netCad = grossCad * (1 - intent.maxSlippageBps / 10_000) - fees.totalCad;
  const sellAll = soldQty >= pos.qty;
  const costRemoved = sellAll ? pos.costCad : pos.costCad * (soldQty / pos.qty);
  const pnlCad = netCad - costRemoved;
  const next = structuredClone(portfolio);
  next.cashCad += netCad;
  const np = next.positions.find((p) => p.mint === intent.mint)!;
  if (sellAll) next.positions = next.positions.filter((p) => p.mint !== intent.mint);
  else {
    np.qty -= soldQty;
    np.costCad -= costRemoved;
    np.markCad = np.qty * refPriceCad;
  }
  next.realizedPnlCad += pnlCad;
  return {
    portfolio: next,
    fill: { priceUsd: grossCad / fx / soldQty, fxCadPerUsd: fx, qty: soldQty, grossCad, netCad, slippageBps: intent.maxSlippageBps, txid },
    fees,
    pnlCad,
  };
}

/** Un cycle complet. Ne lève pas : les erreurs bloquantes sont renvoyées dans `error`. */
export async function runOnce(opts: ExecutorOptions): Promise<RunResult> {
  const mode: ExecutionMode = opts.mode ?? "paper";
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.log(m));
  const paths = pathsFor(opts.repoRoot, home);
  const result: RunResult = { mode, killed: false, killSources: [], warnings: [], processed: [] };
  const warn = (m: string): void => {
    result.warnings.push(m);
    log(`AVERTISSEMENT: ${m}`);
  };
  const fail = (m: string): RunResult => {
    result.error = m;
    log(m);
    return result;
  };

  // 1. Intégrité du code exécuté : refus en live, avertissement en paper.
  const integrity = verifyIntegrity({ home, ...(opts.codeRoot ? { codeRoot: opts.codeRoot } : {}) });
  result.integrity = integrity;
  if (integrity.status !== "sealed") {
    const detail = integrity.status === "unsealed" ? "aucun manifeste scellé (npx tsx lab/exec/seal.ts)" : integrity.changed.join(", ");
    if (mode === "live") return fail(`CODE_NON_SCELLE: ${detail}`);
    warn(`code non scellé (${integrity.status}) : ${detail}`);
  }

  // 2. Kill switch (avec cliquet) : on n'écrit rien, on ne bouge rien.
  const kill = isKilled({ repoRoot: opts.repoRoot, home, env, now });
  if (kill.killed) {
    result.killed = true;
    result.killSources = kill.sources;
    log(`KILL actif (${kill.sources.join(", ")})${kill.latched ? " — cliquet local créé" : ""} — aucune exécution.`);
    return result;
  }

  // 3. Politique locale (jamais depuis le dépôt).
  let policy: RiskPolicy;
  try {
    policy = loadPolicy(opts.policyPath ?? resolvePolicyPath({ home, env }), { repoRoot: opts.repoRoot, home, env });
  } catch (e) {
    return fail(`POLITIQUE: ${(e as Error).message}`);
  }
  const tz = policy.forbiddenWindow.timeZone;

  // 4. Vérificateur local et conditions du mode live (cumulatives, sinon refus total).
  let verifier: LocalVerifier | undefined = opts.verifier;
  if (!verifier && env.SOLANA_RPC_URL) verifier = createDefaultVerifier(env.SOLANA_RPC_URL);
  let jupiter: JupiterClient | undefined;
  let signer: Signer | undefined;
  if (mode === "live") {
    const missing: string[] = [];
    if (env.EXECUTION_MODE !== "live") missing.push("EXECUTION_MODE=live absent");
    if (!fs.existsSync(paths.keypairPath)) missing.push(`clé locale absente (${paths.keypairPath})`);
    if (!verifier) missing.push("vérificateur local absent (SOLANA_RPC_URL)");
    if (missing.length > 0) return fail(`LIVE_REFUSE: ${missing.join(" ; ")}`);
    try {
      signer = opts.signer ?? (await loadSigner(paths.keypairPath));
      jupiter =
        opts.jupiter ??
        createJupiterClient({ rpcUrl: env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", apiKey: env.JUPITER_API_KEY });
    } catch (e) {
      return fail(`LIVE_REFUSE: ${(e as Error).message}`);
    }
  } else if (!verifier) {
    if (opts.requireVerifier) return fail("VERIFICATEUR_ABSENT: SOLANA_RPC_URL requis (ou --unverified pour un paper non vérifié)");
    warn("paper NON vérifié : les instantanés du dépôt sont utilisés tels quels (aucune valeur probante)");
  }
  const loadSnapshot = opts.loadSnapshot ?? defaultLoadSnapshot(paths.tokensDir);

  // 5. Ledger local chaîné. Premier lancement : le ledger du dépôt est importé comme RESTRICTIONS uniquement.
  let key: Buffer;
  try {
    key = loadOrCreateLedgerKey(paths.ledgerKeyPath);
    if (!fs.existsSync(paths.ledgerPath) && fs.existsSync(paths.ledgerExportPath)) {
      const imported = readLedger(paths.ledgerExportPath);
      for (const e of imported) {
        const { seq: _s, prevHmac: _p, hmac: _h, ...rest } = e;
        appendChainedLedger(paths.ledgerPath, key, { ...rest, origin: "repo-import" });
      }
      if (imported.length > 0) warn(`${imported.length} ligne(s) importée(s) du ledger du dépôt (restrictions uniquement : pertes, cadence, doublons)`);
    }
    readChainedLedger(paths.ledgerPath, key);
  } catch (e) {
    const msg = (e as Error).message;
    if ((e as Error).name === "LedgerChainError") {
      latchKill(home, `ledger chain broken: ${msg}`, now());
      return fail(`LEDGER_CHAINE: ${msg} — KILL local créé, revue humaine requise`);
    }
    return fail(`LEDGER: ${msg}`);
  }
  const readLocal = (): LedgerEntry[] => readChainedLedger(paths.ledgerPath, key);
  const append = (entry: LedgerEntry): void => {
    appendChainedLedger(paths.ledgerPath, key, entry);
  };

  // 6. Cotations réelles + vraisemblance vs dernière valeur locale.
  let mk: MarketParams;
  try {
    const source = opts.market ?? createDefaultMarket(env);
    mk = { ...(await source()) };
    if (mode === "live") mk.solPriceUsd = await solPriceFromQuote(jupiter!);
    let last: MarketRecord | null = null;
    if (fs.existsSync(paths.marketPath)) last = JSON.parse(fs.readFileSync(paths.marketPath, "utf8")) as MarketRecord;
    const problem = checkMarketPlausibility(mk, last);
    if (problem) return fail(problem);
    writeFileAtomic(paths.marketPath, JSON.stringify({ fxCadPerUsd: mk.fxCadPerUsd, solPriceUsd: mk.solPriceUsd, at: now().toISOString() } satisfies MarketRecord));
  } catch (e) {
    return fail(`MARCHE: ${(e as Error).message}`);
  }

  // 7. Clôture des PENDING orphelins (exécution interrompue lors d'un cycle précédent).
  for (const orphan of findOrphanPending(readLocal())) {
    append({ ...orphan, ts: now().toISOString(), decision: "FAILED", reasons: ["ORPHELIN: exécution interrompue avant confirmation — à vérifier manuellement"] });
    log(`Orphelin PENDING clôturé en FAILED : ${orphan.intentId}`);
  }

  // Vérification locale, mémorisée par mint pour la durée du cycle.
  const verifiedCache = new Map<string, TokenSnapshot | null>();
  const localSnapshot = async (mint: string): Promise<{ snapshot: TokenSnapshot | null; verified: boolean; error?: string }> => {
    if (!isMint(mint)) return { snapshot: null, verified: false, error: "MINT_INVALIDE" };
    if (!verifier) return { snapshot: loadSnapshot(mint), verified: false };
    if (verifiedCache.has(mint)) return { snapshot: verifiedCache.get(mint) ?? null, verified: true };
    try {
      const s = await verifier.verify(mint, now());
      verifiedCache.set(mint, s);
      return { snapshot: s, verified: true };
    } catch (e) {
      verifiedCache.set(mint, null);
      return { snapshot: null, verified: true, error: `VERIFICATION_IMPOSSIBLE: ${(e as Error).message}` };
    }
  };

  // 8. Intents, un par un, dans l'ordre des noms de fichiers.
  for (const name of listIntentFiles(paths.intentsDir)) {
    const file = path.join(paths.intentsDir, name);
    const at = now();
    let intent: Intent | null = null;
    let parseError: string | undefined;
    if (isSymlink(file)) {
      parseError = "SYMLINK: un intent ne peut pas être un lien symbolique";
    } else {
      try {
        intent = JSON.parse(fs.readFileSync(file, "utf8")) as Intent;
      } catch (e) {
        parseError = `JSON_INVALIDE: ${(e as Error).message}`;
      }
    }

    const intentId = intent && typeof intent.id === "string" ? intent.id : `file:${name}`;
    // Étiquettes v2 (narratif, wallet source) recopiées telles quelles : le Risk Engine s'en sert pour la corrélation
    // entre positions ouvertes (lab/risk/types.ts, LedgerEntryV2Fields).
    const v2 = intent as IntentV2 | undefined;
    const base = {
      intentId,
      mint: intent && typeof intent.mint === "string" ? intent.mint : "?",
      kind: intent && (intent.kind === "BUY" || intent.kind === "SELL" || intent.kind === "NO_ACTION") ? intent.kind : "NO_ACTION",
      mode,
      requestedSizeCad: intent && Number.isFinite(intent.sizeCad) ? intent.sizeCad : 0,
      ...(v2 && typeof v2.narrativeTag === "string" ? { narrativeTag: v2.narrativeTag } : {}),
      ...(v2 && typeof v2.sourceWallet === "string" ? { sourceWallet: v2.sourceWallet } : {}),
    } as const;

    const finish = (decision: LedgerEntry["decision"], reasons: string[], extra: Partial<LedgerEntry> = {}): void => {
      append({ ts: now().toISOString(), ...base, decision, reasons, ...extra });
      moveToProcessed(paths, name);
      result.processed.push({ file: name, intentId, decision, reasons });
      log(`${name} → ${decision}${reasons.length ? ` (${reasons.join(" | ")})` : ""}`);
    };

    if (!intent || parseError) {
      finish("REJECTED", [parseError ?? "JSON_INVALIDE"]);
      continue;
    }

    // Kill switch revérifié avant chaque intent : un fichier KILL déposé pendant le cycle stoppe net.
    const k = isKilled({ repoRoot: opts.repoRoot, home, env, now });
    if (k.killed) {
      result.killed = true;
      result.killSources = k.sources;
      log(`KILL détecté en cours de cycle (${k.sources.join(", ")}) — arrêt.`);
      break;
    }

    let ledger: LedgerEntry[];
    try {
      ledger = readLocal();
    } catch (e) {
      latchKill(home, `ledger chain broken: ${(e as Error).message}`, now());
      result.error = `LEDGER_CHAINE: ${(e as Error).message}`;
      log(result.error);
      break;
    }

    // Instantané construit LOCALEMENT pour le mint de l'intent (mint validé avant tout accès disque/réseau).
    const own = isMint(intent.mint) ? await localSnapshot(intent.mint) : { snapshot: null, verified: false, error: "MINT_INVALIDE" };
    const verified = own.verified;

    // Marques des positions ouvertes : re-vérifiées localement elles aussi (mints validés avant tout accès).
    const provisional = rebuildPortfolio(ledger, { initialCashCad: policy.tradingCapitalCad, mode, timeZone: tz });
    const marksUsd: Record<string, number> = {};
    for (const p of provisional.positions) {
      if (!isMint(p.mint)) continue;
      const s = p.mint === intent.mint ? own.snapshot : (await localSnapshot(p.mint)).snapshot;
      if (s && Number.isFinite(s.priceUsd) && s.priceUsd > 0) marksUsd[p.mint] = s.priceUsd;
    }
    const portfolio = rebuildPortfolio(ledger, { initialCashCad: policy.tradingCapitalCad, mode, timeZone: tz, marksUsd, fxCadPerUsd: mk.fxCadPerUsd });

    const verdict = evaluate(intent, portfolio, own.snapshot, policy, at, ledger);
    if (!verdict.allowed) {
      finish("REJECTED", own.error ? [own.error, ...verdict.reasons] : verdict.reasons, { verified });
      continue;
    }
    const sizeCad = verdict.adjustedSizeCad ?? intent.sizeCad;

    // Journal AVANT exécution.
    append({ ts: at.toISOString(), ...base, decision: "PENDING", reasons: [], sizeCad, verified });

    try {
      const snap = own.snapshot as TokenSnapshot;
      let out: ExecOutcome;
      if (mode === "paper") {
        const params: FillParams = {
          priceUsd: snap.priceUsd,
          fxCadPerUsd: mk.fxCadPerUsd,
          slippageBps: intent.maxSlippageBps,
          solPriceUsd: mk.solPriceUsd,
          priorityFeeSol: mk.priorityFeeSol,
          now: at,
          timeZone: tz,
          symbol: snap.symbol,
        };
        const r = intent.kind === "BUY" ? executeBuy(portfolio, intent, sizeCad, params) : executeSell(portfolio, intent, sizeCad, params);
        out = { fill: r.fill, fees: r.fees, portfolio: r.portfolio, ...(r.pnlCad !== undefined ? { pnlCad: r.pnlCad } : {}) };
      } else {
        out = await executeLive(intent, sizeCad, snap, portfolio, mk, policy, jupiter!, signer!, at);
      }
      // Journal APRÈS exécution.
      finish(mode === "paper" ? "PAPER" : "EXECUTED", [], {
        sizeCad,
        fill: out.fill,
        fees: out.fees,
        ...(out.pnlCad !== undefined ? { pnlCad: out.pnlCad } : {}),
        equityAfterCad: equityOf(out.portfolio),
        verified,
      });
    } catch (e) {
      finish("FAILED", [`EXECUTION: ${(e as Error).message}`], { sizeCad, verified });
    }
  }

  // 9. Export en écriture seule vers le dépôt (Claude le lit ; l'exécuteur ne le relit jamais).
  try {
    exportLedger(paths.ledgerPath, paths.ledgerExportPath);
  } catch (e) {
    warn(`export du ledger impossible : ${(e as Error).message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { once: boolean; mode: ExecutionMode; watchSeconds: number; repoRoot?: string; unverified: boolean } {
  let once = false;
  let mode: ExecutionMode = "paper";
  let watchSeconds = 60;
  let repoRoot: string | undefined;
  let unverified = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") once = true;
    else if (a === "--paper") mode = "paper";
    else if (a === "--live") mode = "live";
    else if (a === "--unverified") unverified = true;
    else if (a === "--watch") watchSeconds = Math.max(5, Number(argv[++i] ?? 60) || 60);
    else if (a === "--repo") repoRoot = argv[++i];
  }
  return { once, mode, watchSeconds, unverified, ...(repoRoot ? { repoRoot } : {}) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.repoRoot ? path.resolve(args.repoRoot) : path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const run = async (): Promise<void> => {
    const r = await runOnce({ repoRoot, mode: args.mode, requireVerifier: !args.unverified });
    console.log(JSON.stringify({ mode: r.mode, killed: r.killed, integrity: r.integrity?.status, error: r.error ?? null, warnings: r.warnings.length, processed: r.processed.length }));
  };
  if (args.once) {
    await run();
    return;
  }
  console.log(`Exécuteur en boucle (${args.mode}) toutes les ${args.watchSeconds} s. Ctrl+C ou fichier KILL pour arrêter (l'environnement est figé : CRYPTO_LAB_KILL ne peut plus être ajouté à ce processus).`);
  for (;;) {
    await run();
    await new Promise((r) => setTimeout(r, args.watchSeconds * 1000));
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
