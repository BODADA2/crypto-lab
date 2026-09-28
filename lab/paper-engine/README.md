# Moteur autonome de recherche + paper trading

Implémentation du cahier des charges en 13 sections (recherche autonome de memecoins,
pipeline de sélection, 100 décisions simulées, journal de performance, apprentissage,
tests contre le hasard, risk management, score interne, recherche continue, adaptation
au régime, rapport standardisé, NO_TRADE, autonomie sans transaction réelle).

## Architecture (intégrée, pas parallèle)

Le moteur réutilise les modules existants là où ils s'appliquent :

| Module moteur | Réutilise |
|---|---|
| `score.ts` (10 dimensions) | `lab/signals/bundle.ts` (risque bundle), `lab/signals/devblocklist.ts` (H-BLOCK), `lab/signals/volume.ts` (z-score), `lab/signals/catalyst.ts` (catalyseur walk-forward), normalisations de `lab/signals/score.weights.json` |
| `regime.ts` | `lab/collect/chainregime.ts` (régime par chaîne, données réelles) |
| `ledger.ts` | conventions du journal (`lab/journal/`) ; métriques inspirées de `lab/backtest/harness.ts` (n≥30) |
| `cycle.ts` | coûts 1,3 % comme les backtests ; verdicts du labo respectés (ex. catalyst = dimension, pas déclencheur d'entrée, suite au NO ACTION de H-NARR v2) |

## Fichiers

- `config.ts` — paramètres PROPRES au moteur (capital virtuel 10 000 $, risque 1 %/trade,
  5 % simultané, halt à 15 % de drawdown…). Ne touche jamais à `lab/risk/policy.example.json`.
- `types.ts` — décisions (trade / NO_TRADE), clôtures, métriques, résumé de cycle.
- `ledger.ts` — ledger append-only (`data/paper-engine/decisions.jsonl`), courbe d'equity,
  drawdown, métriques §4, changelog des ajustements.
- `score.ts` — score interne 10 dimensions ; risque critique = élimination même si le
  momentum est fort ; INCONNU quand la donnée manque ; jamais une garantie de rendement.
- `regime.ts` — BULL/BEAR/SIDEWAYS/HIGH VOLATILITY/LOW LIQUIDITY/MEME MANIA/RISK OFF/INCONNU.
- `cycle.ts` — un cycle : régime → halt/budget → candidats (données réelles) → pipeline
  SÉCURITÉ/LIQUIDITÉ/ON-CHAIN/MARCHÉ/NARRATIF → score → décisions → clôtures simulées
  en walk-forward strict → apprentissage.
- `report.ts` — rapport au format exact du §11.
- `learn.ts` — apprentissage par blocs de 20 : analyse d'erreurs, ajustements UNIQUEMENT
  sur preuve n≥30 validée sur données séparées, chaque modification tracée.
- `run-cycle.ts` — CLI.

## Règles dures

1. **Aucune donnée fabriquée.** INCONNU explicite quand c'est absent.
2. **Données insuffisantes → NO_TRADE** (§12). La patience est une décision valide.
3. **Aucune transaction réelle.** Ce moteur ne connaît pas l'exécuteur.
4. **Anti-sur-apprentissage** : pas d'ajustement sur petite série ; n≥30 + validation
   sur données séparées ; tout est tracé dans `data/paper-engine/CHANGELOG.md`.
5. **Ne touche pas** au Risk Engine, à l'exécuteur, à la politique ni aux poids.

## Caveats connus (données actuelles)

- Autorités mint/freeze toujours `UNKNOWN` dans `data/history` → dimension sécurité
  pénalisée, INCONNU documenté (en live : refus systématique).
- Holders toujours null, top10 toujours 100 → le filtre bundle est aveugle sur ces
  données ; la criticité exige une preuve **mesurée** (pas la seule absence).
- Aucune donnée sociale → dimension narratif INCONNU.
- Wallet du dev absent → H-BLOCK inopérant sur `data/history`.
- Clôtures simulées sur prix de clôture uniquement (pas d'OHLC) : stop vérifié avant
  les TP par barre (conservateur) ; MFE/MAE sur clôtures.

## Usage

```bash
npx tsx lab/paper-engine/run-cycle.ts --cycle 1 --max-tokens 300
# Rapport : docs/paper-engine-cycle-001.md
```
