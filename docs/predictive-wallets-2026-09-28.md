# Domaine 1/5 — Wallet Behavior + Early Buyers : rapport de DÉCOUVERTE (2026-09-28)

**Question prioritaire** : la composition des premiers acheteurs (à t0 / pré-t0)
prédit-elle le rendement futur Y et la **survie** du token ?
Survie@H = prix > 0 **ET** liquidité ≥ 20 000 $ au snapshot couvrant l'horizon H.

**Phase : DÉCOUVERTE uniquement. Aucune stratégie construite. AUCUNE conclusion
avec n < 30. Verdict global : NON CONCLUSIF (n=1 en discovery).**

## 1. Cadre et protocole

- Protocole partagé : `lab/predictive/universe.ts` (split FNV 50/25/25, t0 =
  premier snapshot liquidité ≥ 20 000 $ et prix > 0, `aberrantMask` ≥100× vs
  voisins, `futureReturns` sur prix nettoyés, horizons 1h/6h/24h).
- Grille anti-overfitting (dure, implémentée dans `lab/predictive/wallets/pipeline.ts`) :
  - phase `discovery` (défaut) : seules les lignes `discovery` sont analysées ;
  - phase `calibration` (`--phase=calibration`) : discovery + calibration,
    **uniquement après verrouillage explicite** des hypothèses (le flag est
    l'acte de verrouillage) ;
  - **holdout : jamais analysé par ce pipeline.** La mesure OOS unique fera
    l'objet d'un script dédié après gel de la calibration.
- `data/track-unbiased/` : jamais touché (holdout 30 j, gelé).
- **Biais des données** : `data/history/` et `data/earlybuyers/` sont biaisés
  vers les tokens chauds (collecteur orienté volume). **Toute mesure = borne
  OPTIMISTE**, déclarée partout.
- Outliers : résultat principal **avec** les outliers valides ; vue secondaire
  sans les |Y| ≥ 10 (candidats glitch de données, cf. SKHY +4 939 704 %).
- Note technique : `universe.spearman` ne gère pas les ex-aequo (vecteur
  constant → rangs arbitraires → rho fallacieux). Garde `safeSpearman` ajoutée
  dans `lab/predictive/wallets/analysis.ts` : vecteur constant ⇒ null
  (dégénéré). Le protocole partagé n'est **pas** modifié.

## 2. Données (état au 2026-09-28 ~12h35 EDT)

Backfill `data/earlybuyers/` en cours par un autre agent (non relancé, non bloquant).

| Étape | n |
|---|---|
| Fichiers `data/earlybuyers/*.json` lus | 11 |
| Fichiers incomplets ignorés | 0 |
| Sans série `data/history/` | 1 (`ieTA9nTM7epNr8…`) |
| Sans t0 (liquidité < 20 000 $ ou 1 seul tick) | 2 (`5QK1qDJ3AzH5jQ…`, `FiQD9v1Bw3ZZEaE2…`) |
| **Lignes jointes (features + outcomes)** | **8** |
| └ discovery | **1** |
| └ calibration | 4 |
| └ holdout (gelé, non analysé) | 3 |

Couverture des horizons (sur les 8 lignes jointes) : **1h : 7 / 6h : 0 / 24h : 0**.
Les séries sont courtes (1–10 ticks, span ≤ 2h10) : l'horizon 24h est
**non mesurable** sur ces données, le 6h aussi. Seul le 1h est observable —
et uniquement comme borne optimiste (tokens chauds).

### Variables X : définition et disponibilité

| Variable | Définition | Dispo (n=8) |
|---|---|---|
| `buyerCount` | nb wallets acheteurs précoces | 8/8 |
| `top5Share` | part des top-5 **par montant** (re-vérifié = metrics) | 8/8 |
| `top1AmountShare` | part du top-1 par montant | 8/8 |
| `gini` | Gini des montants (re-vérifié = metrics) | 8/8 |
| `sameSlotMax` | part max de buyers dans le même slot | 8/8 |
| `arrivalSpanSec` | blockTime(rank 9 ou dernier) − blockTime(rank 0) | 8/8 |
| `medianInterArrivalSec` | médiane des écarts inter-arrivée | 8/8 |
| `overlapFrac` | part des wallets vus sur ≥2 tokens du dataset | 8/8 (= 0 partout — dataset trop petit) |
| `sellersOver50` | wallets ayant vendu >50 % à +5 min | 2/8 (le reste : Helius non couvert) |
| `medianSoldFrac` | soldFrac médian des wallets couverts à +5 min | 1/8 |
| `devHistory` | one-shot vs répété (registre H-DEV) | **0/8 — non disponible** (aucun artefact pré-calculé ; events PumpPortal `traderPublicKey` non présents dans `data/scans/`) |

`top5_share` des metrics = bien le top-5 **par montant** (vérifié par recomputation
exacte sur chaque fichier ; écart > 1e-6 ⇒ variable mise à null, jamais inventée).

## 3. Résultats discovery (n=1)

Token discovery : `pzCi3SmPiHa3uZ…` — 50 buyers, concentration extrême
(gini 0,935 · top5 0,988 · top1 0,418), **les 50 acheteurs arrivés dans la même
seconde** (`arrivalSpanSec = 0`, `sameSlotMax = 0,40` — profil snipe/bundle
coordonné), Y@1h = **+45,2 %**, survie@1h = **oui**. Fichier marqué `truncated`
(observation partielle).

Descriptif intéressant, **inférence impossible** : avec n=1, Spearman = null,
déciles vides, stabilité incalculable. Le pipeline produit correctement des
résultats vides plutôt que des chiffres fallacieux.

### Tableau Spearman(X, Y) — discovery

| Variable | 1h (Y) | 1h (survie) | 6h | 24h |
|---|---|---|---|---|
| buyerCount | null (n=1) | null (n=1) | n=0 | n=0 |
| top5Share | null (n=1) | null (n=1) | n=0 | n=0 |
| top1AmountShare | null (n=1) | null (n=1) | n=0 | n=0 |
| gini | null (n=1) | null (n=1) | n=0 | n=0 |
| sameSlotMax | null (n=1) | null (n=1) | n=0 | n=0 |
| arrivalSpanSec | null (n=1) | null (n=1) | n=0 | n=0 |
| medianInterArrivalSec | null (n=1) | null (n=1) | n=0 | n=0 |
| overlapFrac | null (dégénéré : constant=0) | null | n=0 | n=0 |
| sellersOver50 | null (non mesuré) | null | n=0 | n=0 |
| medianSoldFrac | null (non mesuré) | null | n=0 | n=0 |

(Identique avec/sans outliers : aucun |Y| ≥ 10 dans l'échantillon.)

### Déciles top vs bottom, stabilité temporelle, stabilité par cohorte

Non calculables (n=1). Implémentés et testés dans `lab/predictive/wallets/analysis.ts`
(`decileTopBottom`, `temporalStability`, `cohortStability`) — métriques par groupe :
n, moyenne, médiane, IC95 % bootstrap, min/p10/p25/p75/p90/max, taux de pertes
extrêmes (Y ≤ −90 %), taux de survie, drawdown max de la P&L cumulée triée par t0.

## 4. Verdicts

| # | Hypothèse | Verdict |
|---|---|---|
| H-PRED-WAL-01 | buyerCount → Y/survie | **NON TESTABLE** (n=1) |
| H-PRED-WAL-02 | top5Share → Y/survie | **NON TESTABLE** (n=1) |
| H-PRED-WAL-03 | gini → Y/survie | **NON TESTABLE** (n=1) |
| H-PRED-WAL-04 | sameSlotMax → Y/survie | **NON TESTABLE** (n=1) |
| H-PRED-WAL-05 | arrivalSpanSec → Y/survie | **NON TESTABLE** (n=1) |
| H-PRED-WAL-06 | top1AmountShare → Y/survie | **NON TESTABLE** (n=1) |
| H-PRED-WAL-07 | rétention (sellersOver50/medianSoldFrac) → Y/survie | **NON MESURABLE** (données sells quasi absentes) |
| H-PRED-WAL-08 | overlapFrac → Y/survie | **NON TESTABLE** (dégénéré à 0 sur 11 fichiers) |
| H-PRED-WAL-09 | devHistory one-shot vs répété → Y/survie | **NON MESURABLE** (registre non disponible) |

**Question survie** : non testable. Sur les 8 lignes jointes (tous univers,
descriptif uniquement) : survie@1h = 7/7 mesurés — échantillon de tokens
chauds, borne optimiste, aucune portée inférentielle.

## 5. Reproductibilité

```
npx tsx lab/predictive/wallets/pipeline.ts > rapport.json            # discovery (défaut)
npx tsx lab/predictive/wallets/pipeline.ts --phase=calibration > rapport.json  # après verrouillage
npx vitest run tests/predictive-wallets.test.ts   # 28 tests verts
```

Code : `lab/predictive/wallets/` — `types.ts` (variables X, outcomes),
`features.ts` (extraction + garde-fous + overlap), `outcomes.ts` (Y + survie
via protocole partagé), `analysis.ts` (Spearman, déciles, stabilités,
métriques obligatoires), `pipeline.ts` (grille discovery/calibration/holdout).

## 6. Limites et prochaines étapes

1. **Attendre n ≥ 30 en discovery** (backfill en cours) avant toute lecture
   des corrélations ; ne rien verrouiller avant.
2. Horizons 6h/24h **non couverts** : soit le collecteur allonge les séries,
   soit documenter que la question survie ne se teste qu'à 1h sur ces données.
3. `sells` (rétention à +5 min) : la plupart des fichiers ont
   `walletsCovered = 0` (échecs Helius `-32015`) — H-PRED-WAL-07 en suspens
   jusqu'à un backfill sells fonctionnel.
4. `devHistory` : brancher le registre H-DEV/H-BLOCK quand un artefact
   mint → dev wallet existera (interface prête : `devHistory` dans
   `WalletFeatures`, actuellement null documenté).
5. `overlapFrac` dégénéré à 0 : ne deviendra informatif qu'avec un dataset
   de centaines de tokens.
6. Rappel : même à n ≥ 30, toute mesure reste une **borne optimiste**
   (biais tokens chauds) — la validation finale appartient au holdout
   `data/track-unbiased/` (30 j de collecte propre), jamais à ces données.

---
*Généré le 2026-09-28 ~12h35 EDT. Données : `data/earlybuyers/` (11 fichiers),
`data/history/` (2926 mints). Aucun commit, aucun push, aucune transaction.*
