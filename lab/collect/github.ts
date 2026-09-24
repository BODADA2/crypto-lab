/**
 * Dépôts GitHub « trending » autour de Solana (signal narratif côté développeurs).
 * GitHub n'expose pas d'API trending officielle : on approxime avec la recherche
 *   GET https://api.github.com/search/repositories?q=solana+created:>YYYY-MM-DD&sort=stars&order=desc&per_page=50
 * et une seconde requête `pushed:>...` pour les dépôts actifs.
 * Limites : ~60 req/h non authentifié, ~5 000 req/h avec `GITHUB_TOKEN` (celui d'Actions suffit).
 */
import { extractMints, extractTickers } from "./extract.ts";
import type { FetchLike, GithubRepo } from "./types.ts";

export interface GithubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GithubRepoRaw[];
}

export interface GithubRepoRaw {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  topics?: string[];
  created_at: string;
  updated_at: string;
  pushed_at: string;
  owner?: { login: string };
  fork?: boolean;
  archived?: boolean;
}

export interface GithubOptions {
  fetch: FetchLike;
  token?: string;
  baseUrl?: string;
  now?: () => number;
  /** Fenêtre « nouveaux dépôts » en jours (défaut 7). */
  createdDays?: number;
  /** Fenêtre « dépôts actifs » en jours (défaut 2). */
  pushedDays?: number;
  perPage?: number;
  query?: string;
}

export interface GithubClient {
  searchRepos(q: string): Promise<GithubRepo[]>;
  collect(): Promise<{ repos: GithubRepo[]; errors: Array<{ source: string; message: string }> }>;
  readonly requestCount: number;
}

export function normalizeRepo(r: GithubRepoRaw): GithubRepo {
  const text = `${r.name} ${r.description ?? ""} ${(r.topics ?? []).join(" ")}`;
  return {
    fullName: r.full_name,
    url: r.html_url,
    description: r.description ?? null,
    stars: r.stargazers_count ?? 0,
    language: r.language ?? null,
    topics: r.topics ?? [],
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    tickers: extractTickers(text),
    mints: extractMints(text),
  };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createGithubClient(opts: GithubOptions): GithubClient {
  const base = opts.baseUrl ?? "https://api.github.com";
  const now = opts.now ?? (() => Date.now());
  const perPage = opts.perPage ?? 50;
  const term = opts.query ?? "solana";
  let requestCount = 0;

  async function searchRepos(q: string): Promise<GithubRepo[]> {
    const url = `${base}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "crypto-lab-collector/1.0",
      "x-github-api-version": "2022-11-28",
    };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await opts.fetch(url, { headers });
    requestCount += 1;
    if (!res.ok) throw new Error(`GitHub ${res.status} sur ${q}`);
    const json = (await res.json()) as GithubSearchResponse;
    return (json.items ?? []).filter((r) => !r.fork && !r.archived).map(normalizeRepo);
  }

  return {
    get requestCount() {
      return requestCount;
    },
    searchRepos,
    async collect() {
      const t = now();
      const day = 86_400_000;
      const errors: Array<{ source: string; message: string }> = [];
      const seen = new Map<string, GithubRepo>();
      const queries = [
        `${term} created:>${isoDay(t - (opts.createdDays ?? 7) * day)}`,
        `${term} pushed:>${isoDay(t - (opts.pushedDays ?? 2) * day)} stars:>5`,
      ];
      for (const q of queries) {
        try {
          for (const r of await searchRepos(q)) if (!seen.has(r.fullName)) seen.set(r.fullName, r);
        } catch (e) {
          errors.push({ source: `github:${q}`, message: (e as Error).message });
        }
      }
      const repos = Array.from(seen.values()).sort((a, b) => b.stars - a.stars);
      return { repos, errors };
    },
  };
}
