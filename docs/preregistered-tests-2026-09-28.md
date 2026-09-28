# Batterie de tests pré-enregistrée — 30 jours de données propres

**Statut : GELÉE le 2026-09-28, avant d'avoir vu les données.** Ce document ne doit pas être
modifié après le début de l'analyse. Toute modification ultérieure = nouveau document daté,
l'original restant intact (amendements traçables, jamais d'édition silencieuse).

**Données :** `data/track-unbiased/` — échantillon 5 % des creates genuine dès t=0, cadence
5 min / 12 h pré-migration puis 2 min / 60 min + 15 min / 48 h post-migration, flag
`late_discovery` appliqué à l'ingestion. Collecte démarrée le 2026-09-28.

**Fenêtre :** jours 1–30 de collecte (→ ~2026-10-28). **Split walk-forward :** train = jours
1–15, test = jours 16–30. Tous les seuils sont calculés sur le train uniquement.

**Verdict :** sous 7 jours après la fin de la fenêtre, dans
`docs/verdict-clean-30j-2026-11-XX.md`, scripts écrits à ce moment-là à partir de la
présente spec (relus avant exécution).

## Règles globales (anti-overfitting)

- **R1 — interdiction de piocher.** Aucune analyse d'outcome sur `data/track-unbiased/`
  avant la date de gel levée. Autorisé : monitoring opérationnel (comptes, taux d'erreur,
  verrous). Interdit : taux de migration, trajectoires, P&L, ou toute statistique
  conditionnelle au résultat.
- **R2 — tout est rapporté.** Les 10 tests sont exécutés et publiés, positifs comme négatifs.
  Pas de cherry-picking.
- **R3 — n≥30.** Tout bucket/groupe sous n=30 → `NON CONCLUANT` (ni positif, ni négatif).
- **R4 — médianes, pas moyennes.** Métriques principales en médiane + IC 95 %.
  Moyennes en diagnostic uniquement (les ticks aberrants ont déjà tué deux verdicts).
- **R5 — double gate.** Un signal n'est « validé » que s'il passe sur le train ET sur le test.
  Succès train seul = candidat à re-tester, pas un signal.
- **R6 — hors batterie = exploratoire.** Toute analyse non listée ci-dessous ne peut ni
  valider un signal ni modifier le moteur ou la politique.
- **R7 — critère de complétude.** La fenêtre n'est « complète » que si : 30 jours écoulés
  ET taux de snapshots réussis ≥ 70 % ET ≥ 500 tokens échantillonnés avec ≥ 12 h de suivi.
  Sinon : prolonger la collecte, ne jamais baisser la barre.
- **R8 — migration ≠ profit.** Tout test « migration » gagnant doit être suivi d'un chiffrage
  breakeven (hurdle 8 % par round-trip) avant toute conclusion de tradabilité.

## Les 10 tests

### T-DEVBUY-CLEAN — la mise du dev, sur données saines
- **Hypothèse :** le devBuy (`solAmount` au create, genuine uniquement, hors `pool=bonk`
  dont les zéros sont un artefact) prédit la migration de façon monotone.
- **Protocole :** quartiles de devBuy calculés sur le TRAIN → taux de migration ≤ 12 h
  par quartile, train puis test. IC 95 %.
- **Succès :** monotonicité stricte sur train ET test, ET quartile supérieur test avec IC
  excluant l'IC du taux de base.
- **Falsificateur :** monotonicité absente ou IC recouvrants.

### T-TOOL-CLEAN — l'empreinte de l'outil, sur données saines
- **Hypothèse :** le domaine d'URI (outil de déploiement) prédit la migration ;
  sous-test : exclusion industrielle (`j7tracker.io` / `uxento.io` / `pinata` /
  `mayhem=true`) → lift du portefeuille restant + coût (runners exclus par erreur).
- **Protocole :** taux de migration par domaine (n≥30), train puis test.
- **Succès :** ≥ 1 domaine avec IC excluant l'IC de la base sur train ET test.
  Sous-test exclusion : lift ≥ 1,2 ET < 40 % des migrations exclues par erreur.
- **Falsificateur :** tous les IC se recouvrent.

### T-CURVE-CLEAN — trajectoire pré-migration, version propre
- **Hypothèse :** les futurs migrés ont une courbe mcap différente AVANT migration.
- **Protocole :** snapshots **strictement antérieurs** au `migrateAt` (exclusion
  post-traitement : aucun snapshot post-migration dans la comparaison) ; buckets
  [0,15], [15,60], [60,180] min depuis t=0 ; médiane par token du mcapUsd médian,
  migrés vs non-migrés, IC 95 %.
- **Succès :** IC disjoints dans ≥ 1 bucket sur train ET test.
- **Falsificateur :** IC recouvrants partout. (Note : l'analyse structurelle du
  2026-09-28 sur données historiques suggère que 75 % des migrations surviennent
  dans les 15 min — ce test dira si, avec des données denses, une forme
  pré-migration existe.)

### T-POSTMIG-CLEAN — le chemin ±60 min autour de la migration
- **Hypothèse :** il existe un pattern systématique du prix autour du migrate
  (spike puis fade, ou continuation).
- **Protocole :** prix normalisé au prix à la migration, t−60…t+60 min, courbe
  médiane + IC 95 % par tranche de 10 min, n≥30 migrés avec données des deux côtés.
- **Succès :** la médiane s'écarte de > 20 % du plat dans un sens, IC excluant le plat.
- **Falsificateur :** chemin plat dans l'IC (la variance domine).

### T-MOMENTUM-CLEAN — confirmation momentum, entrée exécutable
- **Hypothèse :** l'imbalance acheteuse m5 > +0,2 (≥ 10 txns) au 1er snapshot
  post-migration (≤ 60 min) prédit la continuation ≥ ×2 **depuis un prix d'entrée
  exécutable**.
- **Protocole :** entrée au 1er snapshot APRÈS le signal (≤ 15 min après le signal,
  sinon trade annulé) ; sortie TP +100 % / SL −50 % / time-stop 48 h ; hurdle 8 %.
  Baseline : mêmes règles sans signal.
- **Succès :** médiane nette > 0 ET win rate > 15 % sur le test, avec n≥30.
- **Falsificateur :** médiane nette ≤ 0 (même falsificateur que le second filtre
  abandonné : −75,78 %).

### T-HALFLIFE — second regard sur H-NARR v2
- **Hypothèse :** le lift du catalyst est > 1 dans les premières heures puis s'éteint
  (la moyenne plate ×1,03 masquait une structure temporelle).
- **Protocole :** refaire le test catalyst en bucketisant par `narrativeDistance`
  (≤ 6 h, 6–24 h, > 24 h) ; lift par bucket, n≥30.
- **Succès :** lift > 1,3 dans le bucket ≤ 6 h, IC excluant 1, sur train ET test.
- **Falsificateur :** lift plat sur les buckets → H-NARR v2 enterré définitivement.

### T-MAGNET — le seuil comme aimant réflexif
- **Hypothèse :** le hazard de migration accélère de façon non linéaire près du seuil
  de graduation (85 SOL) — les snipers s'y concentrent, prophétie autoréalisatrice.
- **Protocole :** hazard de migration par décile de `marketCapSol` (snapshots
  pré-migration uniquement), train puis test.
- **Succès :** hazard du décile supérieur > 2× celui du décile inférieur, monotone.
- **Falsificateur :** hazard plat ou linéaire.

### T-TIME — les heures creuses
- **Hypothèse :** le taux de migration varie selon l'heure UTC de création.
- **Protocole :** taux de migration par heure UTC, test chi² d'uniformité (α = 0,05).
- **Succès :** rejet de l'uniformité ET ratio heure max / heure min > 1,5, sur test.
- **Falsificateur :** non-rejet (distribution uniforme).

### T-CONC — la concentration à la naissance
- **Hypothèse :** `top10Pct` au premier snapshot prédit la migration (prime au fair launch).
- **Protocole :** terciles de top10Pct → taux de migration, n≥30, train puis test.
  **Si les données holders ne sont pas collectées : test marqué `SKIP` avec justification,
  pas `NON CONCLUANT`.**
- **Succès :** monotonicité + tercile supérieur avec IC excluant la base, train ET test.
- **Falsificateur :** pas de relation monotone.

### T-SERIAL — la décrépitude du déployeur en série
- **Hypothèse :** via `traderPublicKey`, le N-ième token d'un déployeur migre
  différemment de son premier (farm vs compétence — le test tranche le sens).
- **Protocole :** pour chaque dev avec ≥ 5 creates : taux de migration token n°1 vs
  n°5+, comparaison appariée par acteur, n≥30 acteurs.
- **Succès :** différence avec IC excluant 0, même sens sur train et test.
- **Falsificateur :** pas de différence.

## Amendements

Tout amendement (données incomplètes, bug de collecte, test à ajouter) se fait par
nouveau document daté référençant celui-ci — **jamais** en éditant ce fichier après
le début de l'analyse. Un test ajouté après coup est marqué `POST-HOC` et ne peut pas
valider un signal, seulement en proposer un pour la prochaine batterie.

---
*Batterie rédigée par Muse le 2026-09-28, avant toute donnée propre.
Relue contre : le registre des hypothèses (`docs/hypothesis-registry.md`),
le red-team (`docs/red-team-2026-09-28.md`), et la spec du tracker
(`docs/unbiased-tracking-spec-2026-09-28.md` §6).*
