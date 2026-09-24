/**
 * Limiteur de débit simple (fenêtre glissante) — sans dépendance.
 * `now` et `sleep` sont injectables pour les tests (horloge virtuelle).
 */

export interface LimiterOptions {
  /** Nombre max d'appels par fenêtre. */
  max: number;
  /** Taille de la fenêtre en ms (60 000 = par minute). */
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Limiter {
  /** Attend si nécessaire puis exécute `fn`. */
  schedule<T>(fn: () => Promise<T>): Promise<T>;
  /** Nombre total d'appels passés par le limiteur. */
  readonly count: number;
  /** Nombre total de ms d'attente imposées. */
  readonly waitedMs: number;
}

export function createLimiter(opts: LimiterOptions): Limiter {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stamps: number[] = [];
  let count = 0;
  let waitedMs = 0;
  // File d'attente sérialisée : évite les rafales concurrentes qui contourneraient la fenêtre.
  let chain: Promise<unknown> = Promise.resolve();

  async function acquire(): Promise<void> {
    for (;;) {
      const t = now();
      while (stamps.length > 0 && (stamps[0] as number) <= t - opts.windowMs) stamps.shift();
      if (stamps.length < opts.max) {
        stamps.push(t);
        count += 1;
        return;
      }
      const wait = Math.max(1, (stamps[0] as number) + opts.windowMs - t);
      waitedMs += wait;
      await sleep(wait);
    }
  }

  return {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(acquire).then(fn);
      chain = next.catch(() => undefined);
      return next;
    },
    get count() {
      return count;
    },
    get waitedMs() {
      return waitedMs;
    },
  };
}
