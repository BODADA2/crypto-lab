# Analyse hedge — partir des échecs pour chercher l'asymétrie

**Date :** 2026-09-28 · **Branche :** `feat/deku-cupsey` (commits locaux, aucun push)
**Phase :** DÉCOUVERTE UNIQUEMENT — aucune conclusion live, aucun seuil cherché ici
ne sera utilisé sans validation sur données propres.
**Données :** `data/history/` (2 911 tokens, 34 886 observations) — BIAISÉES vers les
tokens chauds suivis : toute mesure P&L ci-dessous est une **BORNE OPTIMISTE**.
Le holdout `data/track-unbiased/` n'a JAMAIS été touché.
**Code :** `lab/backtest/run-hedge-analysis.ts` (+ `tests/hedge-analysis.test.ts`, 20 tests verts).

**Question centrale :** qu'est-ce qui fait perdre toutes nos stratégies EN MÊME TEMPS,
et quelle exposition différente pourrait compenser ce facteur ?

---

## 0. Leçon de méthode : le tick aberrant qui valait +6 057 %

Avant tout résultat : sur données brutes, l'espérance du scalp (V1) affiche **+6 057 %**.
C'est un **tick aberrant** : le token `SKHYhSjuRWHg…` oscille entre 192,095 $ et
0,003832 $ d'une observation à l'autre (glitch DexScreener — probablement une erreur
d'unité), produisant un « trade » à **×50 526 en une seule barre**. Le même outlier
contamine V1, V2, V3, V6, V7 (espérances brutes +4 972 % à +10 054 %, profit factors
120 à 470 — tous fictifs).

C'est exactement le scénario red-team §3.1, observé sur nos propres données.
**Toutes les mesures primaires ci-dessous sont donc robustes :** espérance winsorisée
au p99 poolé (+272,5 %), médiane avec IC 95 % bootstrap, corrélations de Spearman
(rangs). Les moyennes brutes ne sont rapportées que pour mémoire — elles ne prouvent rien.

---

## 1. Inventaire — les 9 variantes et leurs modes d'échec

Même univers de tokens ; entrées/sorties identiques aux backtests d'origine
(H-EXIT, H-CHASE) sauf mention contraire. Coûts : 50 $, 1,3 % aller-retour, slippage
plafonné 3 %.

| ID | Variante | n | Esp. wins. IC 95 % | Médiane IC 95 % | Win | DD (×mise) |
|---|---|---|---|---|---|---|
| V1 | scalp H-EXIT (TP+30/SL−20/6b) — **principale** | 818 | **−4,89 %** [−9,52 ; −0,19] | −2,02 % [−5,38 ; −0,92] | 45,2 % | 59 |
| V2 | runner H-EXIT (paliers +50/+150/+300) | 818 | **−20,64 %** [−25,97 ; −15,31] | −35,76 % | 25,6 % | 185 |
| V3 | chase-A baseline H-CHASE | 491 | **−6,15 %** [−10,82 ; −1,57] | −1,17 % | 46,4 % | 36 |
| V4 | chase-B filtrée H-CHASE | 421 | **−7,65 %** [−12,18 ; −2,68] | −1,29 % | 44,2 % | 37 |
| V5 | entrée retardée t+2 | 712 | **−5,26 %** [−9,84 ; −0,81] | −2,16 % | 43,7 % | 46 |
| V6 | scalp + sortie d'urgence −8 %/6b | 818 | −4,22 % [−8,72 ; +0,40] | −3,30 % | 43,6 % | 55 |
| V7 | scalp time-stop 3 barres | 818 | **−4,56 %** [−9,01 ; −0,11] | −1,34 % | 44,5 % | 57 |
| V8 | chase-A, verticales à demi-taille | 491 | **−4,56 %** [−8,38 ; −0,76] | −1,02 % | 46,4 % | 27 |
| V9 | scalp hors jours « frénésie » | 818 | = V1 (0 jour de frénésie dans l'échantillon) | | | |

**Lecture :** 7 variantes sur 9 ont une espérance winsorisée **significativement négative**
(IC excluant 0). Aucune n'est positive. Les médianes sont négatives partout (30 buckets
sur 40 en §3). Le mode d'échec n'est pas « une mauvaise variante » : c'est le même
pour toutes — voir §2.

---

## 2. Carte des facteurs de risque — pourquoi tout perd en même temps

### 2.1 Les quatre facteurs communs

**F1 — Drift négatif structurel.** La plupart des tokens saignent vers zéro après
l'entrée : médianes négatives dans 30/40 buckets (variantes × régime × liquidité ×
chase × âge). Win rates 25–46 %. Ce n'est pas un problème d'entrée ou de sortie :
c'est la distribution des tokens.

**F2 — Coût fixe par trade.** Sensibilité aux frais (V1) : à 1,3 % l'espérance
winsorisée est −4,89 % (médiane −2,02 %) ; à 5 % elle tombe à −8,32 % (médiane
−5,69 %). Chaque trade paie ~1,3–5 % avant même le premier mouvement de prix.
Le slippage (cap 3 %→6 %) est négligeable ici : les liquidités d'entrée sont
suffisantes pour 50 $.

**F3 — Les outliers positifs sont partagés, pas diversifiables.** Le même tick
aberrant (et les quelques vrais gros gagnants : +1 231 %, +495 %, +351 %) apparaît
dans V1, V2, V3, V6, V7 simultanément. Il n'y a pas « le bon côté » où les
gagnants se cachent pendant que l'autre variante perd : les queues positives sont
communes.

**F4 — Corrélation des pertes (le résultat central).** Sur les tokens où V1 perd
(n=448 mints communs), **toutes** les autres variantes perdent aussi :

| Variante sur les mints où V1 perd | n | Moy. wins. | Médiane |
|---|---|---|---|
| V2 runner | 448 | −51,36 % | −46,02 % |
| V3 chase-A | 205 | −13,08 % | −11,00 % |
| V4 chase-B | 179 | −11,86 % | −7,80 % |
| V5 retardée | 353 | −24,33 % | −25,66 % |
| V6 urgence | 448 | −47,54 % | −37,87 % |
| V7 stop court | 448 | −46,95 % | −39,55 % |
| V8 demi-taille | 205 | −10,62 % | −9,29 % |

Il n'existe pas, dans cet univers de variantes, d'exposition qui gagne quand la
principale perd. **C'est la réponse honnête à la question centrale** : le facteur
qui fait tout perdre en même temps, c'est F1+F2 (le token saigne, le trade paie),
et aucune des expositions testées ne s'en décorrèle.

### 2.2 Corrélations de rang — le test « une stratégie déguisée en cinq »

Spearman ρ sur les rendements par trade (mêmes tokens) — mesure primaire :

| Paire | ρ | Lecture |
|---|---|---|
| V1×V6 (urgence) | **0,973** | même stratégie déguisée |
| V1×V7 (stop court) | **0,963** | même stratégie déguisée |
| V6×V7 | 0,938 | les deux « hedges » entre eux aussi |
| V1×V2 (scalp×runner) | 0,602 | liées mais distinctes (le régime de sortie compte) |
| V3×V4 (chase A×B) | 0,743 | très liées |
| V1×V5 (entrée t+1×t+2) | 0,427 | décaler l'entrée d'une barre change le profil |
| V1×V3 | 0,208 | entrées différentes = flux de rendements différents |
| V1×V4 | 0,150 | quasi-indépendantes en rang… |

…mais « quasi-indépendantes » ne veut PAS dire « diversifiées » : V1 et V4 ont
toutes deux une espérance négative et perdent sur les mêmes tokens (§2.1/F4).
**Cinq stratégies qui perdent pour des raisons corrélées (F1+F2), c'est une seule
stratégie déguisée en cinq — démontré, pas affirmé.** Les corrélations de Pearson
brutes (≈1,000 ou ≈0,004) sont laissées de côté : elles sont entièrement pilotées
par l'outlier partagé (F3).

### 2.3 Buckets — où tout perd, où ça résiste un peu

Médianes par bucket (n≥30) : 30/40 négatives. Poches à médiane positive
(**découverte**, petits n, à valider — voir H-HEDGE-6) :

| Bucket | V1 | V3 | V4 | Lecture |
|---|---|---|---|---|
| liq-Q3 | **+9,27 %** (win 56 %, n=218) | +4,60 % (n=112) | +1,78 % (n=89) | liquidité haute = moins pire |
| liq-Q4 | +3,10 % (win 61 %, n=161) | +4,05 % (n=158) | +2,77 % (n=156) | idem |
| régime calme | +11,75 % (n=92) | −5,06 % | −5,41 % | fragile (n petit, 1 seul jour « calme ») |
| régime chaud | −0,59 % (n=252) | +3,64 % (n=147) | +2,41 % (n=125) | |
| chase-calme (V3) | — | +1,64 % (n=260) | — | |
| chase-vertical (V3) | — | **−24,50 %** (n=173) | — | les verticales perdent en médiane |

Note : les buckets « régime » reposent sur 5 jours de scans (3 « inconnu », 1
« calme », 1 « chaud », **0 « frénésie »**) — lecture fragile, pas une conclusion.

---

## 3. Hedges candidats — preuves POUR et CONTRE

### H-HEDGE-1 — Sortie d'urgence : « si −8 % dans les 6 premières barres, on sort »
*(stratégie A + sortie d'urgence C)*
- POUR : 376 déclenchements ; DD 59→55 ×mise (léger).
- CONTRE : Δ espérance wins. **+0,67 % IC 95 % [−0,26 ; +1,55]** — non significatif ;
  **Δ médiane −1,29 % IC [−3,68 ; −0,18] — dégradation significative** ;
  win rate 45,2 %→43,6 % ; **3,5 % des trades gagnants de V1 auraient été coupés**
  par l'urgence (des dips qui repartent).
- **Verdict : NO ACTION.** L'urgence coupe la queue gauche ET des gagnants ; le
  bilan net est nul à négatif. Test d'invalidation : si sur données propres le
  Δ médiane redevient ≥ 0 avec IC excluant le négatif, rouvrir.

### H-HEDGE-2 — Time-stop court (3 barres vs 6) — hedge d'horizon
- POUR : Δ médiane +0,68 % IC [0,00 ; +3,02] (limite du significatif).
- CONTRE : Δ espérance wins. +0,33 % IC [−0,58 ; +1,33] — bruit ; DD quasi
  inchangé (59→57).
- **Verdict : NON CONCLUANT.** Pas de hedge démontré. Test d'invalidation :
  réplication walk-forward sur données propres avec le même Δ médiane > 0.

### H-HEDGE-3 — Entrées verticales à demi-taille (au lieu de plein ou zéro)
*(le twist H-CHASE : les verticales ont un meilleur MFE — ici on ne les jette plus,
on les sous-pondère)*
- POUR : Δ espérance wins. **+1,59 % IC [+0,11 ; +3,10]** ; Δ médiane +0,16 %
  IC [0,00 ; +0,27] ; DD 36→27 ×mise ; win rate inchangé (46,4 %).
- CONTRE : effet **minuscule** (+1,6 pp) ; **l'espérance reste négative (−4,56 %)** ;
  1 résultat marginalement significatif sur 4 hedges testés = compatible avec le
  bruit de comparaisons multiples ; les verticales perdent en médiane (−24,5 %)
  même si leur MFE est meilleur — la demi-taille adoucit sans inverser.
- **Verdict : PISTE FAIBLE, à valider sur données propres.** Ne change pas le
  signe de l'espérance : ce n'est pas un hedge, c'est un adoucisseur.
  Test d'invalidation : Δ espérance ≤ 0 sur le holdout 30 j → abandon.

### H-HEDGE-4 — Portefeuille 50/50 scalp+runner — hedge inter-token
- POUR : aucun.
- CONTRE : espérance wins. **−11,98 %** (pire que V1 −4,89 % et V2 −20,64 %
  ? non : entre les deux, mais pire que V1 seule) ; médiane **−16,66 %** ;
  DD **116 ×mise** (pire que les deux variantes seules).
- **Verdict : FALSIFIÉ comme hedge.** Démonstration chiffrée de la règle d'or :
  moyenner deux espérances négatives corrélées (ρ=0,60) ne crée pas d'asymétrie,
  ça crée un portefeuille plus mauvais que sa meilleure composante.
  Test d'invalidation : trouver une paire de variantes à espérances positives
  ET corrélation de pertes < 0,3 — inexistante ici.

### H-HEDGE-5 — Sauter les entrées les jours de « frénésie » — hedge de régime
- **Verdict : INTESTABLE.** 0 jour de frénésie sur les 5 jours de scans
  (régime « inconnu » 3 j, « calme » 1 j, « chaud » 1 j). V9 = V1 à l'identique.
  L'hypothèse reste PISTE mais il faut d'abord des semaines de régime mesuré
  (collecteur track-unbiased en cours) avant tout test.
  Test d'invalidation : quand on aura ≥ 30 trades en frénésie, comparer leur
  médiane à celle des autres régimes.

---

## 4. Architecture de portfolio — non justifiée par les données

**Il n'y a pas d'architecture de portfolio à proposer.** Les conditions minimales
pour un portfolio ne sont remplies pour aucune paire :
1. au moins une composante à espérance robuste ≥ 0 → **aucune** ;
2. une asymétrie (quand l'une perd, l'autre amortit) → **inexistante** (§2.1/F4) ;
3. une décorrélation des pertes → les « hedges » mécaniques sont la même
   stratégie (ρ > 0,96), les autres perdent ensemble.

Le seul « hedge » démontré par cette analyse, c'est **ne pas trader**
(espérance 0 > espérance −5 %), réduire la taille, ou — piste à valider —
**filtrer sur la liquidité** (H-HEDGE-6 ci-dessous). Tout le reste serait du
storytelling.

---

## 5. Nouvelles hypothèses (phase DÉCOUVERTE — à pré-enregistrer avant test)

| ID | Prédiction | Falsificateur | État |
|---|---|---|---|
| H-HEDGE-1 | Sortie d'urgence −8 %/6b améliore le scalp | Δ médiane ≥ 0 sur holdout | NO ACTION (découverte) |
| H-HEDGE-2 | Time-stop 3b > 6b | Δ espérance ≤ 0 sur holdout | NON CONCLUANT |
| H-HEDGE-3 | Verticales à demi-taille > plein | Δ espérance ≤ 0 sur holdout | PISTE FAIBLE |
| H-HEDGE-4 | Portfolio scalp+runner > scalp seul | — | FALSIFIÉ (découverte) |
| H-HEDGE-5 | Skip frénésie améliore | médiane frénésie ≥ autres régimes | INTESTABLE (données) |
| H-HEDGE-6 | Entrées liq ≥ Q3 → médiane > 0 | médiane ≤ 0 sur holdout 30 j, n≥30 | **PISTE** (découverte) |

H-HEDGE-6 vient des buckets §2.3 (médianes +9,27 % / +3,10 % en liq-Q3/Q4 pour
V1, win rates 56–61 %). **Avertissement snooping :** les quartiles sont calculés
sur ces mêmes données — le seuil doit être re-dérivé sur données propres AVANT
tout test, via la batterie pré-enregistrée (amendement, pas de modification de
la batterie gelée).

---

## 6. Ce qui pourrait invalider cette analyse

1. **Données.** Tout repose sur `data/history/` (biaisée, 5 jours, 1 tick
   aberrant majeur documenté). Sur 30 jours de données propres, les espérances,
   les corrélations et les buckets peuvent changer de signe.
2. **Winsorisation.** Le cap p99 (+272,5 %) est un choix de robustesse, pas une
   vérité : un cap différent déplace les espérances winsorisées (les médianes,
   elles, n'en dépendent pas — et elles sont négatives aussi).
3. **Frais.** À 1,3 % l'espérance est déjà négative ; des frais réels plus élevés
   (prioritization fees, échecs — red-team §2.3) ne feraient qu'empirer.
4. **Comparaisons multiples.** ~10 familles déjà testées sur cette fenêtre + 4
   hedges ici : le seul signal marginal (H-HEDGE-3) peut être du bruit.
5. **Régimes.** 5 jours de scans : l'analyse par régime est quasi-vide
   (H-HEDGE-5 intestable). Un mois de régimes mesurés pourrait révéler une
   asymétrie temporelle réelle.

**Protocole de validation honnête :** geler H-HEDGE-3 et H-HEDGE-6 comme
amendements pré-enregistrés, les tester sur les 30 jours de `data/track-unbiased/`
une fois collectés, publier les résultats quels qu'ils soient.

---

*Analyse réalisée le 2026-09-28. Le verdict « aucun hedge identifié » est un
résultat, pas un échec : il a coûté 0 $ et quelques heures de calcul, et il
empêche de payer pour apprendre la même chose en live.*
