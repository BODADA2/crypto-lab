/**
 * Auth Helius via le skill `~/workspace/skills/helius` (connecteur `custom.helius`).
 *
 * AUCUNE clé brute n'est jamais demandée, lue, loggée ni persistée :
 * le CLI `helius_rpc_url.py` imprime une URL portant un surrogate court-terme
 * (`?api-key=hsurr:...`) que le proxy remplace par la vraie clé à l'egress.
 *
 * Règles de sécurité :
 *  - l'URL complète (avec le surrogate) n'est JAMAIS loggée ni mise dans un
 *    message d'erreur ; seuls le host et la cause sont rapportés ;
 *  - en cas de 401/403 (surrogate expiré), régénérer l'URL UNE fois et réessayer.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { HeliusError } from "./helius.ts";

export class HeliusAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeliusAuthError";
  }
}

const CLI_PATH = join(homedir(), "workspace/skills/helius/bin/helius_rpc_url.py");

/** Couche injectable pour les tests (ne jamais passer l'URL dans les logs). */
export type CliRunner = (baseUrl: string) => string;

function defaultRunner(baseUrl: string): string {
  return execFileSync("python3", [CLI_PATH, baseUrl], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  }) as string;
}

/** Extrait le host d'une URL pour les messages d'erreur (jamais le secret). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(url invalide)";
  }
}

/**
 * Obtient une URL RPC Helius authentifiée via l'échange sécurisé du skill.
 * `baseUrl` peut être `https://…` (JSON-RPC) ou `wss://…` (WebSocket).
 */
export function getHeliusRpcUrl(
  baseUrl = "https://mainnet.helius-rpc.com/",
  runCli: CliRunner = defaultRunner,
): string {
  let raw: string;
  try {
    raw = runCli(baseUrl);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new HeliusAuthError(
      `Échange sécurisé Helius impossible pour ${hostOf(baseUrl)} : ${cause}. ` +
        `Voir ~/workspace/skills/helius/SKILL.md (connecteur custom.helius).`,
    );
  }
  const url = raw.trim();
  if (!url || (!url.startsWith("https://") && !url.startsWith("wss://"))) {
    throw new HeliusAuthError(
      `Le CLI Helius n'a pas renvoyé d'URL valide pour ${hostOf(baseUrl)} ` +
        `(sortie vide ou inattendue). Voir ~/workspace/skills/helius/SKILL.md.`,
    );
  }
  return url;
}

/** Vrai si l'erreur ressemble à un surrogate expiré (401/403 Helius). */
export function isHeliusAuthFailure(err: unknown): boolean {
  return err instanceof HeliusError && (err.code === 401 || err.code === 403);
}

/**
 * Exécute `fn` avec une URL fraîche ; en cas de 401/403, régénère l'URL
 * UNE fois et réessaie. Toute autre erreur est propagée telle quelle.
 */
export async function withHeliusAuthRefresh<T>(
  baseUrl: string,
  fn: (rpcUrl: string) => Promise<T>,
  runCli?: CliRunner,
): Promise<T> {
  try {
    return await fn(getHeliusRpcUrl(baseUrl, runCli));
  } catch (err) {
    if (!isHeliusAuthFailure(err)) throw err;
    // Régénération unique : le surrogate a pu expirer entre deux appels.
    return await fn(getHeliusRpcUrl(baseUrl, runCli));
  }
}
