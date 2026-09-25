/**
 * Calls publics de canaux Telegram (hypothèses 3 et 4, docs/preregistration-memecoins.md).
 *
 * Lecture seule de l'aperçu web public `https://t.me/s/<canal>` : aucun compte, aucun jeton, aucun message envoyé.
 * Un « call » = un message du canal contenant une adresse de contrat. On garde la PREMIÈRE apparition de chaque adresse
 * (les re-posts et les « updates » de gains ne comptent pas).
 */
import type { FetchLike } from "./types.ts";

export type CallChain = "solana" | "robinhood" | "other";

export interface Call {
  channel: string;
  /** Identifiant du message dans le canal. */
  postId: number;
  /** Heure de publication (Telegram), ISO UTC. */
  postedAt: string;
  /** Première fois que le collecteur a vu le message, ISO UTC (≥ postedAt). */
  seenAt: string;
  chain: CallChain;
  /** Étiquette de chaîne telle qu'écrite dans le message (SOL, RBH, ARC…), ou null. */
  chainTag: string | null;
  address: string;
  /** Ticker ($XXX) si présent. */
  symbol: string | null;
  text: string;
}

const EVM = /0x[0-9a-fA-F]{40}/;
const SOL = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function toText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Adresse Solana plausible : base58, 32–44 caractères, au moins un chiffre, une majuscule et une minuscule. */
function isSolAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

/** Adresse de contrat du message : d'abord les blocs <code>, puis le texte (URL retirées). */
export function extractAddress(html: string): { address: string; kind: "evm" | "sol" } | null {
  const codes = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)].map((m) => toText(m[1] ?? ""));
  const text = toText(html).replace(/https?:\/\/\S+/g, " ");
  for (const src of [...codes, text]) {
    const evm = src.match(EVM);
    if (evm) return { address: evm[0], kind: "evm" };
    for (const m of src.matchAll(new RegExp(SOL.source, "g"))) {
      if (isSolAddress(m[0])) return { address: m[0], kind: "sol" };
    }
  }
  return null;
}

/** Étiquette de chaîne en tête de message : « ( 🔥SOL) », « (RBH) »… */
export function extractChainTag(text: string): string | null {
  const m = text.slice(0, 40).match(/\(([^)]{0,16}?)\b([A-Z]{2,5})\s*\)/);
  return m ? (m[2] as string) : null;
}

export function classifyChain(tag: string | null, kind: "evm" | "sol"): CallChain {
  if (kind === "sol" && (tag === null || tag === "SOL")) return "solana";
  if (kind === "evm" && tag === "RBH") return "robinhood";
  return "other";
}

/** Analyse une page `t.me/s/<canal>`. Renvoie les messages contenant une adresse (sans dédoublonnage). */
export function parseChannelPage(html: string, channel: string, seenAt: string): { calls: Call[]; oldestPostId: number | null } {
  const calls: Call[] = [];
  let oldest: number | null = null;
  const chunks = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
  for (const chunk of chunks) {
    const post = chunk.match(/data-post="([^"/]+)\/(\d+)"/);
    if (!post) continue;
    const postId = Number(post[2]);
    if (oldest === null || postId < oldest) oldest = postId;
    const time = chunk.match(/<time[^>]*datetime="([^"]+)"/);
    // Le texte principal porte la classe js-message_text ; la citation d'une réponse porte js-message_reply_text.
    const body = chunk.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/);
    if (!time || !body) continue;
    const postedMs = Date.parse(time[1] as string);
    if (!Number.isFinite(postedMs)) continue;
    const bodyHtml = body[1] as string;
    const addr = extractAddress(bodyHtml);
    if (!addr) continue;
    const text = toText(bodyHtml);
    const tag = extractChainTag(text);
    const sym = text.match(/\$([A-Za-z][A-Za-z0-9]{1,14})\b/);
    calls.push({
      channel,
      postId,
      postedAt: new Date(postedMs).toISOString(),
      seenAt,
      chain: classifyChain(tag, addr.kind),
      chainTag: tag,
      address: addr.address,
      symbol: sym ? (sym[1] as string).toUpperCase() : null,
      text: text.slice(0, 500),
    });
  }
  return { calls, oldestPostId: oldest };
}

/** Clé d'unicité d'une adresse (EVM insensible à la casse). */
export function addressKey(address: string): string {
  return address.startsWith("0x") ? address.toLowerCase() : address;
}

/**
 * Nouveaux calls : première apparition de chaque adresse, par ordre de publication, en ignorant les adresses et messages
 * déjà connus. Fonction pure (testée).
 */
export function mergeNewCalls(known: Call[], found: Call[]): Call[] {
  const seenAddr = new Set(known.map((c) => addressKey(c.address)));
  const seenPost = new Set(known.map((c) => `${c.channel}/${c.postId}`));
  const out: Call[] = [];
  for (const c of [...found].sort((a, b) => a.postId - b.postId)) {
    const k = addressKey(c.address);
    if (seenAddr.has(k) || seenPost.has(`${c.channel}/${c.postId}`)) continue;
    seenAddr.add(k);
    seenPost.add(`${c.channel}/${c.postId}`);
    out.push(c);
  }
  return out;
}

/**
 * Lit les derniers messages d'un canal public. Remonte jusqu'à `maxPages` pages (20 messages chacune) tant que le plus
 * ancien message de la page est plus récent que `sincePostId`.
 */
export async function fetchChannelCalls(fetchImpl: FetchLike, channel: string, seenAt: string, sincePostId: number | null, maxPages = 3): Promise<Call[]> {
  const out: Call[] = [];
  let before: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `https://t.me/s/${encodeURIComponent(channel)}${before ? `?before=${before}` : ""}`;
    const res = await fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0 (crypto-lab research; read-only)" } });
    if (!res.ok) throw new Error(`t.me/s/${channel} → HTTP ${res.status}`);
    const { calls, oldestPostId } = parseChannelPage(await res.text(), channel, seenAt);
    out.push(...calls);
    if (oldestPostId === null || sincePostId === null || oldestPostId <= sincePostId) break;
    before = oldestPostId;
  }
  return out;
}
