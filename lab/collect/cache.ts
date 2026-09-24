/**
 * Cache disque minimal : `data/cache/<sha1(clé)>.json` avec TTL.
 * Sert à ne pas redemander la même ressource DexScreener dans un même cycle
 * (60 req/min) et à rejouer un cycle hors ligne.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface CacheEntry<T> {
  key: string;
  storedAt: number;
  ttlMs: number;
  value: T;
}

export interface DiskCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  delete(key: string): void;
  path(key: string): string;
}

export function createDiskCache(dir: string, now: () => number = () => Date.now()): DiskCache {
  mkdirSync(dir, { recursive: true });
  const path = (key: string) => join(dir, createHash("sha1").update(key).digest("hex") + ".json");
  return {
    path,
    get<T>(key: string): T | undefined {
      const p = path(key);
      if (!existsSync(p)) return undefined;
      try {
        const entry = JSON.parse(readFileSync(p, "utf8")) as CacheEntry<T>;
        if (entry.key !== key) return undefined;
        if (now() - entry.storedAt > entry.ttlMs) return undefined;
        return entry.value;
      } catch {
        return undefined;
      }
    },
    set<T>(key: string, value: T, ttlMs: number): void {
      const entry: CacheEntry<T> = { key, storedAt: now(), ttlMs, value };
      writeFileSync(path(key), JSON.stringify(entry));
    },
    delete(key: string): void {
      const p = path(key);
      if (existsSync(p)) unlinkSync(p);
    },
  };
}

/** Cache mémoire avec la même interface (tests, exécution éphémère). */
export function createMemoryCache(now: () => number = () => Date.now()): DiskCache {
  const map = new Map<string, CacheEntry<unknown>>();
  return {
    path: (key) => `memory://${key}`,
    get<T>(key: string): T | undefined {
      const e = map.get(key);
      if (!e) return undefined;
      if (now() - e.storedAt > e.ttlMs) return undefined;
      return e.value as T;
    },
    set<T>(key: string, value: T, ttlMs: number): void {
      map.set(key, { key, storedAt: now(), ttlMs, value });
    },
    delete(key: string): void {
      map.delete(key);
    },
  };
}
