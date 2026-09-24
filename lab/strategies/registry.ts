/**
 * Registre des stratégies : enregistrement, listing, exécution de toutes les stratégies sur un input.
 *
 * Le registre est un objet en mémoire, sans état de marché : deux registres construits avec les mêmes
 * stratégies produisent les mêmes signaux. Une stratégie qui lève est isolée (erreur capturée et renvoyée
 * dans `errors`, les autres stratégies continuent) : un bug dans S3 ne doit jamais faire taire S1.
 */
import { createS1Volume } from "./s1-volume.ts";
import { createS2EarlyBuyers } from "./s2-earlybuyers.ts";
import { createS3Migration } from "./s3-migration.ts";
import { createS4Ivb } from "./s4-ivb.ts";
import type { Strategy, StrategyFamily, StrategyInput, StrategySignal } from "./types.ts";

export interface RunResult {
  signals: StrategySignal[];
  /** Stratégies évaluées (id@version). */
  evaluated: string[];
  errors: Array<{ strategyId: string; message: string }>;
}

export interface StrategyRegistry {
  register(strategy: Strategy): void;
  unregister(id: string): boolean;
  get(id: string): Strategy | undefined;
  has(id: string): boolean;
  list(family?: StrategyFamily): Strategy[];
  /** Exécute toutes les stratégies (ou celles de la famille) sur l'input ; signaux triés par force décroissante. */
  run(input: StrategyInput, family?: StrategyFamily): RunResult;
  /** Description de chaque stratégie (pour le brief). */
  describeAll(): string[];
}

export function createRegistry(initial: Strategy[] = []): StrategyRegistry {
  const byId = new Map<string, Strategy>();
  const registry: StrategyRegistry = {
    register(strategy) {
      if (!strategy.id || !strategy.version) throw new Error("stratégie sans id ou version");
      if (byId.has(strategy.id)) throw new Error(`stratégie déjà enregistrée : ${strategy.id}`);
      byId.set(strategy.id, strategy);
    },
    unregister(id) {
      return byId.delete(id);
    },
    get(id) {
      return byId.get(id);
    },
    has(id) {
      return byId.has(id);
    },
    list(family) {
      const all = Array.from(byId.values());
      return (family ? all.filter((s) => s.family === family) : all).sort((a, b) => a.id.localeCompare(b.id));
    },
    run(input, family) {
      const signals: StrategySignal[] = [];
      const errors: RunResult["errors"] = [];
      const evaluated: string[] = [];
      for (const s of registry.list(family)) {
        evaluated.push(`${s.id}@${s.version}`);
        try {
          for (const sig of s.signals(input)) {
            // Garde-fous : un signal porte toujours l'identité de sa stratégie et une force bornée.
            signals.push({ ...sig, strategyId: s.id, strategyVersion: s.version, strength: Math.max(0, Math.min(100, sig.strength)) });
          }
        } catch (e) {
          errors.push({ strategyId: s.id, message: (e as Error)?.message ?? String(e) });
        }
      }
      signals.sort((a, b) => b.strength - a.strength || a.strategyId.localeCompare(b.strategyId));
      return { signals, evaluated, errors };
    },
    describeAll() {
      return registry.list().map((s) => `${s.id} v${s.version} [${s.family}] — ${s.describe()}`);
    },
  };
  for (const s of initial) registry.register(s);
  return registry;
}

/** Registre par défaut : S1 à S4 avec leurs paramètres documentés. */
export function defaultRegistry(): StrategyRegistry {
  return createRegistry([createS1Volume(), createS2EarlyBuyers(), createS3Migration(), createS4Ivb()]);
}
