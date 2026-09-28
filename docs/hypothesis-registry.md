# Registre des hypothèses — Crypto Lab

**Discipline :** chaque hypothèse est inscrite avec sa prédiction, son protocole, ses données,
son n et son verdict — y compris (surtout) les falsifications. Un registre n'est utile que
s'il enregistre les échecs aussi fidèlement que les succès.

**Dernière mise à jour :** 2026-09-28 · **Branche :** `feat/deku-cupsey` (commits locaux, aucun push)

**Légende des verdicts :** `FALSIFIÉE` (données contre) · `ABANDONNÉE` (falsificateur déclenché
ou artefact) · `NON CONCLUANT` (données insuffisantes ou bruit) · `NO ACTION` (testé, rien à
coder) · `EN COURS` (protocole gelé, verdict à venir) · `NON TESTÉE` (pas de données) ·
`PISTE` (idée non opérée).

**Légende pré-enregistrement :** `OUI` (doc formelle avant résultats) · `PARTIEL` (protocole
et falsificateur figés avant de voir les résultats, sans doc formelle) · `NON` (hypothèse
formulée après exploration des données — à risque de snooping, voir §5).

---

## 1. Hypothèses testées avec verdict quantitatif

| ID | Prédiction | Protocole | Dataset | n | Pré-enr. | Verdict | Réf. |
|---|---|---|---|---|---|---|---|
| H-NARR v2 | Un catalyst narratif (dimension « catalyst » du score) prédit la migration : lift > 1,3 | Backtest walk-forward : buckets catalyst fort/faible/aucun → taux de migration + MFE médian | data/scans 24–28 | 63 267 creates (13 665 « fort ») | PARTIEL | **NO ACTION** — lift ×1,03, MFE médian ×1,20 vs ×1,15 : ne prédit rien | run-catalyst-migration.ts, red-team §1.7 |
| H-EXIT | Sortie en 3 paliers (+40/+100/trailing) bat la sortie unique à +40 % nette de frais | Backtest 3 variantes (scalp/runner/adaptive) sur mêmes entrées, n≥30 | data/history (2 713 tokens, 31 618 obs.) | 752/variante | PARTIEL | **NON CONCLUANT** — espérances proches (65,9 vs 70,0), win rates 44,3 % vs 25,5 %, moyennes dominées par ticks aberrants, médianes négatives | exit-harness.ts, fiche deku §3.3 |
| H-CHASE | Rejeter les entrées « verticales » (chase ≥ +50 % sur 3 barres) améliore le scalp | Baseline A vs filtrée B, sorties identiques (TP+30/SL−20/time-stop), coûts 50 $, 1,3 % + slippage | data/history | A n=445, B n=387 | OUI (fiche) | **NO ACTION** — médiane −1,3 % vs −1,0 % (bruit), win rate 45,5 % vs 47,4 %. Twist : entrées verticales (n=154) MFE médian ×1,25 vs ×1,20 — le momentum persiste | research-2026-09-28-h-chase.md |
| H-DEVBUY | devBuy (mise initiale du dev) prédit la migration, monotone en seuil | Quartiles devBuy → taux migration ; puis walk-forward filtre (ipfs.io × devBuy≥seuil) | data/scans 24–28 | 41 619 (quartiles) ; test n=3 114 (seuil 1,3) | PARTIEL | **FALSIFIÉE** — le 10,73 % était l'artefact late-discovery ; sur genuine : 1,66 % IC[1,19–2,13] vs base 1,42 %, monotonicité plate (1,51→1,54→1,50) | audit-late-discovery-2026-09-28.md |
| Filtre combiné | (ipfs.io ET devBuy ≥ 1,3 SOL) → ~10 % migration, tradable | Walk-forward train 24–25 / test 26–27, outcome migration ≤12h, hurdle 8 % | data/scans 24–28 | test n=36 196 | PARTIEL | **ABANDONNÉ** — artefact (607 late-discovery à 100 % migrés) ; genuine 1,54 %/1,66 % ; breakeven impossible (gagnants ×4,5 < ×5,2–×10 requis) | backtest-combined-filter-2026-09-28.md |
| H-TOOL | Le domaine d'URI (outil de déploiement) prédit la migration | Taux de migration par domaine, IC 95 %, walk-forward | data/scans 24–28 | ipfs.io n=27 478 ; j7 n=7 214 ; uxento n=2 083 | NON | **Résiduel faible, NON ACTIONNABLE** — sur genuine : uxento 0,45 %, j7 0,87 % vs ipfs.io 1,31 % ; lift d'exclusion 1,09× (nul) | edge-check-2026-09-28.md §H-TOOL + audit |
| H-CURVE v1 | La progression sur la courbe (buckets 0–25/50/75/100 %) prédit migration/MFE | progress = mcapUsd(snapshot)/seuil au 1er snapshot → taux + MFE par bucket | data/history | 2 727 tokens | NON | **NON CONCLUANT** — biais de sélection massif (46,4 % de migrés suivis vs 2,37 % de base) | edge-check-2026-09-28.md §H-CURVE |
| H-CURVE v2 | marketCapSol au create (ce que le moteur voit) prédit la migration | Quartiles mcapSol@create → taux migration | data/scans 24–28 | 41 619 | NON | **REDONDANT** — mcapSol@create ≈ 30 + devBuy : même mécanisme que H-DEVBUY, pas un edge indépendant | edge-check-2026-09-28.md §H-CURVE |
| H-POSTMIG | Pattern systématique du prix dans ±60 min autour du migrate | Prix normalisé t−60…t+60, courbe moyenne+médiane, n≥30 avec snapshots des 2 côtés | data/history | 58 migrés (13–21 snaps/tranche 10 min) | NON | **DONNÉES INSUFFISANTES** — côté pré-migration trop clairsemé pour statuer | edge-check-2026-09-28.md §H-POSTMIG |
| H-CALLTRACK | Les channels d'appels ont un taux de migration mesurable (alpha vs exit liquidity) | Joindre 122 calls aux migrates ; taux vs base ; latence seenAt−postedAt | data-calls + scans | 40 calls SOL uniques, 11 migrés | NON | **FALSIFIÉE (timing)** — 27,5 % brut mais 10/11 avaient DÉJÀ migré avant le call : indicateur retardé, pas prédicteur | edge-check-2026-09-28.md §H-CALLTRACK |
| Second filtre | Parmi les migrés, l'imbalance acheteuse m5 > +0,2 au 1er snapshot post-migration sépare les gagnants (≥×2) | Caractérisation (n=558 migrés genuine suivis) puis backtest momentum-confirm walk-forward : entrée au snapshot APRÈS le signal, TP+100/SL−50/48h, hurdle 8 % | data/history + scans | carac. n=558 (45 gagnants) ; backtest test n=43 | PARTIEL | **ABANDONNÉ** — signal réel (25,3 % vs 3,2 %, IC disjoints) mais inexécutable : net médian test **−75,78 %**, entrée médiane ~30 min après migration (achète le top), MFE médian 0 % | second-filter-2026-09-28.md |

**Détail du second filtre — features create-time testées (toutes négatives) :**
devBuy (6,5–15,8 %, IC recouvrants) · dev répété vs nouveau (5,4 % vs 9,9 %) ·
heure UTC (4,7–10,9 %, IC recouvrants) · délai create→migrate (<15 min 7,4 %, 15–60 min 14,5 %, n=62).
Seuls 8,06 % des migrés genuine atteignent ×2 ; continuation médiane ×1,00.

## 2. Protocoles gelés — verdicts à venir (17 octobre 2026)

| ID | Prédiction | Protocole | Dataset | Critères (A et B séparément) |
|---|---|---|---|---|
| S1 volume anormal | Signal volume → achat observation suivante, TP+50/SL−25/~6h, 15 $ US/trade | preregistered.ts | data/history + scans | ≥30 trades, gains÷pertes ≥1,3, espérance >0 après frais |
| S3 post-migration | Achat migrés, TP+80/SL−30/~24h | preregistered.ts | idem | idem |
| S1 Robinhood | S1 sur chainId=robinhood | preregistered-rh.ts | data-rh/ | idem |
| H3 copier les calls | Achat après 1er call MadApes, sorties S3 | preregistered-calls.ts | data-calls/ | idem |
| H4 call + volume | Call puis volume 5 min ≥5 % liquidité + buys≥sells sous 2h, sorties S1 | preregistered-calls.ts | idem | idem |
| H5a / H5b sniping | Sniper parfait (prix post-création→+5 min) / réaliste (+1 min→+5 min), coûts 5 % | preregistered-snipe.ts | data-snipe/ | ≥30 snipes, G/P ≥1,3, esp.>0 ; RETENUE seulement si H5a ET H5b passent sur A ET B |

Réf. : `docs/preregistration-memecoins.md` (figé le 25 sept. 2026, amendements avant tout résultat).

## 3. Non testées — données manquantes ou confondues

| ID | État | Ce qui manque |
|---|---|---|
| H-BUNDLE | NON TESTÉE — SPEC RÉDIGÉE | Ventes groupées des early wallets = filtre d'exclusion (Cupsey). Données : 1 seul token avec early buyers. Spec de collecte rédigée (docs/insider-economics-2026-09-28.md §2, Helius ~210 crédits/token, marge OK) ; test T-BUNDLE gated dans l'addendum pré-enregistré |
| H-BLOCK | IMPLÉMENTÉE, NON VALIDÉE | Blocklist de devs (TikTok @hellojrus). Tranchage bannissement dur vs pénalité : mesurer rugs évités vs runners filtrés par erreur, n≥30 |
| H-FRESH | MESURÉE, CONFONDUE | Vitesse d'entrée via timestamp de 1re observation — mesure notre latence de scan, pas la naissance du token |
| H-FEEFLOW | NON TESTÉE — SPEC RÉDIGÉE | Mapping bénéficiaires de creator fees — aucune donnée (mécanisme inobservable). Proxy « relance post-graduation » testé et CONFOUNDU (2 wallets = 71 % des paires). Spec de collecte rédigée (docs/insider-economics-2026-09-28.md §3) ; test T-FEEFLOW gated dans l'addendum. Ne pas approximer (deep-edges E13) |
| H-EXTRACT | NON TESTÉE | Trades par wallet + estimation fees — partiellement payant via PumpPortal |
| H-SNIPER | NON TESTÉE | earlybuyers systématique (1 seul fichier aujourd'hui) |
| H-DEV (face +) | NON CONCLUANTE (signal exploratoire) | Registre testé 2026-09-28 : 65 941 creates genuine, 21 660 wallets, base 1,41 %. Répétition seule FALSIFIÉE (≥3 creates → 1,11 % < 1,38 %). Taux passé persiste faiblement (ρ≈0,29 p<10⁻⁶ ; hot-devs ×1,9 sur H2). Limite n°1 : wallets≠humains (rotation). Test T-SERIAL-HOT dans l'addendum pré-enregistré |
| H-CONC / H-TIME / H-LIQMIRAGE / H-HALFLIFE / H-SERIAL / H-MAGNET / H-COPYCAT | PROPOSÉES (deep-edges E6–E12), NON TESTÉES | Testables sur données existantes ou propres — candidates à la batterie pré-enregistrée |
| H-MULTI | SURVEILLANCE | Launchpad PAID (fees versées sur X Money) — catalyst semi-prévisible, pas de modélisation sans données |
| H-CONV | PISTE | Conviction/tenue avec thèse écrite (Brez) — pas d'opérationnalisation |
| H-SESS | PROTOCOLE | Sessions paper à heures fixes + journal anti-tilt — métrique de discipline, pas un signal de marché |

## 4. Compteur des comparaisons multiples

**10 familles d'hypothèses ont reçu un verdict quantitatif sur la même fenêtre de données
(24–28 sept. 2026, `data/scans/` + `data/history/`) :**
H-NARR v2, H-EXIT, H-CHASE, H-DEVBUY, le filtre combiné, H-TOOL, H-CURVE (v1+v2),
H-POSTMIG, H-CALLTRACK, le second filtre.

À cela s'ajoutent **7 protocoles pré-enregistrés** (S1, S3, S1-RH, H3, H4, H5a, H5b)
dont les verdicts arrivent le 17 octobre — eux ne sont pas du snooping (gelés avant résultats).

**Règle de lecture :** avec 10 familles testées sur les mêmes données et un seuil de
significativité implicite de 5 %, **attendre ~0,5 faux positif par hasard** même sans aucun
edge réel. Un « signal » isolé sur cette fenêtre ne vaut rien sans réplication
walk-forward ET sur données propres. Le taux de base réel (~1,4 %, pas 2,3 %) rend le
hasard encore plus généreux en apparence.

## 5. Note sur le data snooping — le cas d'école late-discovery

Le 28 septembre, le « filtre combiné » affichait **10,73 %** de migration (n=3 114,
IC 95 % [9,64–11,81], monotone en seuil, stable sur 4 jours, walk-forward propre).
Tous les marqueurs d'un vrai edge étaient présents. C'était un **artefact de collecte** :
607 événements `create` tardifs au tuple figé `(85.005359057, …)`, 100 % migrés, avec un
`devBuy` fictif. Sur données genuine : **1,66 %** — aucun edge.

**Leçons enregistrées :**
1. Le walk-forward ne protège pas contre un biais présent dans TOUTE la fenêtre
   (train et test contaminés pareil).
2. Plusieurs hypothèses ci-dessus ont été formulées APRÈS exploration des mêmes données
   (ex. : les quartiles H-DEVBUY observés dans l'edge-check → formalisés dans le backtest).
   Les verdicts correspondants sont des **bornes optimistes**, pas des preuves.
3. La monotonicité en seuil et la stabilité temporelle ne distinguent pas un mécanisme
   d'un artefact systématique.
4. **Pare-feu :** la batterie pré-enregistrée (`docs/preregistered-tests-2026-09-28.md`)
   fige hypothèses, seuils et critères AVANT de voir les 30 jours de données propres
   (`data/track-unbiased/`, holdout). Tout test hors batterie = exploratoire, ne peut
   pas promouvoir un « signal » au statut de validé.

## 6. Hypothèses hedge — phase DÉCOUVERTE (28 sept. 2026)

Issues de l'analyse des modes d'échec (`docs/hedge-analysis-2026-09-28.md`).
Toutes sont en **phase DÉCOUVERTE** : aucun test sur le holdout, aucun verdict
promu sans réplication sur données propres. Le compteur de comparaisons
multiples passe à 10 + 6 = 16 familles sur la même fenêtre (attendre ~0,8 faux
positif à 5 %).

| ID | Hypothèse (prédiction) | Résultat découverte | Falsificateur |
|---|---|---|---|
| H-HEDGE-1 | Sortie d'urgence −8 %/6b améliore le scalp H-EXIT | **NO ACTION** — Δ médiane −1,29 % IC [−3,68 ; −0,18] (dégradation significative), 3,5 % des gagnants coupés | Δ médiane ≥ 0 sur holdout |
| H-HEDGE-2 | Time-stop 3 barres > 6 barres | **NON CONCLUANT** — Δ esp. +0,33 % IC [−0,58 ; +1,33] | Δ espérance ≤ 0 sur holdout |
| H-HEDGE-3 | Entrées verticales à demi-taille > plein | **PISTE FAIBLE** — Δ esp. +1,59 % IC [+0,11 ; +3,10], mais espérance reste négative (−4,56 %) ; 1 signal marginal sur 4 tests = bruit possible | Δ espérance ≤ 0 sur holdout |
| H-HEDGE-4 | Portfolio 50/50 scalp+runner > scalp seul | **FALSIFIÉ** (découverte) — esp. −11,98 %, DD 116 ×mise, pire que V1 seule | paire à espérances positives ET corrélation de pertes < 0,3 (inexistante ici) |
| H-HEDGE-5 | Sauter les entrées les jours de « frénésie » | **INTESTABLE** — 0 jour de frénésie sur 5 jours de scans | médiane frénésie ≥ autres régimes quand n≥30 |
| H-HEDGE-6 | Entrées liq ≥ Q3 → médiane > 0 | **PISTE** — médianes +9,27 % / +3,10 % en liq-Q3/Q4 (V1), win 56–61 % ; quartiles calculés sur ces mêmes données (snooping) → seuil à re-dériver sur données propres avant test | médiane ≤ 0 sur holdout 30 j, n≥30 |

**Constat central enregistré :** corrélations de Spearman V1×V6 = 0,973 et
V1×V7 = 0,963 — changer la sortie ne change pas l'exposition (« une stratégie
déguisée en cinq »). Quand V1 perd sur un token, toutes les autres variantes
perdent aussi (médianes −8 % à −46 %). **Aucune architecture de portfolio
justifiée par les données :** aucune composante à espérance ≥ 0, aucune
asymétrie, aucune décorrélation des pertes.

## 7. Extension hedge — phase DÉCOUVERTE (28 sept. 2026)

Issue de `docs/hedge-analysis-2026-09-28.md` §7 (`lab/backtest/run-hedge-exposure.ts`,
`tests/hedge-exposure.test.ts`, 21 tests verts). Score composite documenté :
`S = (E_w − λ_DD·DD − λ_σ·σ) × P_oos` (λ_DD=0,001, λ_σ=0,05), veto d'actionnabilité
**PF_w ≥ 1 ET médiane ≥ 0** — toutes les variantes V1–V10 sont **vetées**, aucune
actionnable. Le compteur de comparaisons multiples passe à 16 + 2 = **18 familles**
sur la même fenêtre (attendre ~0,9 faux positif à 5 %).

| ID | Hypothèse (prédiction) | Résultat découverte | Falsificateur |
|---|---|---|---|
| H-REF-MOM | Stratégie de référence « regime-filtered momentum » : entrées verticales (chase ≥ 0,5) + filtre de régime (exclusion pré-hoc famine/frénésie) → bat les variantes H-EXIT au score composite | **RÉFÉRENCE NON ACTIONNABLE** — esp. wins. −9,79 % IC [−17,32 ; −2,11], médiane −23,24 %, n=238. Le filtre de régime n'a RIEN exclu (0 jour famine/frénésie sur 5 j) : la composante « regime » est intestable ici ; le momentum pur sous-performe le chase mixte (V3 : −6,15 %) | esp. ≥ 0 ET médiane ≥ 0 sur holdout 30 j, n≥30 |
| H-HEDGE-EXPOSURE | Le meilleur hedge est un disjoncteur d'exposition : fenêtre K=30 trades complétés, suspension si WR<35 % ET médiane<0, reprise si médiane>0 → améliore le score composite sans créer d'espérance | **PISTE** (réducteur de risque, pas edge) — V1+halt (paramètres primaires pré-engagés) : E_w −4,89→−2,47 %, DD 59→30 ×mise, S −0,0986→−0,0508, 152 gagnants ratés vs 212 pertes évitées ; délai de détection médian 38 trades, 4/7 épisodes DD non détectés ; sensibilité cohérente (9 combinaisons, toutes améliorent E_w et réduisent le DD). Sur V10, halt DÉTÉRIORE E_w (−9,79→−16,02 %) : le disjoncteur a coupé l'exposition du trade outlier (+4 939 704 %) | ΔE_w ≤ 0 sur holdout, OU délai médian > durée médiane des épisodes DD, OU E_w protégée toujours vetée → abandon |

**Seconde stratégie (décorrélation mesurée, jamais supposée) :** corrélations
roulantes de Spearman (fenêtre 50, pas 10) des P&L + des drawdowns + sous stress.
Paire la plus décorrélée **mesurée** : V10×V4 (stress ρ = 0,06, n=168 communs).
Portefeuille 50/50 : S = −0,0357 (meilleur que chaque composante), E_w −1,23 %,
DD 4,54 ×mise, PF_w 0,93 — mais **NON actionnable** (vetos). Caveat : calculé sur
les 168 mints **communs** (sélection interne) — l'amélioration vient en partie de
l'intersection des univers, pas seulement de la décorrélation. **Aucune seconde
stratégie justifiée** ; la machinerie de mesure sera appliquée au holdout 30 j.

## 8. Décomposition économique — phase DIAGNOSTIC (28 sept. 2026)

| ID | Hypothèse (prédiction) | Résultat | Falsificateur |
|---|---|---|---|
| H-DECOMP | L'espérance négative de H-REF-MOM vient d'un edge brut détruit par les coûts (auquel cas : problème d'exécution) plutôt que d'une absence d'edge avant coûts | **FALSIFIÉE — NO EVIDENCE OF EDGE** : brutRéel −8,92 % (significativement négatif), brutIdéal +2,70 % IC [−4,52 ; +12,34] non significatif, médiane −14,21 %. Coûts : frais 1,18 pt + slippage 0,29 pt — bruit de fond devant le drift (−8,92 pts). Hiérarchie : drift ≫ frais > slippage. **Règle d'arrêt déclenchée : arrêter l'optimisation de la famille momentum/scalp** | brutIdéal significativement > 0 sur holdout 30 j (données propres) |
| H-GLITCH | Le trade +4 939 704 % est un vrai moonshot capturable | **FALSIFIÉE** : mint `SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3`, prix 192 $ → 0,0038 $ → 192 $ (glitch décimal DexScreener), incapturable. 1/242 trades, +20 412 pts à la moyenne brute. Les 31 autres « outliers » (MAE ≤ −90 %) sont de vraies morts, pas des glitches | — (forensique close) |
| H-STOPGAP | Le stop-loss −20 % protège à −20 % | **FALSIFIÉE** : réalisé médian −37,1 % (gap −17,1 pts) ; 12,9 % des trades meurent à ≥ −90 % en une barre. La sortie d'urgence n'existe pas à cette granularité | — |

Constats structurants : (1) les moyennes brutes sont inutilisables (+20 672 %
sur brutRéel — un seul tick aberrant) ; (2) l'univers validation disjoint
affiche +60 224 % entièrement porté par l'artefact SKHY (médiane −25,3 %) ;
(3) le biais hot-token rend les mesures optimistes d'~12 pts en médiane
(froid −32,6 % vs chaud −20,6 %) ; (4) filtre anti-tick-aberrant (≥100× vs les
deux voisins) à ajouter au pipeline. Doc : `docs/expectancy-decomposition-2026-09-28.md`.

## 9. Programme prédictif — phase DÉCOUVERTE (28 sept. 2026)

Question : existe-t-il une propriété observable AVANT le mouvement qui
distingue les tokens à Y futur positif ? Protocole : `lab/predictive/universe.ts`
(t0 = liq ≥ 20 k$, Y = 1h/6h/24h, anti-glitch ≥100×, univers disjoints
discovery/calibration/holdout par hash). Verdict Phase 1 : **NO EVIDENCE OF
PREDICTIVE SIGNAL pour une espérance positive** — les signaux survivants sont
des filtres d'exclusion (prédisent les pertes, pas les gains).

| ID | Hypothèse (prédiction) | Résultat | Falsificateur |
|---|---|---|---|
| H-PRED-FLOW-01 | Frénésie d'activité à t0 ⇒ Y@1h négatif | **SURVIT (DÉCOUVERTE)** : holdout ρ=−0,220, p=0,0029, IC [−0,37 ; −0,06], n=182. Reste à re-tester sur collecte propre 30 j | ρ ≥ 0 au holdout propre |
| H-PRED-FLOW-02 | Divergence prix/dominance ⇒ Y@6h négatif | Observation non calibrée (ρ=−0,291) — à tester proprement | — |
| H-PRED-LIQ-01 | Turnover élevé à t0 ⇒ Y futurs négatifs | **CONFIRMÉE directionnellement (DÉCOUVERTE)** : holdout 6h sp=−0,410 (n=97), top décile médiane −83,7 %. Filtre d'exclusion, pas edge long | sp ≥ 0 au holdout propre |
| H-PRED-LIQ-02 | Profondeur élevée évite les catastrophes | **PARTIELLE** : 6h tient (+0,271), 1h infirmée (+0,008) | sp ≤ 0 @6h au holdout propre |
| H-PRED-LIQ-03 | mcLiq élevé ⇒ meilleurs Y | **MIXTE** : direction 6h (+0,222), amplitude effondrée | — |
| H-PRED-LIQ-04 | Croissance pré-t0 vs stagnation | **INTESTABLE** (n=34) — retester après 30 j | — |
| H-PRED-LIQ-05 | 4 signaux liquidité indépendants | **FALSIFIÉE** : corrélations 0,37–0,79 → une seule dimension | — |
| H-PRED-TEMP-LEVEL | Niveau prix/liq à t0 ⇒ Y@6h | **PROMU avec réserves (DÉCOUVERTE)** : ρ 0,39→0,31→0,28, n=97 ; p limite vs Bonferroni, biais de survie | ρ ≤ 0 au holdout propre |
| H-PRED-TEMP-AGE | Jeunesse ⇒ Y | **FALSIFIÉE** directionnellement puis NO SIGNAL | — |
| H-PRED-TEMP-GROWTH/ACCEL/ACTIVITY | Forme pré-t0 ⇒ Y | **NON CONCLUANTES** (n < 30 ; 87 % t0 au 1er snapshot) | — |
| H-PRED-TEMP-SESSION | Heure de t0 ⇒ Y@1h | **PISTE FRAGILE** | — |
| H-PRED-DIST-01/02/03 | Concentration/Δ top10, holders ⇒ Y | **INMESURABLES** (top10Pct=100 partout, holders null) — NO DATA | données holders à t0 |
| H-PRED-DIST-04/05/06 | Métriques early buyers, clusters ⇒ Y | **BLOQUÉES** (n=10 < 30 ; contamination temporelle X après t0) | n≥30, X antérieur à t0 |
| H-PRED-WAL-01 à 09 | Variables early buyers ⇒ Y/survie | **NON TESTABLES** (n=1 en discovery) — pipeline prêt, question ouverte n°1 | n≥30 en discovery |

Convergence : FLOW-01 + LIQ-01 + TEMP-LEVEL = un seul phénomène — **la
frénésie à t0 prédit des pertes, le calme relatif prédit des pertes
moindres**. Aucune variable ne prédit Y positif OOS. Docs :
`docs/predictive-program-2026-09-28.md` + `docs/predictive-{wallets,flows,liquidity,distribution,temporal}-2026-09-28.md`.

---
*Registre tenu par Muse. Toute nouvelle hypothèse testée doit y être inscrite AVANT
d'influencer une décision — y compris les falsifications.*
