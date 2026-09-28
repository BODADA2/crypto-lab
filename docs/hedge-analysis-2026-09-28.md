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

---

## 7. Extension — stratégie de référence, score composite et H-HEDGE-EXPOSURE

**Code :** `lab/backtest/run-hedge-exposure.ts` (+ `tests/hedge-exposure.test.ts`,
21 tests verts). Phase DÉCOUVERTE, mêmes données biaisées, holdout jamais touché.

### 7.1 H-REF-MOM — stratégie de référence « regime-filtered momentum » (V10)

**Construction.** Entrées momentum pures : première barre idx≥3 avec
`chase ≥ 0,5` (entrées « verticales » — MFE médian x1,25 vs x1,20 d'après
H-CHASE), filtrées par l'indicateur de régime de volume par chaîne
(`lab/collect/chainregime.ts`) : exclusion **pré-hoc** (sémantique du module,
pas fittée aux données) des régimes extrêmes `famine` (marché mort) et
`frénésie` (bruit maximal). Sorties : scalp H-EXIT (comparabilité avec V1–V9).

**Résultat.** Le filtre de régime n'exclut **rien** : 0 jour `famine`, 0 jour
`frénésie` sur les 5 jours de scans (3 `inconnu`, 1 `calme`, 1 `chaud`).
V10 = momentum vertical pur, n=238 (138 `inconnu`, 35 `calme`, 65 `chaud`).
**La composante « regime » est donc intestable sur cette fenêtre** — constat
enregistré, pas contourné.

| Mesure | V10 (H-REF-MOM) | V3 (chase mixte, réf.) |
|---|---|---|
| n | 238 | 491 |
| Esp. wins. IC 95 % | **−9,79 %** [−17,32 ; −2,11] | −6,15 % |
| Médiane | −23,24 % | −1,17 % |
| Win rate | 37,8 % | 46,4 % |
| DD | 24,2 ×mise | 35,6 ×mise |

**Verdict :** le momentum pur sous-performe nettement le chase mixte. Les
verticales ont un meilleur MFE (x1,25) mais entrent plus haut — le net est pire
(médiane −23 % vs −1 %). « Acheter la verticale » n'est pas le désastre annoncé
par la vidéo TikTok, mais ce n'est pas non plus un edge : c'est une entrée plus
tardive sur les mêmes tokens qui saignent. H-REF-MOM reste en DÉCOUVERTE comme
**référence** (point de comparaison), pas comme candidate.

### 7.2 Score composite — définition explicite et tableau V1–V10

**Formule (documentée) :**
```
S = (E_w − λ_DD·DD − λ_σ·σ) × P_oos
E_w   : espérance winsorisée au p99 (mise = 1)
DD    : drawdown max additif sur rendements winsorisés, en unités de mise
        (même définition que summarizeVariant)
σ     : écart-type des rendements winsorisés par trade
λ_DD = 0,001, λ_σ = 0,05 — choix d'échelle de la phase découverte
P_oos = 1/(1+I), I = |S_is − S_oos| / (|S_is| + |S_oos| + 0,01)
```
Walk-forward : 60 % premiers trades (ordre chronologique d'entrée) = IS,
40 % derniers = OOS. **Proxy faible** (même fenêtre biaisée de 5 jours) — le
vrai OOS est le holdout 30 j.

**Pourquoi une forme additive et pas un ratio** (ex. E_w/(DD·σ)) : avec
E_w < 0, diviser par le risque **inverse la préférence** — plus de drawdown
donnerait un score « meilleur » (moins négatif). Ici, le risque dégrade
toujours le score, quel que soit le signe de E_w.

**Règle de veto (sélection) :** un score n'est actionnable que si
**PF_w ≥ 1 ET médiane ≥ 0**. Sinon → NO_TRADE, quel que soit le rang.
Le score sert à **classer**, le veto sert à **décider**.

| Rang | Variante | S | E_w | DD (×mise) | σ | PF_w | Méd. | I (WF) | Actionnable |
|---|---|---|---|---|---|---|---|---|---|
| 1 | V8 vert-half | −0,0796 | −4,56 % | 27,0 | 0,42 | 0,72 | −1,02 % | 0,18 | NON |
| 2 | V6 urgence | −0,0910 | −4,22 % | 54,7 | 0,66 | 0,84 | −3,30 % | 0,43 | NON |
| 3 | V7 stop court | −0,0919 | −4,56 % | 56,6 | 0,66 | 0,82 | −1,34 % | 0,47 | NON |
| 4 | V1 scalp | −0,0986 | −4,89 % | 59,0 | 0,68 | 0,82 | −2,02 % | 0,44 | NON |
| 5 | V3 chase-A | −0,1067 | −6,15 % | 35,6 | 0,51 | 0,71 | −1,17 % | 0,15 | NON |
| 6 | V4 chase-B | −0,1099 | −7,65 % | 36,6 | 0,49 | 0,62 | −1,29 % | 0,25 | NON |
| 7 | V5 retardée | −0,1218 | −5,26 % | 46,4 | 0,64 | 0,79 | −2,16 % | 0,07 | NON |
| 8 | **V10 ref-mom** | −0,1483 | −9,79 % | 24,2 | 0,58 | 0,66 | −23,24 % | 0,02 | NON |
| 9 | V2 runner | −0,4093 | −20,64 % | 185,4 | 0,78 | 0,50 | −35,76 % | 0,05 | NON |

(V9 = V1 à l'identique, non reprise.) **Toutes les variantes sont vetées :
aucune n'est actionnable.** Le ranking ne sert qu'à ordonner les « moins pires ».
À noter : V6/V7/V1 ont une instabilité walk-forward élevée (I ≈ 0,43–0,47 —
l'effet urgence/stop varie selon la moitié de fenêtre) ; V10 est stable
(I = 0,02) mais **stablement mauvais**.

### 7.3 H-HEDGE-EXPOSURE — le disjoncteur d'exposition

**Hypothèse :** « Le meilleur hedge d'une stratégie memecoin n'est pas
nécessairement une position opposée ; c'est un mécanisme qui détecte
suffisamment tôt quand il faut réduire ou supprimer l'exposition. »

**Mécanisme (paramètres PRÉ-ENGAGÉS avant tout résultat — nombres ronds,
principe : ~1/2 journée de trades).** Séquence temporelle **tradable** : à
chaque candidat, la fenêtre ne contient que les trades **complétés**
(`exitAt ≤ entryAt` du candidat).
- Fenêtre glissante K = 30 derniers trades complétés (min. 10 pour décider).
- **Suspension** si `winRate(fenêtre) < 35 %` ET `médiane(fenêtre) < 0`.
- **Reprise** si `médiane(fenêtre) > 0` (hystérèse anti-yoyo).
- Modes : `halt` (exposition 0 — on saute l'entrée) et `halve` (exposition ×0,5).

**Résultats — paramètres primaires :**

| Base | Mode | E_w | DD (×mise) | PF_w | S | Skippés | Susp. |
|---|---|---|---|---|---|---|---|
| V1 | — (sans) | −4,89 % | 59,0 | 0,82 | −0,0986 | — | — |
| V1 | halt | **−2,47 %** | **30,0** | 0,91 | −0,0508 | 364/818 | 4 |
| V1 | halve | −3,03 % | 43,7 | 0,86 | −0,0750 | 0 | 4 |
| V10 | — (sans) | −9,79 % | 24,2 | 0,66 | −0,1483 | — | — |
| V10 | halt | **−16,02 %** (pire) | 13,9 | 0,54 | −0,1702 | 157/238 | 2 |
| V10 | halve | −7,05 % | 17,7 | 0,65 | — | 0 | 2 |

**Coût des faux positifs (inclus, pas caché).** V1+halt : 152 gagnants ratés
pendant les suspensions (+7 025 % bruts manqués) contre 212 pertes évitées
(+9 749 % bruts) — le bilan est favorable mais le coût est réel et mesuré.
V10+halt : 60 gagnants ratés dont **le trade outlier à +4 939 704 %**
(+4 942 502 % manqués !) — le disjoncteur a « correctement » coupé l'exposition
pendant une phase dégradée et a raté le seul trade qui faisait les chiffres.
**Leçon : sur une stratégie dont l'espérance dépend d'outliers rares, couper
l'exposition coupe aussi les outliers.** Le mécanisme réduit le risque, il ne
sait pas distinguer « dégradation » de « calme avant l'outlier ».

**Délai de détection vs début des drawdowns** (mesure honnête : état de
suspension enregistré à chaque index, « déjà suspendu » distingué des nouveaux
déclenchements) :
- V1 : 7 épisodes de DD, **3/7 détectés** (1 déjà suspendu, **4 non détectés**),
  délai médian des nouveaux déclenchements : **38 trades — LENT**.
- V10 : 3/3 détectés (2 déjà suspendus), délai du nouveau déclenchement : 13 trades.

**Sensibilité (contrôle de robustesse — jamais pour sélectionner).**
K ∈ {15, 30, 60} × seuil ∈ {30 %, 35 %, 40 %} : sur V1, les 9 combinaisons
améliorent E_w (−1,54 % à −4,04 % vs −4,89 %) et réduisent le DD (25 à 39 vs 59)
— direction cohérente, pas un point isolé. Sur V10, le DD chute toujours mais
E_w reste négative (−9,55 % à −16,28 %) : le mécanisme coupe le risque sans
créer d'espérance.

**Verdict H-HEDGE-EXPOSURE : PISTE (phase DÉCOUVERTE).** C'est un **réducteur
de risque**, pas un créateur d'edge : détection lente (38 trades, 4/7 épisodes
manqués sur V1), expectancy toujours négative et vetée, effet destructeur sur
les stratégies à outliers. Le seul apport démontré : diviser le drawdown par ~2
sur V1 au prix de 44 % de trades skippés et de 152 gagnants ratés. À valider
sur le holdout 30 j avec le protocole pré-enregistré.

### 7.4 Seconde stratégie : décorrélation MESURÉE, jamais supposée

**Méthode.** Paires candidates sur mints communs, ordre chronologique :
Spearman **roulant** (fenêtre 50 trades, pas 10) des P&L par trade, des séries
de drawdown, et **sous stress** (fenêtres où le DD de A dépasse sa médiane —
c'est là que la diversification doit payer).

| Paire | n | P&L roulant (moy/min/max) | DD roulant (moy) | Sous stress |
|---|---|---|---|---|
| V10×V4 | 168 | 0,06 / −0,12 / 0,17 | 0,31 | **0,06** |
| V1×V4 | 421 | 0,16 / −0,13 / 0,51 | 0,20 | 0,19 |
| V10×V1 | 238 | 0,20 / −0,04 / 0,48 | 0,07 | 0,18 |
| V3×V4 | 421 | 0,72 / 0,50 / 0,94 | 0,63 | 0,74 |

**Constats.** (1) V10×V4 est la paire la plus décorrélée **mesurée**
(stress ρ = 0,06, max 0,17 sur 12 fenêtres). (2) Les corrélations roulantes des
**drawdowns sont instables** (min −0,60 à max 0,99 selon les paires) : la
corrélation des drawdowns n'est pas stationnaire — un chiffre « global » ne
veut rien dire. (3) V3×V4 (ρ = 0,74) confirme : deux variantes de la même
famille ne diversifient rien.

**Portefeuille 50/50 — paire choisie sur la décorrélation mesurée
(V10×V4, stress ρ = 0,06), jamais sur le résultat final :**
n = 168 mints communs, **S = −0,0357** (vs −0,1483 / −0,1099 pour les
composantes — meilleur que chacune), E_w = −1,23 %, DD = 4,54 ×mise,
PF_w = 0,93, médiane −3,35 %, P_oos = 0,85. **NON actionnable** (vetos PF_w et
médiane).

**Caveat majeur (biais de sélection interne) :** le portefeuille est calculé
sur les **168 mints communs** aux deux stratégies — un sous-univers sélectionné
*par* les stratégies elles-mêmes. L'amélioration (E_w −1,23 % vs −7,65 %/−9,79 %)
vient en partie de cette intersection (les pires trades idiosyncratiques de
chacune sont exclus), pas seulement de la décorrélation. Sur données propres,
les univers devront être définis **ex-ante**.

**Verdict : aucune seconde stratégie justifiée.** Le portefeuille décorréleré
améliore le score mais reste veté ; l'effet est en partie un artefact
d'intersection. La **machinerie de mesure** (corrélations roulantes P&L/DD +
stress) est en place et sera appliquée au holdout 30 j, où la granularité
journalière deviendra enfin mesurable (5 jours = trop peu pour du roulant
journalier).

### 7.5 Tests d'invalidation de l'extension

- **H-REF-MOM :** si sur le holdout 30 j l'espérance winsorisée devient ≥ 0
  avec médiane ≥ 0 et n ≥ 30 → rouvrir comme candidate (sinon elle reste une
  référence).
- **Score composite :** si changer λ_DD/λ_σ dans un facteur 10 modifie le
  ranking qualitatif (hors V2, toujours dernière), le ranking n'est pas robuste
  → le documenter comme sensible, pas comme un ordre établi.
- **H-HEDGE-EXPOSURE :** ΔE_w ≤ 0 sur le holdout, OU délai médian de détection
  supérieur à la durée médiane des épisodes de DD, OU E_w protégée toujours
  vetée → abandon du mécanisme sous sa forme actuelle. Variante à tester :
  reprise plus rapide (seuil de reprise à challenger).
- **Portefeuille décorrélé :** si sur le holdout la paire la plus décorrélée
  (mesurée) ne bat plus ses composantes au score composite → l'effet
  intersection de la découverte était du snooping → abandon.

### 7.6 Ce qui pourrait invalider cette extension

1. **5 jours de données :** walk-forward 60/40, corrélations roulantes et
   sensibilité du disjoncteur sont des proxys faibles sur une seule semaine
   biaisée.
2. **Le filtre de régime n'a rien filtré** (0 jour famine/frénésie) : la
   composante « regime » de H-REF-MOM est une coquille vide ici — il faudra des
   semaines de régime mesuré pour la tester vraiment.
3. **λ_DD, λ_σ** sont des choix d'échelle de la phase découverte, pas des
   constantes.
4. **Intersection des mints** dans le portefeuille = sélection interne
   (cf. §7.4).
5. **Tradabilité du disjoncteur :** `exitAt` vient des observations (≈ toutes
   les 15 min ?) ; en live, un trade met 6 barres à se compléter — le délai
   réel de détection serait plus long que les 38 trades mesurés.
6. **Comparaisons multiples :** 18 familles sur la même fenêtre (attendre
   ~0,9 faux positif à 5 %). Le signal « disjoncteur » (direction cohérente
   sur 9 combinaisons) résiste mieux qu'un point isolé, mais n'est pas une
   preuve.
