/**
 * Collecte Reddit sans authentification : `https://www.reddit.com/r/<sub>/new.json?limit=100`.
 * Limite publique ≈ 100 requêtes/min (source secondaire, voir docs/research-2026-09-24.md) ;
 * un User-Agent descriptif est obligatoire sinon 429/403.
 *
 * Subreddits par défaut : r/solana, r/CryptoMoonShots, r/memecoins.
 * Schéma : { kind: "Listing", data: { after, children: [{ kind: "t3", data: {...post} }] } }
 */
import { extractMints, extractTickers } from "./extract.ts";
import { createLimiter, type Limiter } from "./ratelimit.ts";
import type { FetchLike, RedditPost } from "./types.ts";

export const DEFAULT_SUBREDDITS = ["solana", "CryptoMoonShots", "memecoins"];
export const REDDIT_USER_AGENT = "crypto-lab-collector/1.0 (recherche personnelle; github actions)";

export interface RedditListing {
  kind: "Listing";
  data: {
    after: string | null;
    before: string | null;
    dist?: number;
    children: Array<{ kind: string; data: RedditPostRaw }>;
  };
}

export interface RedditPostRaw {
  id: string;
  subreddit: string;
  title: string;
  selftext?: string;
  author: string;
  created_utc: number;
  score?: number;
  ups?: number;
  num_comments?: number;
  permalink: string;
  url?: string;
  link_flair_text?: string | null;
  over_18?: boolean;
  stickied?: boolean;
}

export interface RedditOptions {
  fetch: FetchLike;
  limiter?: Limiter;
  baseUrl?: string;
  userAgent?: string;
  subreddits?: string[];
  /** Posts par subreddit (max 100). */
  limit?: number;
}

export interface RedditClient {
  getNew(subreddit: string): Promise<RedditPost[]>;
  collect(): Promise<{ posts: RedditPost[]; errors: Array<{ source: string; message: string }> }>;
  readonly requestCount: number;
}

export function normalizeRedditPost(p: RedditPostRaw): RedditPost {
  const text = `${p.title}\n${p.selftext ?? ""}\n${p.url ?? ""}`;
  return {
    id: p.id,
    subreddit: p.subreddit,
    title: p.title,
    selftext: p.selftext ?? "",
    author: p.author,
    createdUtc: Math.floor(p.created_utc),
    score: p.score ?? p.ups ?? 0,
    numComments: p.num_comments ?? 0,
    permalink: p.permalink,
    url: p.url ?? "",
    tickers: extractTickers(text),
    mints: extractMints(text),
  };
}

export function parseListing(json: unknown): RedditPost[] {
  const listing = json as RedditListing;
  const children = listing?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .filter((c) => c.kind === "t3" && c.data && typeof c.data.id === "string")
    .filter((c) => !c.data.stickied)
    .map((c) => normalizeRedditPost(c.data));
}

export function createRedditClient(opts: RedditOptions): RedditClient {
  const limiter = opts.limiter ?? createLimiter({ max: 90, windowMs: 60_000 });
  const base = opts.baseUrl ?? "https://www.reddit.com";
  const subs = opts.subreddits ?? DEFAULT_SUBREDDITS;
  const limit = Math.min(opts.limit ?? 100, 100);
  let requestCount = 0;

  async function getNew(subreddit: string): Promise<RedditPost[]> {
    const url = `${base}/r/${subreddit}/new.json?limit=${limit}&raw_json=1`;
    const res = await limiter.schedule(() =>
      opts.fetch(url, { headers: { "user-agent": opts.userAgent ?? REDDIT_USER_AGENT, accept: "application/json" } }),
    );
    requestCount += 1;
    if (!res.ok) throw new Error(`Reddit ${res.status} sur r/${subreddit}`);
    return parseListing(await res.json());
  }

  return {
    get requestCount() {
      return requestCount;
    },
    getNew,
    async collect() {
      const posts: RedditPost[] = [];
      const errors: Array<{ source: string; message: string }> = [];
      for (const s of subs) {
        try {
          posts.push(...(await getNew(s)));
        } catch (e) {
          errors.push({ source: `reddit:r/${s}`, message: (e as Error).message });
        }
      }
      posts.sort((a, b) => b.createdUtc - a.createdUtc);
      return { posts, errors };
    },
  };
}
