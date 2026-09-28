/**
 * Prototype FAST LANE — observation uniquement.
 *
 *   npx tsx lab/collect/fastlane-prototype.ts --duration-min 45
 *
 * Auth : via le skill ~/workspace/skills/helius (CLI helius_rpc_url.py) —
 * plus aucune variable d'environnement à fournir. Le surrogate court-terme est
 * régénéré à chaque reconnexion WebSocket si besoin.
 *
 * Écoute les logs du programme Pump.fun via le WebSocket Helius (standard),
 * détecte les créations de tokens en quasi-temps réel et mesure la latence
 * de détection. AUCUNE transaction, AUCUN ordre — écrit uniquement dans
 * data/fastlane/ (jamais dans data/scans, data/history ni data/track-unbiased/).
 *
 * Sans authentification (skill helius) : arrêt immédiat avec message explicite (aucune clé
 * inventée, aucune donnée simulée présentée comme réelle).
 */
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runFastlaneDetector,
  latencyPercentiles,
  PUMP_PROGRAM,
  type WsLike,
  type DetectedCreate,
  type FastlaneStats,
} from "./fastlane.ts";
import { getHeliusRpcUrl, HeliusAuthError } from "./helius-auth.ts";
import { createProxyWs } from "./proxy-ws.ts";

const WSS_BASE = "wss://mainnet.helius-rpc.com/";

function usage(): never {
  console.error("Usage: npx tsx lab/collect/fastlane-prototype.ts [--duration-min 45] [--program <addr>]");
  process.exit(2);
}

async function main(): Promise<void> {
  let wsUrl: string;
  try {
    wsUrl = getHeliusRpcUrl(WSS_BASE);
  } catch (e) {
    console.error(
      "FAST LANE bloqué : authentification Helius impossible.\n" +
        (e instanceof HeliusAuthError ? e.message : String(e)) +
        "\nAucune donnée simulée ne sera produite.",
    );
    process.exit(3);
  }

  const args = process.argv.slice(2);
  let durationMin = 45;
  let program = PUMP_PROGRAM;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--duration-min") durationMin = Number(args[++i] ?? NaN);
    else if (args[i] === "--program") program = args[++i] ?? program;
    else usage();
  }
  if (!Number.isFinite(durationMin) || durationMin <= 0 || durationMin > 180) usage();

  const outDir = resolve("data/fastlane");
  mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const outPath = join(outDir, `fastlane-${day}.jsonl`);
  const statsPath = join(outDir, `fastlane-${day}-stats.json`);

  const deadline = Date.now() + durationMin * 60_000;
  console.log(`[fastlane] programme=${program} durée=${durationMin} min → ${outPath}`);
  console.log("[fastlane] OBSERVATION UNIQUEMENT — aucune transaction, aucun ordre.");

  let bytesIn = 0; // octets TLS reçus (mesure du coût WSS : crédits / 0,1 Mo)
  const createWs = (url: string): WsLike => {
    // Le WebSocket natif de Node ignore le proxy d'egress (close 1006) :
    // on tunnellise via CONNECT + TLS + upgrade 101 (aucune dépendance).
    // L'URL complète (surrogate) n'est jamais loggée.
    return createProxyWs(url, {
      onBytesReceived: (n) => {
        bytesIn += n;
      },
    });
  };

  const onCreate = (c: DetectedCreate) => {
    appendFileSync(outPath, JSON.stringify(c) + "\n");
  };

  const fmtStats = (s: FastlaneStats) => {
    const p = latencyPercentiles(s.latenciesMs);
    const elapsed = ((Date.now() - s.startedAt) / 60000).toFixed(1);
    const mb = (bytesIn / 1048576).toFixed(1);
    return (
      `[fastlane] t+${elapsed}min notif=${s.notifications} creates=${s.createsDetected} ` +
      `parseFails=${s.parseFailures} reconnects=${s.reconnects} wsErrors=${s.wsErrors} ` +
      `bytes=${mb}Mo ` +
      (p ? `lat(ms) p50=${p.p50.toFixed(0)} p95=${p.p95.toFixed(0)} p99=${p.p99.toFixed(0)} max=${p.max.toFixed(0)}` : "lat=—")
    );
  };

  const stats = await runFastlaneDetector({
    wsUrl,
    // En cas de fermeture inattendue, régénère le surrogate (court-terme).
    refreshWsUrl: () => getHeliusRpcUrl(WSS_BASE),
    program,
    commitment: "processed",
    createWs,
    onCreate,
    onStats: (s) => console.log(fmtStats(s)),
    statsEveryMs: 60000,
    shouldStop: () => Date.now() >= deadline,
  });

  const p = latencyPercentiles(stats.latenciesMs);
  const summary = {
    program,
    durationMin,
    commitment: "processed",
    endedAt: new Date().toISOString(),
    notifications: stats.notifications,
    createsDetected: stats.createsDetected,
    parseFailures: stats.parseFailures,
    reconnects: stats.reconnects,
    wsErrors: stats.wsErrors,
    latencyMs: p,
    bytesReceived: bytesIn,
    note: "Observation uniquement. Aucune transaction.",
  };
  writeFileSync(statsPath, JSON.stringify(summary, null, 2) + "\n");
  console.log("[fastlane] TERMINÉ");
  console.log(JSON.stringify(summary, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error("[fastlane] ERREUR FATALE:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
