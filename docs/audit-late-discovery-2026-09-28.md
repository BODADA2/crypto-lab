# AUDIT — artefact "late-discovery" : le filtre combiné n'a jamais eu d'edge

**Date :** 2026-09-28 (nuit) · **Nature :** audit de données + re-mesure complète sur données genuine.
**Scripts :** `lab/backtest/audit-late-discovery.ts`, `lab/backtest/run-momentum-confirm.ts`,
`lab/backtest/characterize-winners.ts` · **Données :** `data/backtests/audit-late-discovery-2026-09-28.json`,
`data/backtests/momentum-confirm-2026-09-28.json`, `data/backtests/winners-characterization-2026-09-28.json`.
Aucun seuil du moteur modifié, aucune transaction réelle, commits locaux uniquement.

## 1. Le constat

En caractérisant les gagnants du filtre combiné, anomalie : 421/479 migrés suivis avaient
un `devBuy ≥ 85.01`, un `marketCapSol ≥ 411` et un `vSol ≥ 115` **au create**. Impossible
pour un token frais (la graduation pump.fun intervient à ~85 SOL en courbe).

Inspection : **607 creates** portent un tuple `(solAmount, vSol, vTokens, mcapSol)` **identique
au décimal près** :

```
(85.005359057, 115.005359056806, 279900000, 410.8801681200643)
```

- `vSol = 115 > 85` (seuil de graduation) → ce n'est PAS un état à la création.
- Identique à 9 décimales sur 607 mints indépendants → impossible comme mesures réelles :
  c'est un **état de courbe figé / template** émis par le collecteur.
- `delay create→migrate = 0.00h`, **607/607 sont migrés**.
- Mécanisme probable : le collecteur émet un `create` tardif quand il découvre un token
  déjà chaud/migré, avec un état de courbe générique. Le `solAmount` (= 85.005) n'est donc
  PAS la mise initiale du dev pour ces tokens — le champ est mensonger.
- À l'inverse, sur 2 000 creates genuine échantillonnés : `solAmount + 30 = vSol` **à 100 %**
  (cohérence arithmétique parfaite) → le flux genuine est sain.

**Règle de détection :** `tuple == (85.005359057, 115.005359056806, 279900000, 410.8801681200643)`
→ `late_discovery = true`. (14 autres creates avec `vSol ≥ 85` mais valeurs variables existent :
possibles graduations instantanées réelles, n=14, impact négligeable, à traiter à part.)

## 2. Impact chiffré — avant / après (genuine = hors tuple constant)

| Mesure | AVEC artefact | GENUINE | Verdict corrigé |
|---|---|---|---|
| Taux de base train / test | 2.30 % / 2.31 % | **1.27 % / 1.42 %** | base réelle ~1.3–1.4 % |
| Filtre ≥1.0 SOL, test | 9.33 % | **1.48 %** IC[1.07,1.89] | aucun edge |
| Filtre ≥1.3 SOL, test | 10.73 % | **1.66 %** IC[1.19,2.13] | aucun edge |
| Filtre ≥1.5 SOL, test | 13.13 % | **2.01 %** IC[1.43,2.59] | aucun edge (limite du bruit) |
| Monotonicité en seuil | oui (9.7→11.4→14.0) | **non** (1.51→1.54→1.50 train) | artefact, pas de mécanisme |
| Sans mayhem (filtre) | 12.50 % | 1.83 % | aucun edge |
| Exclusion industrielle : lift | 1.43× | **1.09×** (1.36 % vs 1.48 %) | lift évaporé |
| H-TOOL ipfs.io / j7tracker | 2.70 % / 1.36 % | 1.31 % / 0.87 % | résiduel faible, non actionnable |
| H-TOOL uxento.io | 0.96 % | 0.45 % | résiduel faible |
| "?" (pas d'URI) | 5.50 % | 2.59 % | curiosité, pas une stratégie |

**Lecture :** la totalité du "10.7 %" venait des 607 late-discoveries (100 % migrés,
`devBuy` fictif de 85.005 ≥ seuils). Sans eux, le filtre combiné fait **1.5–2.0 %** contre
**1.4 %** de base — l'edge n'existe pas.

## 3. Verdicts corrigés

- **H-DEVBUY (signal create-time) : FALSIFIÉ en l'état.** Aucune preuve d'edge sur creates
  genuine. Le 5.10 % / 10.45 % / la monotonicité étaient l'artefact.
- **Filtre combiné ipfs.io × devBuy : ABANDONNÉ comme signal.** Ne pas l'intégrer, même
  comme pré-filtre d'univers (il ne sélectionne rien d'utile).
- **H-TOOL : résiduel faible.** L'ordonnancement industriel < manuel survit atténué
  (uxento 0.45 %, j7 0.87 % vs ipfs.io 1.31 %), mais le lift d'exclusion mesuré est nul
  (1.09×). Non actionnable seul.
- **H-CALLTRACK (falsifié), H-CURVE, H-POSTMIG : inchangés** par cet audit.
- **Le protocole walk-forward et les scripts restent valides** — ce sont les conclusions
  chiffrées des docs `backtest-combined-filter-2026-09-28.md` (§2–§5) et `edge-check-2026-09-28.md`
  (§H-DEVBUY, §H-TOOL) qui sont remplacées par le présent audit.

## 4. Ce que l'artefact nous apprend (utile)

1. Le flux `create` mélange deux populations : observations à la création (saines,
   arithmétiquement cohérentes) et découvertes tardives (template figé). **Tout futur
   backtest create-time DOIT filtrer `late_discovery`.**
2. Le collecteur découvre les tokens chauds avec retard (délai migration→1er snapshot :
   médiane 0.3h, p90 8.3h) → toute mesure de P&L sur `data/history` reste une borne
   optimiste.
3. La base réelle de migration (≈1.4 %, pas 2.3 %) rend le breakeven encore plus exigeant.

## 5. Recommandations

1. **Collector :** marquer `late_discovery=true` quand `vSol ≥ 85` à la première observation
   (ou quand le tuple constant est détecté) ; ne jamais utiliser `solAmount` comme `devBuy`
   dans ce cas → `devBuy = INCONNU`. Voir `docs/unbiased-tracking-spec-2026-09-28.md`.
2. **Re-jouer** les backtests H-DEVBUY/H-TOOL avec le filtre `late_discovery` avant toute
   réutilisation de ces chiffres.
3. **Ne rien changer au moteur** : il ne générait déjà aucun trade (H-DATA-1) ; l'audit ne
   fait que retirer un faux espoir, pas un vrai signal.
4. **Priorité : données d'abord** — suivi non biaisé dès le create (spec séparée). Sans lui,
   aucun P&L n'est mesurable honnêtement et H-POSTMIG reste fermée.

---
*Audit exécuté le 2026-09-28, données réelles du collecteur 24–28 sept. 2026.
Aucune donnée fabriquée, aucun seuil modifié, aucune transaction réelle.*
