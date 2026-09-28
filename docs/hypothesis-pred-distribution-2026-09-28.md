# Hypothèses prédictives — DISTRIBUTION (domaine 4/5)

**Date :** 2026-09-28 · **Phase :** DÉCOUVERTE · **Branche :** `feat/deku-cupsey` (aucun push)
**Protocole :** `lab/predictive/universe.ts` (split discovery <50 / calibration 50–74 / holdout ≥75, disjoints par hash FNV du mint) · t0 = premier snapshot liquidityUsd ≥ 20 000 et priceUsd > 0 · Y = rendement futur (prix nettoyés des ticks aberrants ≥100× vs voisins) sur 1h / 6h / 24h, null si horizon non couvert.
**Pré-enregistrement :** OUI — ce document (prédictions, variables, critères de passage, falsificateurs) est rédigé AVANT toute mesure. L'exécution de `lab/predictive/distribution/run.ts` a confirmé le statut de chaque hypothèse (voir `docs/predictive-distribution-2026-09-28.md`).
**Données :** `data/history/` (2 926 mints, 35 339 ticks — biaisées vers les tokens chauds → **toute mesure = borne OPTIMISTE**) · `data/tokens/` (dernier état) · `data/earlybuyers/` (backfill en cours).
**Règle n≥30** pour toute conclusion. Résultat principal AVEC les outliers valides ; sensibilité SANS outliers valides (Y hors [P1, P99], convention partagée avec le domaine temporal).
**Interdit :** aucune stratégie construite en phase découverte — relation prédictive uniquement. Holdout : UNE SEULE mesure par survivant, jamais de re-calibrage après.

---

## Question centrale

Une concentration ÉLEVÉE à t0 prédit-elle un Y futur **positif** (whales qui portent le token) ou **négatif** (dump coordonné) ? Les deux directions sont testées sans a priori.

## Variables X (toutes définies à t0 ou avant)

| Variable | Définition | Source | Hypothèse ID |
|---|---|---|---|
| `top10Pct` | part (%) du top 10 holders à t0 ; 100 = inconnu → null | `data/history` | H-PRED-DIST-01 |
| `holders` | nombre de détenteurs à t0 ; null si non collecté | `data/history` | H-PRED-DIST-02 |
| `deltaTop10` | `top10Pct`(t0) − `top10Pct`(dernier tick connu pré-t0) | `data/history` | H-PRED-DIST-03 |
| `top5_share` | part des 5 premiers early buyers | `data/earlybuyers` | H-PRED-DIST-04 |
| `gini` | coefficient de Gini des montants des early buyers | `data/earlybuyers` | H-PRED-DIST-04 |
| `same_slot_max` | part max d'early buyers dans le même slot (proxy bundling/coordination) | `data/earlybuyers` | H-PRED-DIST-05 |
| `sellersOver50` | early buyers ayant vendu >50 % sous 300 s | `data/earlybuyers` | H-PRED-DIST-05 |
| cluster (top10Pct élevé × sells élevés à t0) | décile haut de `top10Pct` ET décile haut de `sellRatio` à t0 | `data/history` | H-PRED-DIST-06 |

**Critère de passage découverte → calibration (commun) :** n ≥ 30 avec X et Y mesurables en univers discovery, |spearman| significatif (IC bootstrap excluant 0) OU écart médiane décile haut vs bas de X avec IC disjoints, signe stable entre les deux moitiés temporelles. Sinon : NON CONCLUANT (n < 30) ou INMESURABLE (X indisponible).

---

## Hypothèses

### H-PRED-DIST-01 — la concentration du top 10 à t0 prédit Y
**Prédiction :** ρ(`top10Pct`, Y) ≠ 0 — direction ouverte : ρ > 0 = « whales qui portent », ρ < 0 = « dump coordonné ».
**Falsificateur :** ρ ≈ 0 avec IC incluant 0 sur discovery, ou instabilité du signe entre moitiés/cohortes.
**Statut :** **BLOQUÉE — INMESURABLE.** `top10Pct` = 100 (codage « inconnu ») sur 100 % des 35 339 ticks de `data/history/`. Couverture X : 0 dans les trois univers. La jointure `data/tokens/` (590 mints avec `top10Pct` réel, médiane 15,42) mesure la concentration au **dernier** tick — inutilisable comme X (look-ahead) ; les 27 mints où dernier tick = tick t0 ont Y indéfini (séries mortes à t0 : artefact de sélection).
**Déblocage requis :** mesurer la distribution des holders **à t0** (pas au dernier tick).

### H-PRED-DIST-02 — le nombre de holders à t0 prédit Y
**Prédiction :** ρ(`holders`, Y) ≠ 0 — direction ouverte (beaucoup de holders = distribution saine → Y+, ou dilution → Y−).
**Falsificateur :** idem H-PRED-DIST-01.
**Statut :** **BLOQUÉE — INMESURABLE.** `holders` = null sur 100 % des ticks (`data/history/` et `data/tokens/` — DexScreener ne fournit pas le champ).
**Déblocage requis :** source on-chain (Helius) du nombre de holders à t0.

### H-PRED-DIST-03 — la concentration *croissante* vers t0 prédit Y
**Prédiction :** Δ`top10Pct` (t0 − pré-t0) > 0 (accumulation) vs < 0 (distribution) prédit Y avec un signe stable.
**Falsificateur :** idem, ou Δ uniformément nul/indéfini.
**Statut :** **BLOQUÉE — INMESURABLE.** Aucune borne connue sur aucune ligne (découle de H-PRED-DIST-01).
**Déblocage requis :** idem H-PRED-DIST-01, sur au moins deux points (pré-t0 et t0).

### H-PRED-DIST-04 — la concentration des early buyers prédit Y
**Prédiction :** ρ(`top5_share`, Y) ≠ 0 et ρ(`gini`, Y) ≠ 0 — direction ouverte.
**Falsificateur :** idem.
**Statut :** **BLOQUÉE — n=10 < 30, descriptif seul.** 10 fichiers avec métriques ; 7 avec Y 1h (spearman descriptifs : −0,43 pour les deux — non interprétables). **Contamination temporelle :** métriques calculées à `migration + ~60 min` alors que t0 ≈ `migration + 9–26 min` — X mesuré après le début de la fenêtre Y 1h (look-ahead partiel).
**Déblocage requis :** n ≥ 30 ET métriques calculées à la migration (ou garanties `< t0`) ; fiabiliser le backfill (erreurs RPC Helius -32015 observées).

### H-PRED-DIST-05 — la coordination des early buyers (bundling) prédit Y
**Prédiction :** ρ(`same_slot_max`, Y) ≠ 0 ; `sellersOver50` > 0 prédit Y négatif (dump précoce coordonné).
**Falsificateur :** idem.
**Statut :** **BLOQUÉE — n=10 < 30, descriptif seul.** `same_slot_max` ∈ [0,04 ; 0,40] (médiane ~0,10) ; `sellersOver50` = 1 wallet sur 5 fichiers avec bloc `sells` ; `coordinated_sells` = null partout. Même contamination temporelle que H-PRED-DIST-04.
**Déblocage requis :** idem H-PRED-DIST-04.

### H-PRED-DIST-06 — cluster (top10Pct élevé × sells élevés à t0)
**Prédiction :** le cluster « concentration haute ET pression vendeuse haute à t0 » a un Y médian inférieur au cluster « concentration haute ET pression vendeuse basse » (dump coordonné vs whales qui portent).
**Falsificateur :** écart de médianes nul ou inversé, ou IC qui se recouvrent.
**Statut :** **BLOQUÉE — NON EXÉCUTABLE.** Le cluster requiert `top10Pct` à t0, inconnu à 100 % (H-PRED-DIST-01). Le proxy `sellRatio` seul (mesurable à 100 %, n=328/178/46 en discovery : spearman −0,23 / −0,33 / −0,14) est une variable de **flux**, pas de distribution — renvoyé au domaine flux/structure temporelle, sans hypothèse ici.

---

## Registre de phase

| Hypothèse | Phase | Décision | Prochaine étape |
|---|---|---|---|
| H-PRED-DIST-01 | DÉCOUVERTE | BLOQUÉE (INMESURABLE) | collecte distribution à t0 |
| H-PRED-DIST-02 | DÉCOUVERTE | BLOQUÉE (INMESURABLE) | collecte holders on-chain à t0 |
| H-PRED-DIST-03 | DÉCOUVERTE | BLOQUÉE (INMESURABLE) | idem 01, deux points temporels |
| H-PRED-DIST-04 | DÉCOUVERTE | BLOQUÉE (n=10, contamination temporelle) | backfill n≥30, métriques à la migration |
| H-PRED-DIST-05 | DÉCOUVERTE | BLOQUÉE (n=10, contamination temporelle) | idem 04 |
| H-PRED-DIST-06 | DÉCOUVERTE | BLOQUÉE (NON EXÉCUTABLE) | idem 01 |

**Aucune hypothèse ne passe en calibration. Holdout (≥75) jamais mesuré. `data/track-unbiased/` non touché.**
