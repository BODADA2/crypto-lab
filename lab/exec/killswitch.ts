// Kill switch — trois sources indépendantes, n'importe laquelle suffit à tout arrêter.
// Cliquet (C4) : dès que le KILL du dépôt est vu, ~/.crypto-lab/KILL est créé. Retirer le KILL du dépôt (par un commit)
// ne réarme donc jamais l'exécution : seul Hervé, à la main, supprime le fichier local.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface KillSwitchInput {
  /** Racine du dépôt (fichier KILL). */
  repoRoot: string;
  /** Répertoire personnel (fichier ~/.crypto-lab/KILL). */
  home?: string;
  /** Variables d'environnement (CRYPTO_LAB_KILL). */
  env?: Record<string, string | undefined>;
  /** Créer le cliquet local quand le KILL du dépôt est vu (défaut : true). */
  latch?: boolean;
  now?: () => Date;
}

export interface KillSwitchResult {
  killed: boolean;
  /** Sources actives : "repo:KILL", "home:~/.crypto-lab/KILL", "env:CRYPTO_LAB_KILL". */
  sources: string[];
  /** Vrai si ce contrôle vient de créer ~/.crypto-lab/KILL à partir du KILL du dépôt. */
  latched?: boolean;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return true; // en cas de doute (droits, E/S), on considère le kill actif
  }
}

/** Valeurs de CRYPTO_LAB_KILL qui NE tuent PAS : vide, 0, false, no, off. Tout le reste tue. */
export function envFlagKills(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v.length > 0 && !["0", "false", "no", "off"].includes(v);
}

/** Écrit ~/.crypto-lab/KILL (idempotent). Utilisé par le cliquet et par les anomalies d'intégrité. */
export function latchKill(home: string, reason: string, now: Date = new Date()): void {
  const file = path.join(home, ".crypto-lab", "KILL");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${reason} at ${now.toISOString()}\n`);
  } catch {
    // impossible d'écrire : le kill reste actif via sa source d'origine
  }
}

/** Vérifie les trois sources. Jamais d'exception : une erreur d'E/S vaut "killed". */
export function isKilled(input: KillSwitchInput): KillSwitchResult {
  const sources: string[] = [];
  const home = input.home ?? os.homedir();
  const env = input.env ?? process.env;
  const localKill = path.join(home, ".crypto-lab", "KILL");

  const repoSeen = exists(path.join(input.repoRoot, "KILL"));
  const homeSeen = exists(localKill);
  if (repoSeen) sources.push("repo:KILL");
  if (homeSeen) sources.push("home:~/.crypto-lab/KILL");
  if (envFlagKills(env.CRYPTO_LAB_KILL)) sources.push("env:CRYPTO_LAB_KILL");

  let latched = false;
  if (repoSeen && !homeSeen && input.latch !== false) {
    latchKill(home, "latched from repo KILL", (input.now ?? (() => new Date()))());
    latched = true;
  }

  return { killed: sources.length > 0, sources, ...(latched ? { latched } : {}) };
}
