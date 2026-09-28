/**
 * Registre des deployers — H-DEV (hypothèse issue de l'interview Deku, 2026-09-28).
 *
 * Deku : son « breakout » (fin nov. 2025) = tracker les devs dont les launches
 * performent et acheter leurs nouveaux tokens en quick-buy, parfois sans même
 * lire le narratif. Ce module systématise ça à partir des données qu'on a déjà :
 *
 *   - `data/scans/pump-<date>.jsonl` (créations + migrations PumpPortal)
 *   - sur les événements "create", `traderPublicKey` = le deployer
 *   - sur les événements "migrate", jointure par mint → crédit de graduation au deployer
 *
 * Sortie : `data/devs/registry.json` = DevProfile[] triés par score.
 * Usage prévu : croiser avec les nouveaux launches (un launch d'un dev scoré haut
 * devient un candidat à examiner — PAS un signal d'achat automatique).
 *
 * Règle du labo : aucune stratégie live sans backtest n ≥ 30 + 30 j de paper.
 * Ce module ne touche ni au Risk Engine, ni à l'exécuteur, ni à la politique.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PumpEvent } from "./types.ts";

export interface DevProfile {
  deployer: string;
  /** Nombre de tokens distincts créés (fenêtre analysée). */
  creates: number;
  /** Nombre de ces tokens ayant migré (graduation pump.fun → DEX). */
  graduations: number;
  /** graduations / creates, 0..1. */
  graduationRate: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** 0..100 : taux de graduation pondéré par la taille de l'échantillon. */
  score: number;
  computedAt: string;
}

export interface DevRegistryOptions {
  /** Nombre minimal de créations pour figurer au registre (défaut 2). */
  minCreates?: number;
  now?: () => number;
}

/**
 * Construit le registre à partir d'événements PumpPortal. Fonction pure (testée).
 * Un deployer n'est crédité d'une graduation que si le mint migré avait été vu
 * en "create" avec son `traderPublicKey` — jamais d'attribution inventée.
 */
export function buildDevRegistry(events: PumpEvent[], opts: DevRegistryOptions = {}): DevProfile[] {
  const minCreates = opts.minCreates ?? 2;
  const now = opts.now ?? (() => Date.now());

  const byDeployer = new Map<string, { mints: Set<string>; graduated: Set<string>; firstSeen: string; lastSeen: string }>();

  for (const ev of events) {
    if (ev.kind !== "create" || !ev.traderPublicKey) continue;
    let d = byDeployer.get(ev.traderPublicKey);
    if (!d) {
      d = { mints: new Set(), graduated: new Set(), firstSeen: ev.receivedAt, lastSeen: ev.receivedAt };
      byDeployer.set(ev.traderPublicKey, d);
    }
    d.mints.add(ev.mint);
    if (ev.receivedAt < d.firstSeen) d.firstSeen = ev.receivedAt;
    if (ev.receivedAt > d.lastSeen) d.lastSeen = ev.receivedAt;
  }

  const mintToDeployer = new Map<string, string>();
  for (const [dep, d] of byDeployer) for (const m of d.mints) if (!mintToDeployer.has(m)) mintToDeployer.set(m, dep);

  for (const ev of events) {
    if (ev.kind !== "migrate") continue;
    const dep = mintToDeployer.get(ev.mint);
    if (dep) byDeployer.get(dep)!.graduated.add(ev.mint);
  }

  const computedAt = new Date(now()).toISOString();
  const out: DevProfile[] = [];
  for (const [deployer, d] of byDeployer) {
    if (d.mints.size < minCreates) continue;
    const graduationRate = d.graduated.size / d.mints.size;
    // Échantillon petit = confiance partielle : 2/2 vaut 40, il faut 5+ créations pour 100.
    const confidence = Math.min(1, d.mints.size / 5);
    out.push({
      deployer,
      creates: d.mints.size,
      graduations: d.graduated.size,
      graduationRate: Math.round(graduationRate * 1000) / 1000,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      score: Math.min(100, Math.round(100 * graduationRate * confidence)),
      computedAt,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.graduations - a.graduations || b.creates - a.creates);
}

/** Lit les événements des fichiers `pump-<date>.jsonl` couvrant `[sinceMs, nowMs]`. */
export function readPumpEvents(scansDir: string, sinceMs: number, nowMs: number): PumpEvent[] {
  const out: PumpEvent[] = [];
  if (!existsSync(scansDir)) return out;
  const days = new Set<string>();
  for (let t = sinceMs; t <= nowMs + 86_400_000; t += 86_400_000) days.add(new Date(t).toISOString().slice(0, 10));
  for (const day of days) {
    const f = join(scansDir, `pump-${day}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as PumpEvent;
        const ts = Date.parse(ev.receivedAt);
        if ((ev.kind === "create" || ev.kind === "migrate") && Number.isFinite(ts) && ts >= sinceMs && ts <= nowMs) out.push(ev);
      } catch {
        /* ligne corrompue : ignorée */
      }
    }
  }
  return out;
}

/** Écrit le registre dans `data/devs/registry.json` (crée le dossier). */
export function writeDevRegistry(profiles: DevProfile[], outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ computedAt: new Date().toISOString(), count: profiles.length, devs: profiles }, null, 2) + "\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = resolve(process.env.DATA_DIR ?? "data");
  const days = Number(process.env.DEV_DAYS ?? 90);
  const minCreates = Number(process.env.DEV_MIN_CREATES ?? 2);
  const nowMs = Date.now();
  const events = readPumpEvents(join(dataDir, "scans"), nowMs - days * 86_400_000, nowMs);
  const profiles = buildDevRegistry(events, { minCreates });
  const outPath = join(dataDir, "devs", "registry.json");
  writeDevRegistry(profiles, outPath);
  console.log(`Registre devs : ${events.length} événements (${days} j) → ${profiles.length} deployers (≥ ${minCreates} créations) → ${outPath}`);
  for (const p of profiles.slice(0, 10)) {
    console.log(`  ${p.deployer.slice(0, 12)}… score ${p.score} — ${p.graduations}/${p.creates} graduations`);
  }
}
