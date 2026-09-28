/**
 * Logique de décision pure et déterministe. Zéro random, zéro I/O.
 * Filtres létaux (fail-closed : INCONNU = REJET) puis triggers d'achat.
 */
import type {
  EngineConfig, LethalCheck, Signal, TokenSnapshot, Urgency,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

export function lethalChecks(s: TokenSnapshot, cfg: EngineConfig = DEFAULT_CONFIG): LethalCheck[] {
  const checks: LethalCheck[] = [];

  // 1. Mint / Freeze Authority
  const authActive = s.mintAuthority != null || s.freezeAuthority != null;
  checks.push({
    name: "authorities",
    pass: s.mintAuthority === null && s.freezeAuthority === null,
    detail: authActive
      ? `REJET: mint=${s.mintAuthority ?? "null"} freeze=${s.freezeAuthority ?? "null"}`
      : "mint+freeze authorities désactivées",
  });

  // 2. Liquidité minimale + burn/lock (fail-closed si inconnu)
  const liq = s.liquidityUsd;
  const liqOk = liq != null && liq >= cfg.minLiquidityUsd;
  let lpDetail: string;
  if (liq == null) {
    lpDetail = "REJET: liquidité INCONNUE";
  } else if (liq < cfg.minLiquidityUsd) {
    lpDetail = `REJET: liquidité $${liq.toFixed(0)} < $${cfg.minLiquidityUsd}`;
  } else if (s.migrated === true && s.lpBurnedOrLocked !== true) {
    lpDetail = "REJET: migré mais LP non brûlé/verrouillé (ou inconnu)";
  } else {
    lpDetail = `liquidité $${liq.toFixed(0)}${s.migrated === true ? ", LP brûlé/verrouillé" : ", bonding curve"}`;
  }
  checks.push({
    name: "liquidity",
    pass: liqOk && !(s.migrated === true && s.lpBurnedOrLocked !== true),
    detail: lpDetail,
  });

  // 3. Concentration top 10 (ajustée si dispo, sinon brute)
  const conc = s.top10HolderPctAdj ?? s.top10HolderPctRaw;
  const concOk = conc != null && conc <= cfg.maxTop10HolderPct;
  checks.push({
    name: "holder_concentration",
    pass: concOk,
    detail: conc == null
      ? "REJET: concentration holders INCONNUE"
      : `top10 ${conc.toFixed(1)}% ${concOk ? "≤" : ">"} ${cfg.maxTop10HolderPct}% (${s.holderExclusionMethod})`,
  });

  return checks;
}

/** Triggers déterministes. */
export function buyTriggers(s: TokenSnapshot, cfg: EngineConfig = DEFAULT_CONFIG): string[] {
  const t: string[] = [];
  if (s.velocityUsd2min != null && s.velocityUsd2min >= cfg.velocityTriggerUsd) {
    t.push(`VELOCITY:$${Math.round(s.velocityUsd2min / 1000)}k/2min`);
  }
  if (
    s.curveAccelPct != null && s.curveAccelPct >= cfg.curveAccelTriggerPct &&
    s.narrativeTags.length > 0
  ) {
    t.push(`CURVE_NARRATIVE:+${s.curveAccelPct.toFixed(0)}% [${s.narrativeTags.join(",")}]`);
  }
  if (s.smartWalletNetBuyUsd != null && s.smartWalletNetBuyUsd >= cfg.smartWalletTriggerUsd) {
    t.push(`SMART:$${Math.round(s.smartWalletNetBuyUsd / 1000)}k net`);
  }
  return t;
}

export function confidenceScore(triggers: string[], s: TokenSnapshot): number {
  let c = 50 + 15 * triggers.length;
  if (s.liquidityUsd != null && s.liquidityUsd > 50000) c += 5;
  return Math.min(95, c);
}

export function urgencyOf(triggers: string[]): Urgency {
  if (triggers.length >= 2) return "HIGH";
  if (triggers.length === 1) return "MEDIUM";
  return "LOW";
}

/**
 * Décision pour un token. BUY seulement si : dataQuality OK, tous les
 * filtres létaux passent, ≥1 trigger. Sinon SKIP avec la raison.
 */
export function decide(s: TokenSnapshot, cfg: EngineConfig = DEFAULT_CONFIG): Signal {
  const base = {
    ticker: s.ticker,
    contract: s.mint,
    mode: "PAPER" as const,
    real_execution: false as const,
    timestamp: Date.now(),
    dataQuality: s.dataQuality,
    velocityMethod: s.velocityMethod,
  };

  const skip = (reason: string, lethal?: LethalCheck[], triggers: string[] = []): Signal => ({
    ...base,
    action: "SKIP",
    confidence_score: 0,
    urgency: "LOW",
    position_size_pct: 0,
    stop_loss_pct: cfg.stopLossPct,
    take_profit_levels: [cfg.takeProfitPct, 200, 500],
    reasoning_short: reason,
    lethalChecks: lethal ?? [],
    triggers,
  });

  if (s.dataQuality < cfg.minDataQuality) {
    return skip(`SKIP: dataQuality ${s.dataQuality.toFixed(2)} < ${cfg.minDataQuality}`);
  }

  const checks = lethalChecks(s, cfg);
  const failed = checks.find((c) => !c.pass);
  if (failed) return skip(`SKIP: ${failed.detail}`, checks);

  const triggers = buyTriggers(s, cfg);
  if (triggers.length === 0) {
    return skip("SKIP: filtres OK mais aucun trigger (vélocité/narratif/smart)", checks, triggers);
  }

  const conf = confidenceScore(triggers, s);
  return {
    ...base,
    action: "BUY",
    confidence_score: conf,
    urgency: urgencyOf(triggers),
    position_size_pct: cfg.positionSizePct,
    stop_loss_pct: cfg.stopLossPct,
    take_profit_levels: [cfg.takeProfitPct, 200, 500],
    reasoning_short: `BUY: ${triggers.join(" + ")} | liq $${(s.liquidityUsd ?? 0).toFixed(0)} | conf ${conf}`,
    lethalChecks: checks,
    triggers,
  };
}
