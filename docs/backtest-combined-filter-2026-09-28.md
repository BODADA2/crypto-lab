# Backtest walk-forward — filtre combiné « manuel + skin in the game » (2026-09-28)

**Nature :** backtest walk-forward sur données réelles, protocole du labo (n≥30, médianes,
pas de lookahead). Aucun seuil du moteur modifié, aucune transaction réelle.
Script : `lab/backtest/run-combined-filter.ts` · données : `data/backtests/combined-filter-2026-09-28.json`.

## 1. Protocole

- **Filtre testé :** `(domaine URI = ipfs.io) ET (devBuy ≥ seuil)` , hors `pool=bonk`.
  Les deux champs sont connus à l'événement `create` → **aucun lookahead**.
- **Outcome :** migration dans les **12 h** suivant le create (fenêtre fixe anti-censure ;
  délais create→migration mesurés : médiane 0,0 h, p90 0,5 h, p95 3,9 h — 12 h capture > 95 %).
- **Split :** train = creates 24–25 sept. (n = 17 843), test = creates 26–27 sept. avec suivi
  complet (n = 36 196). Seuil Q3 calculé **sur le train uniquement** (1,00 SOL).
- **Artefact bonk :** `devBuy = 0` pour 52,5 % des creates `pool=bonk` (structure de tx
  différente, pas des vrais zéros) → bonk **exclu** du filtre, documenté ici.
- Source : `data/scans/pump-2026-09-24…28.jsonl`, 66 562 creates dédupliqués.

## 2. Résultat principal — l'edge migration TIENT hors échantillon

Taux de base : train **2,30 %**, test **2,31 %** — parfaitement stable.

| Seuil devBuy | Train | Test (n≥30 ✓) | IC 95 % test |
|---|---|---|---|
| ≥ 1,0 SOL (Q3 train) | 9,68 % (n=2 097) | **9,33 %** (n=3 601) | 8,38–10,28 |
| ≥ 1,3 SOL | 11,44 % (n=1 731) | **10,73 %** (n=3 114) | 9,64–11,81 |
| ≥ 1,5 SOL | 13,97 % (n=1 374) | **13,13 %** (n=2 529) | 11,81–14,44 |

- **Monotone en seuil sur train ET test** : plus le dev met des siens, plus ça migre.
  Ce n'est pas un artefact de seuil, c'est un mécanisme (skin in the game + déploiement non industriel).
- **Stable par jour** (filtre ≥ 1,3 SOL, sans mayhem) : 24 → 12,56 % (n=199) ;
  25 → 12,58 % (n=1 367) ; 26 → 11,42 % (n=1 568) ; 27 → 14,11 % (n=1 063).
  Base : 1,97–2,55 %. Pas un accident d'un seul jour.
- **Raffinement mayhem (test, hors échantillon)** : combiné + `mayhem=true` → **1,04 %**
  (n=483) contre combiné sans mayhem → **12,50 %** (n=2 631). Le flag mayhem tue le filtre :
  à ajouter comme exclusion.

**Verdict migration : SIGNAL CONFIRMÉ.** 4,6× le taux de base, robuste au seuil, stable
dans le temps, n largement ≥ 30.

## 3. Le point dur — migration ≠ profit (démontré)

Un filtre qui prédit la migration ne prédit pas la rentabilité. Chiffrage :

- **Multiple gagnant entrée→migration ≈ x3,3** (mcap graduation ≈ 107 SOL / mcap médiane
  à l'entrée 32,6 SOL — cohérent avec la calibration empirique $23,5k du edge-check).
- **Continuation post-migration** (n=257 tokens migrés suivis) : médiane **+38 %**,
  p75 +111 %, p90 +214 %. Seuls 27,6 % font >x2, 5,1 % >x5 après migration.
- **Total gagnant typique** (entrée au create, sortie parfaite au max post-migration) : ~**x4,5** médian.
- **Breakeven** (p = 10,73 %, coûts 8 %) : les gagnants doivent faire en moyenne
  **x5,2** (si les perdants ne perdent « que » 42 % — hypothèse optimiste et biaisée)
  à **~x10** (si les perdants vont à -95/-100 %, réaliste pour des tokens qui ne migrent pas).
- **x3,3–x4,5 < x5,2–x10** → la stratégie « acheter au create, vendre à/après migration »
  est **structurellement non rentable** en l'état. Les 10,7 % de gagnants ne paient pas
  les ~89 % de perdants.

**Note d'honnêteté sur le volet prix :** une simulation P&L sur `data/history` est
**invalide** pour cette question — 90,2 % des tokens du filtre qui y sont suivis ont
*déjà* migré (le collecteur suit à partir de la migration : biais de sélection massif).
La simuler reviendrait à « acheter le top post-migration ». Ce volet est documenté
mais **exclu du verdict**. Le breakeven ci-dessus, lui, repose sur des grandeurs
mesurables (taux test non biaisé, mcap au create, calibration migration).

## 4. Filtre d'exclusion industriel (second)

Ensembles sur le test : exclus (`j7tracker.io` / `uxento.io` / `pinata` / `mayhem=true`) →
**1,44 %** (n=19 336) ; conservés → **3,30 %** (n=16 860) ; base 2,31 %. Lift **1,43×**.

- **Runners filtrés par erreur : 278** migrations du test auraient été exclues (33 % des
  835 migrations). C'est le coût, mesuré honnêtement.
- **Rugs évités : non mesurable** avec ces données (aucune donnée de « mort » des tokens,
  seulement l'absence de migration). Limite explicite, pas de chiffre inventé.
- Recommandation : règle d'exclusion **candidate**, à activer quand le moteur générera
  des trades (il en génère 0 aujourd'hui — H-DATA-1 — donc rien à filtrer pour l'instant).

## 5. Recommandation

**NE PAS intégrer le filtre combiné comme signal d'achat.** L'edge statistique est réel
et robuste, mais l'espérance de la stratégie complète est négative (démontré §3).

Trois voies, par ordre de priorité :

1. **Pipeline en deux étages (recommandé).** Garder le filtre comme *première étape de
   sélection* : il réduit l'univers à 8,6 % des tokens avec 4,6× la densité de migration.
   Le vrai travail — et le vrai edge — est le **second filtre** qui sépare, *au sein du
   segment*, les ~11 % de gagnants des ~89 % de perdants. C'est là qu'il faut creuser :
   qu'est-ce qui distingue un migré qui fait x10 d'un migré qui fait x3 ?
2. **Données d'abord.** Le bloqueur n°1 est le suivi biaisé : échantillonner *aléatoirement*
   des tokens du filtre dès le create et les suivre (prix) sans sélection sur la chaleur.
   Sans ça, aucun P&L n'est mesurable honnêtement. (Renforce H-DATA-1.)
3. **Exclusion mayhem** : ajouter `is_mayhem_mode=true` aux exclusions du moteur
   (coût quasi nul, gain mesuré : 10,73 % → 12,50 % sur le segment).

**À ne pas poursuivre :** H-CALLTRACK (falsifié), H-CURVE v1 (biaisée), H-POSTMIG
(données insuffisantes) — confirmé, rien de nouveau ne les réhabilite ici.

## 6. Protocole d'intégration proposé (sans modifier les seuils)

Si Hervé valide la voie 1, le protocole serait :

1. Implémenter le filtre combiné (+ exclusion mayhem) comme **pré-filtre d'univers**
   dans `lab/paper-engine/` — sélectionne les candidats, ne déclenche aucun trade seul.
2. Les seuils de décision (score 60 %, couverture, risque) **restent inchangés**.
3. Définir le second étage comme hypothèse séparée (H-RUNNER ?) avec son propre
   protocole n≥30 walk-forward avant toute intégration.
4. Mesurer en paper : taux de candidats/jour, taux de migration des candidats,
   puis seulement ensuite envisager une logique d'entrée/sortie.

**Falsificateur :** si le taux test du segment passe sous 2× la base sur 7 jours
glissants, ou si le suivi non biaisé montre des multiples gagnants < x5, le filtre
est rétrogradé en simple variable descriptive.

---
*Backtest exécuté le 2026-09-28, données réelles du collecteur 24–28 sept. 2026.
Aucune donnée fabriquée, aucun seuil modifié, aucune transaction réelle.*
