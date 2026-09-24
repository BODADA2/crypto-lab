// Intégrité du code exécuté (C1). Le dépôt est modifiable par le plan analyse ; l'exécuteur ne fait donc pas confiance
// à son propre code tant qu'il ne correspond pas au manifeste scellé par Hervé dans ~/.crypto-lab/exec.manifest.json.
//
// Le manifeste couvre le code RÉELLEMENT chargé (le dossier lab/ qui contient ce fichier) ainsi que package.json,
// package-lock.json et tsconfig.json du même dépôt — pas le dépôt de données passé en --repo.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Manifest {
  version: 1;
  sealedAt: string;
  codeRoot: string;
  /** Chemins relatifs POSIX → sha256 hex. */
  files: Record<string, string>;
}

export interface IntegrityResult {
  status: "sealed" | "unsealed" | "mismatch";
  manifestPath: string;
  codeRoot: string;
  /** Fichiers modifiés, ajoutés (+) ou supprimés (−) par rapport au manifeste. */
  changed: string[];
  sealedAt?: string;
}

const ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.json"];

/** Racine du code = dossier parent de lab/ (celui qui contient ce module). */
export function defaultCodeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function manifestPathFor(home: string = os.homedir()): string {
  return path.join(home, ".crypto-lab", "exec.manifest.json");
}

function walk(dir: string, base: string, out: string[]): void {
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (d.name === "node_modules" || d.name.startsWith(".")) continue;
    const full = path.join(dir, d.name);
    if (d.isSymbolicLink()) {
      out.push(path.posix.join(base, d.name)); // un lien est haché par sa cible textuelle (voir computeManifest)
      continue;
    }
    if (d.isDirectory()) walk(full, path.posix.join(base, d.name), out);
    else if (d.isFile()) out.push(path.posix.join(base, d.name));
  }
}

function hashFile(full: string): string {
  const st = fs.lstatSync(full);
  const data = st.isSymbolicLink() ? Buffer.from(`symlink:${fs.readlinkSync(full)}`) : fs.readFileSync(full);
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Calcule le manifeste courant de lab/** + fichiers racine. Déterministe (tri des chemins). */
export function computeManifest(codeRoot: string, now: Date = new Date()): Manifest {
  const files: Record<string, string> = {};
  const labDir = path.join(codeRoot, "lab");
  const rel: string[] = [];
  if (fs.existsSync(labDir)) walk(labDir, "lab", rel);
  for (const f of ROOT_FILES) if (fs.existsSync(path.join(codeRoot, f))) rel.push(f);
  for (const r of rel.sort()) files[r] = hashFile(path.join(codeRoot, ...r.split("/")));
  return { version: 1, sealedAt: now.toISOString(), codeRoot: path.resolve(codeRoot), files };
}

/** Écrit le manifeste scellé (à lancer par Hervé, après relecture du diff). */
export function sealManifest(opts: { codeRoot?: string; home?: string; now?: Date } = {}): { manifestPath: string; manifest: Manifest } {
  const codeRoot = opts.codeRoot ?? defaultCodeRoot();
  const manifestPath = manifestPathFor(opts.home);
  const manifest = computeManifest(codeRoot, opts.now);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return { manifestPath, manifest };
}

/** Compare le code courant au manifeste scellé. Ne lève jamais : toute anomalie de lecture = "mismatch". */
export function verifyIntegrity(opts: { codeRoot?: string; home?: string } = {}): IntegrityResult {
  const codeRoot = opts.codeRoot ?? defaultCodeRoot();
  const manifestPath = manifestPathFor(opts.home);
  if (!fs.existsSync(manifestPath)) return { status: "unsealed", manifestPath, codeRoot, changed: [] };
  try {
    const sealed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
    if (sealed.version !== 1 || !sealed.files || typeof sealed.files !== "object") {
      return { status: "mismatch", manifestPath, codeRoot, changed: ["manifeste invalide"] };
    }
    const current = computeManifest(codeRoot);
    const changed: string[] = [];
    for (const [f, h] of Object.entries(sealed.files)) {
      const c = current.files[f];
      if (c === undefined) changed.push(`− ${f}`);
      else if (c !== h) changed.push(`~ ${f}`);
    }
    for (const f of Object.keys(current.files)) if (!(f in sealed.files)) changed.push(`+ ${f}`);
    return { status: changed.length === 0 ? "sealed" : "mismatch", manifestPath, codeRoot, changed, sealedAt: sealed.sealedAt };
  } catch (e) {
    return { status: "mismatch", manifestPath, codeRoot, changed: [`erreur: ${(e as Error).message}`] };
  }
}
