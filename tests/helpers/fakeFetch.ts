/**
 * Faux `fetch` hors ligne : route les URL vers des fixtures JSON (ou des réponses construites).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../../lab/collect/types.ts";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function loadFixture<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as T;
}

export type RouteHandler = (url: string, init?: RequestInit) => unknown;
export type RouteBody = object | string | number | boolean | null | RouteHandler;

export interface Route {
  /** Sous-chaîne ou RegExp testée sur l'URL. */
  match: string | RegExp;
  /** Corps JSON (objet) ou fonction (url, init) → objet ; `status` optionnel. */
  body: RouteBody;
  status?: number;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: RequestInit }>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function createFakeFetch(routes: Route[]): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    for (const r of routes) {
      const ok = typeof r.match === "string" ? url.includes(r.match) : r.match.test(url);
      if (!ok) continue;
      const body = typeof r.body === "function" ? (r.body as RouteHandler)(url, init) : r.body;
      return jsonResponse(body, r.status ?? 200);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}
