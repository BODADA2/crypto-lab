# Insider economics — wallets, bundles, fee flows (2026-09-28)

**Vague « insider economics »** : creuser les pistes wallets après le constat que les futurs
migrés sont indiscernables au create (28,43 vs 28,42 SOL, n=41k) et que la migration tombe en
médiane à 3 minutes. Si un edge existe, il est probablement du côté de *qui* lance et *qui*
achète en premier — pas du *quoi*.

**Règles** : aucun push, aucune transaction, holdout `data/track-unbiased/` intact. Données
`data/scans/pump-2026-09-24..28.jsonl` (biaisées : sélection de tokens chauds — toute mesure
reste une borne optimiste, étiquetée comme telle).

---

## 1. H-DEV face + : le registre des devs — TESTÉE

**Protocole.** 68 466 creates → exclusion des 621 late-discovery recalculés
(`vSolInBondingCurve ≥ 85`, 0,91 % — retombe sur l'audit) → **65 941 creates genuine**,
21 660 wallets développeurs (`traderPublicKey`). 1 904 doublons de mint ignorés (premier vu
conservé). Attribution de graduation : le mint migré doit avoir été vu en create genuine avec
ce wallet (les événements `migrate` ne portent pas de clé). Fenêtre 24–28 sept. 2026.

**Taux de base : 930 / 65 941 = 1,41 %**, IC 95 % [1,32 – 1,50].

### 1.1 Le paradoxe : les one-shots « gagnent », les répétés non

| Groupe | Wallets | Creates | Graduations | Taux | IC 95 % |
|---|---|---|---|---|---|
| Base (tous) | 21 660 | 65 941 | 930 | **1,41 %** | [1,32 – 1,50] |
| One-shot (1 create) | 16 099 | 16 099 | 429 | **2,67 %** | [2,43 – 2,93] |
| ≥ 2 creates | 5 561 | 49 842 | 501 | 1,01 % | [0,92 – 1,10] |
| ≥ 3 creates | 3 278 | 45 276 | 451 | 1,00 % | [0,91 – 1,09] |
| ≥ 5 creates | 1 917 | 40 675 | 402 | 0,99 % | [0,90 – 1,09] |
| ≥ 10 creates | 943 | 34 350 | 333 | 0,97 % | [0,87 – 1,08] |

La lecture naïve de Deku (« suis les devs répétés ») est **inversée** dans ces données :
la répétition seule ne prédit rien — elle prédit même *moins* que la base. Explication la plus
probable : **les wallets ne sont pas des humains**. Les gagnants ont intérêt à tourner leurs
wallets (chaque graduation d'un opérateur sérieux apparaît comme un « one-shot » à 100 %),
tandis que les factories à spam (max : 752 creates pour un wallet) tirent la moyenne des
répétés vers le bas. Le registre mesure des wallets, proxy bruité de l'humain derrière.

### 1.2 Mais il existe de vrais bons wallets

Top wallets par graduations (clés tronquées) :

| Wallet | Creates | Graduations | Taux | Fenêtre d'activité |
|---|---|---|---|---|
| 9sHpTfmVpC… | 78 | 19 | **24,4 %** | 78 h (24→28 sept.) |
| 56XVRVAsgW… | 44 | 15 | **34,1 %** | 75 h |
| BTUTSZiiGR… | 73 | 11 | 15,1 % | 53 h |
| 9aztChMYbs… | 107 | 10 | 9,3 % | 64 h |
| E4FPggw9yD… | 209 | 9 | 4,3 % | 77 h |
| HuAvVCTbwj… | 36 | 8 | 22,2 % | — |
| EkUmCLjRS8… | 30 | 7 | 23,3 % | — |
| 5RT3pEAJgn… | 9 | 7 | 77,8 % | — |

Les 20 meilleurs wallets captent **15,3 % des 930 graduations**. Leurs creates s'étalent sur
52–78 h : ce n'est pas un batch chanceux d'une heure, ce sont des opérations actives pendant
des jours à des taux 10–25× la base. Même avec correction de Bonferroni sur 21 660 wallets,
19/78 à p=1,41 % reste hautement significatif. **Ce sont de vrais outliers** — reste à savoir
s'ils sont exploitables (voir §1.3 et limites).

### 1.3 Persistance temporelle : le taux passé prédit (faiblement) le taux futur

Split à 2026-09-26T00:00Z. H1 : 17 651 creates, base 1,48 %. H2 : 48 290 creates, base 1,38 %.

| Sélection (sur H1) | Creates H2 | Graduations H2 | Taux H2 | IC 95 % |
|---|---|---|---|---|
| Base H2 | 48 290 | 668 | 1,38 % | — |
| Devs ≥ 3 creates en H1 (n=555 wallets) | 13 671 | 152 | 1,11 % | [0,95 – 1,30] |
| Devs « hot » H1 : taux > base H1, ≥ 3 creates (n=50) | 1 577 | 41 | **2,60 %** | [1,92 – 3,51] |

- La répétition seule (≥3 creates en H1) donne 1,11 % < 1,38 % : **pas de signal**.
- Le *taux passé* élevé donne 2,60 %, lift ×1,9, IC excluant la base : **signal réel mais modeste**.
- Corrélation des rangs (Spearman, correction des ex-aequo, n=431 wallets avec ≥3 creates
  dans chaque moitié) : **ρ = 0,286, p < 10⁻⁶** ; Pearson 0,273. Persistance faible mais
  hautement significative. (Note d'honnêteté : un premier calcul naïf sans correction des
  ex-aequo donnait ρ=0,68 — gonflé par les masses d'ex-aequo à 0. Le chiffre retenu est le
  corrigé.)

### 1.4 Verdict H-DEV face + : **NON CONCLUANTE** (signal exploratoire)

| Pour | Contre |
|---|---|
| Taux passés persistants (ρ≈0,29, p<10⁻⁶) | Sélection des « hot » **post-hoc** — pas pré-enregistrée |
| Hot-devs : ×1,9 sur H2, IC excluant la base | Wallets ≠ humains (rotation des gagnants, spam des factories) |
| Outliers à 15–34 % sur 44–209 creates, étalés sur des jours | Prédit la *migration* (1,4 %→2,6 %), pas le P&L — et seuls ~8 % des migrés font ×2 |
| | Censure à droite (dernières heures de H2), zone grise 80–85 SOL, pool bonk aveugle (2 981 creates) |

La leçon Deku doit être reformulée : ce ne sont pas « les devs répétés » qui comptent, c'est
**le taux de graduation passé du wallet** — et même là, l'effet est modeste et le proxy est
bruité. Test pré-enregistré proposé : **T-SERIAL-HOT** (addendum).

---

## 2. H-BUNDLE : filtre d'exclusion par bundling — DONNÉES INSUFFISANTES

**Faisabilité d'abord.** Granularité wallet des premiers achats dans les données existantes :
**1 seul token** (`data/earlybuyers/5QK1qDJ3….json`, ~50 acheteurs avec wallet, signature,
blockTime, slot, rang, montant). `data/wallets/` est vide. Les snapshots DexScreener donnent
`top10Pct` mais pas la liste des wallets. **Verdict : DONNÉES INSUFFISANTES — test impossible
(n=1).**

**Le mécanisme de collecte existe** (`lab/signals/run-earlybuyers.ts` + `lab/collect/helius.ts`
`getEarlyBuyers(mint, n=50)` : remonte les signatures du mint jusqu'aux plus anciennes,
~200 lectures de transactions par token). Dernier run : 2026-09-25. Crédits Helius consommés
en septembre : 17 731 / ~1 000 000 gratuits — **large marge**.

### Spécification de collecte (proposition, non implémentée sans validation)

1. **Cible** : les tokens *migrés* (là où le filtre d'exclusion s'appliquerait : ne pas acheter
   un bundle qui va dumper). Job quotidien existant `run-earlybuyers.ts --tokens 20`
   → l'étendre à 30–50 tokens/jour, en commençant par les migrés récents.
2. **Budget** : ~210 crédits/token → 50 tokens/jour ≈ 10 500/jour ≈ 315 k/mois < 1 M. OK.
3. **Métriques pré-définies** (calculées par token, sur les 50 premiers acheteurs) :
   - `top5_share` = part des 50 premiers achats captée par les 5 plus gros wallets ;
   - `gini` des montants d'achat ; `same_slot_max` = max d'achats dans le même slot / 50 ;
   - `coordinated_sells` = part des early buyers vendant >50 % dans la même fenêtre de
     5 min post-migration (nécessite l'historique wallet — `getWalletTokenHistory` existe).
4. **Règle candidate** (à tester, pas à appliquer) : `top5_share ≥ 40 %` → exclusion.
5. **Stockage** : `data/earlybuyers/<mint>.json` (déjà le format), jamais mélangé au reste.

Test pré-enregistré proposé : **T-BUNDLE** (addendum, *gated* à la collecte : ne peut tourner
qu'une fois N≥100 tokens migrés avec early buyers collectés).

---

## 3. H-FEEFLOW : les creator fees comme trace — DONNÉES INSUFFISANTES (mécanisme)

**Aucune donnée de frais créateur** n'existe dans le repo (recherche exhaustive : rien dans
`lab/collect/`, `data/`). Le mécanisme « le dev encaisse ses fees puis relance » n'est donc
**pas observable** aujourd'hui. Verdict mécanisme : **DONNÉES INSUFFISANTES**.

### Proxy comportemental testé : la relance post-graduation

Question : après une graduation, le même wallet relance-t-il différemment ?
Protocole strict (observable au moment de la décision) : la migration du token précédent doit
être *antérieure* au create suivant.

**Résultat : 835 / 1 350 = 61,85 %** [59,2 – 64,4] de graduation après une graduation observée,
contre 1,62 % sinon. **Ce chiffre est un artefact de concentration, pas un signal** :
- 226 wallets contribuent, mais **les 2 premiers fournissent 955 des 1 350 paires (71 %)** —
  ce sont exactement les 2 outliers du §1.2 (9sHpTfmVpC…, 56XVRVAsgW…, 24–34 % de taux).
- Gap médian prev-create → next-create : **5,4 minutes**. Ils lancent en rafale continue.
- Interprétation honnête : autocorrélation d'un processus à haut taux, pas de pattern
  « encaisse puis relance ». Les 224 autres wallets : 395 paires, sans conclusion.

**Verdict proxy : CONFOUNDU, non interprétable.** La question du *timing* de relance après
graduation (médiane inter-create globale : 0,1 h — tout le monde relance vite) ne montre rien
de distinctif une fois les 2 dominants écartés.

### Spécification de collecte du mécanisme (proposition)

1. Pour chaque create genuine, la transaction de création (Helius `getTransaction` sur la
   signature du create) contient le **bénéficiaire des creator fees** (= le wallet créateur).
2. Suivre les retraits de fees : `getWalletTokenHistory` / balance changes du wallet créateur
   → événements « withdraw ».
3. Pattern à tester : `withdraw < 24 h avant un nouveau create du même wallet` → le token
   suivant gradue-t-il différemment ?
4. Coût : ~1–2 lectures de transactions par create + historique wallet — à chiffrer sur un
   pilote de 100 wallets avant généralisation.

Test pré-enregistré proposé : **T-FEEFLOW** (addendum, *gated* à la collecte).

---

## 4. Synthèse des verdicts

| Piste | n | Verdict | Suite |
|---|---|---|---|
| H-DEV face + (registre, taux passé) | 65 941 creates genuine, 21 660 wallets | **NON CONCLUANTE** — signal exploratoire réel (ρ≈0,29 ; hot ×1,9) mais modeste, post-hoc, wallets≠humains | T-SERIAL-HOT pré-enregistré |
| H-DEV (répétition seule) | idem | **FALSIFIÉE** comme formulée (1,11 % < 1,38 %) | — |
| H-BUNDLE (exclusion) | 1 token | **DONNÉES INSUFFISANTES** | Spec + T-BUNDLE gated |
| H-FEEFLOW (mécanisme fees) | 0 | **DONNÉES INSUFFISANTES** | Spec + T-FEEFLOW gated |
| H-FEEFLOW (proxy relance) | 1 350 paires strictes | **CONFOUNDU** (2 wallets = 71 %) | — |

**Leçon transversale** : les deux résultats les plus spectaculaires de la vague (61,85 % de
« relance post-graduation », ρ=0,68 naïf) se sont effondrés ou réduits à l'examen
(concentration sur 2 wallets ; ex-aequo non corrigés). C'est exactement le travail que la
discipline du labo exige : *vérifier avant de croire, surtout quand le chiffre est beau.*

---

## 5. Limites et honnêteté

- Données 24–28 sept. uniquement, biaisées (tokens chauds sur-représentés) : tous les taux
  sont des bornes optimistes.
- **Wallets jetables** : la rotation des gagnants est la limite n°1 du registre. Un humain
  habile avec 10 wallets apparaît comme 10 one-shots à 100 %.
- Zone grise 80–85 SOL (conservateur), pool bonk aveugle (2 981 creates sans vSol).
- Censure à droite : les creates des dernières heures de la fenêtre n'ont pas eu le temps
  de migrer (biais faible : médiane create→migrate = 3 min).
- Les seuils « hot » et les découpes H1/H2 ont été choisis après avoir vu les données :
  tout ce qui précède est **exploratoire**. La confirmation appartient aux données propres.
