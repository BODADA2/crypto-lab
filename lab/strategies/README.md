# Strategy Engine — `lab/strategies/`

Chantier 2 de `docs/architecture-v2.md`. Une stratégie est une **fonction pure** : `signals(input)` renvoie des
propositions datées, jamais des ordres. Elle ne lit ni fichier ni réseau, ignore le portefeuille et la politique de
risque. Ses signaux passent ensuite par le cross-check, le scoring, le red team, puis le Risk Engine sur la machine
d'Hervé. Hiérarchie inchangée : **RISK ENGINE > TRADING AGENT > STRATEGY AGENT > CLAUDE**.

```
strategies/
├── types.ts            Strategy, StrategyInput, StrategySignal, OhlcvBar, StrategyContext
├── registry.ts         createRegistry() / defaultRegistry() : enregistrement, listing, run() isolant les erreurs
├── s1-volume.ts        S1 volume anormal (enveloppe de signals/volume.ts) : z ≥ 3 + filtres
├── s2-earlybuyers.ts   S2 ≥ 2 wallets suivis (data/wallets) entrent en 10 min
├── s3-migration.ts     S3 post-graduation : liquidité ≥ 20 k$, top 10 < 30 %, autorités vérifiées, time-stop 24 h
├── s4-ivb.ts           S4 IVB (Initial Volatility Breakout) sur barres 5 min SOL/BTC — port corrigé
├── ohlcv.ts            fuseau (Intl, DST), ATR, lecture JSONL de barres
└── metrics.ts          métriques par stratégie (trades simulés ou ledger), refus de conclure sous n < 30
```

## Contrat

- `StrategyInput` : `{ now, snapshot, history, context }` pour les memecoins ; `{ now, symbol, bars, context }` pour la
  famille crypto ; champs optionnels `trackedWallets`, `buys` (S2) et `migration` (S3). Rien de postérieur à `now`.
- `StrategySignal` : `{ strategyId, strategyVersion, mint | symbol, side, strength 0–100, reasons[], invalidation,
  proposedStop?, proposedTarget?, exitBy?, refPrice?, ts }`. Chaque raison contient ses chiffres.
- Registre : `run(input)` exécute toutes les stratégies (ou une famille), impose l'identité de la stratégie sur ses
  signaux, borne la force, capture les erreurs (`errors[]`) sans faire taire les autres.

## Paramètres par défaut (chaque stratégie expose `describe()` et un objet `*_DEFAULTS`)

| Stratégie | Paramètres |
|---|---|
| S1 | z ≥ 3 sur 12 fenêtres, âge ≥ 10 min, liquidité ≥ 20 k$, achats/ventes ≥ 1, volume/liquidité ≥ 5 %, stop −25 %, objectif +50 % |
| S2 | ≥ 2 wallets suivis distincts en 10 min, regroupement âgé ≤ 30 min, liquidité ≥ 20 k$, stop −30 %, objectif +60 % |
| S3 | migration connue depuis 10–120 min, liquidité ≥ 20 k$, top 10 < 30 % (100 = inconnu ⇒ jamais), autorités `null` (vérifiées), time-stop 24 h |
| S4 | fourchette 9 h 30–10 h 00 America/New_York, contraction ≤ 0,8 × moyenne des 10 jours **précédents**, première clôture hors fourchette dans les 90 min, volume ≥ 1,5 × moyenne des 20 barres **précédentes**, stop bord opposé ∓ 0,5 ATR(14), objectif 2 R, sortie forcée 16 h 00, 1 ordre/séance |

## S4 — ce que le port corrige

1. Moyenne de contraction calculée sur les jours **précédents** (jour courant exclu) ; historique insuffisant ⇒ aucun signal.
2. Moyenne de volume sur les barres **précédentes** (barre de cassure exclue).
3. Entrée **uniquement** sur la première clôture hors fourchette, dans les 90 min après 10 h 00 ; cassure tardive ou seconde cassure ignorées.
4. Heures locales via `Intl` (`America/New_York`), donc 9 h 30 = 13 h 30 Z en été et 14 h 30 Z en hiver.
5. Stop structurel (bord opposé + tampon ATR), objectif en multiple de R, sortie forcée 16 h ET (`exitBy`).
6. Compteur d'ordres par séance incrémenté **à l'ordre** (harnais `simulateBars` / exécuteur), pas à la détection.

## Backtest

`lab/backtest/harness.ts` : `runStrategyBacktest(seriesByMint, strategy, rules)` (memecoin, snapshots 5 min) et
`runBarsBacktest(barsBySymbol, strategy, rules)` (crypto, OHLCV ; remplissage à l'ouverture suivante, stop/objectif/
`exitBy`, porte `canOrder`, compteur `ordersByDay`). Fixture déterministe : `tests/fixtures/ohlcv/SOL-5m.jsonl`
(46 séances, 5 oct.–7 déc. 2026, changement d'heure inclus), régénérable avec `npx tsx lab/backtest/synth-ohlcv.ts`.
Ce n'est pas de la donnée de marché : elle exerce la mécanique, elle ne prouve rien.

## Métriques (`metrics.ts`)

`computeStrategyMetrics(trades, strategyId?)` : win rate, espérance, profit factor, drawdown max, gain/perte moyens,
frais, slippage, Sharpe et Sortino **par trade** (annualisés × √(trades/an) quand la période couverte ≥ 1 jour, sinon
facteur 1 et `annualization.applied = false`), performance par régime (heure locale, jour de semaine, tendance SOL 24 h
> 0 / < 0 fournie dans `context.solChange24hPct`). **n < 30 ⇒ `conclusive: false`** avec message ; chaque bucket de
régime porte son propre `conclusive`. `tradesFromBacktest()` et `tradesFromLedger()` alimentent les métriques depuis
le harnais ou depuis `ledger/trades.jsonl` (raison `strategy:<id>` pour attribuer le trade).

Tests : `tests/strategies.test.ts` (chaque stratégie isolable, S4 barre par barre, métriques, harnais) et
`tests/snapshot.test.ts` (type unifié).
