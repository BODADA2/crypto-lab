# Backlog — les 100 prochaines expériences du Crypto Lab

**Date :** 2026-09-28 · **Mission :** backlog §29 (directeur R&D) · **Statut :** document seul — AUCUN code, AUCUN push.

## Question centrale

« La structure des premiers flux à t0 contient-elle une information stable sur la
distribution future (rendement, drawdown, graduation, survie) ? »

## Garde-fous intangibles (rappel §1 état des lieux)

- **Verdicts gelés — ne pas rouvrir :** momentum/scalp (ABANDONNÉ), hedge actif
  (NO_TRADE), devBuy ≥ 1,3 SOL (FALSIFIÉE), filtre combiné (ABANDONNÉ), second
  filtre (ABANDONNÉ), H-NARR v2 / H-EXIT / H-CHASE / H-CALLTRACK / H-TOOL
  (NO ACTION / NON CONCLUANT / FALSIFIÉE / NON ACTIONNABLE), H-CURVE v1/v2
  (NON CONCLUANT / REDONDANT), H-DECOMP (NO EVIDENCE OF EDGE — famille
  momentum/scalp officiellement abandonnée).
- **Anti-leakage absolu :** toute feature a `feature_timestamp ≤ t0`. Les
  observations post-t0 ne servent que de LABELS, jamais de features.
- **Pas de deep learning.** Pas de « smart money » défini sur le futur :
  tout historique wallet n'utilise que des observations ≤ t0.
- **Holdout gelé** (`data/track-unbiased/`) : jamais lu en découverte ; réservé
  à la batterie pré-enregistrée.
- **3 états de décision :** NO EVIDENCE / RISK FILTER (filtre d'exclusion) /
  candidate positive predictive relation (jamais « edge garanti »).
- **Kill switch (§16) :** chaque expérience ci-dessous porte son falsificateur
  explicite — s'il se déclenche, l'hypothèse est tuée, pas ajustée.

## Non-duplication vs registre

Déjà inscrites au registre et candidates à la batterie pré-enregistrée (non
reprises ici) : H-PRED-WAL-01 à 09, H-PRED-FLOW/LIQ/TEMP/DIST, deep-edges
E6–E12 (H-CONC, H-TIME, H-LIQMIRAGE, H-HALFLIFE, H-SERIAL, H-MAGNET, H-COPYCAT),
H-BUNDLE (spec, test T-BUNDLE gaté), H-FEEFLOW (spec), H-EXTRACT, H-SNIPER,
H-DEV (face +), H-EARLY (blueprint). Quand une question ci-dessous en étend une
avec une opérationnalisation différente, la distinction est notée.

## Données — état au 28/09

| Source | État | Biais / limites |
|---|---|---|
| `data/history/` (2 926 séries) | ✅ dispo | biais tokens chauds → borne OPTIMISTE (~12 pts médiane) |
| `data/scans/` (352 fichiers, ~68k creates / 2 223 migrates) | ✅ dispo | genuine ≈ 65 941 creates après exclusion late-discovery |
| `data/earlybuyers/` (~35 fichiers) | 🔶 partiel | backfill en cours (agent dédié) ; 5 fichiers `truncated` inutilisables |
| `data/earlybuyers/wallet-histories/` | 🔶 partiel | en remplissage ; fenêtre 1 000 signatures (wallets très actifs sous-échantillonnés) |
| `data/fastlane/` | 🔶 runs bornés | creates live, p50 détection ~140 ms ; firehose brut exclu (coût) |
| `data/track-unbiased/` | 🔒 GELÉ | holdout — jamais lu |
| `data-snipe/` (226), `data/mintinfo/` (850), `data-calls/` (122) | ✅ dispo | volumes limités |

**Légende des entrées :** chaque expérience porte famille, question falsifiable,
données nécessaires (✅ déjà dispo / 🔶 partiel / ❌ à collecter), falsificateur
(kill switch), gain d'information /5 (5 = tranche une question centrale à coût
faible). Protocole par défaut : discovery/calibration (hash 50/25), n≥30,
Spearman + permutation + IC bootstrap, déciles, stabilité par cohorte — sauf
mention contraire.

---

## Famille A — Early buyers (composition du set pré-t0)

### 001 · [A] Entité vs wallet : le clustering change-t-il le verdict concentration → survie ?
- **Question :** le coefficient concentration→Y@6h calculé sur entités
  clusterisées (niveaux `same_slot` / `temporal_sync` / `persistent_cooccurrence`)
  diffère-t-il significativement (signe ou magnitude) de celui calculé sur
  wallets bruts ? (Étend H-PRED-WAL-02/03 qui utilisent des adresses brutes ;
  répond à Liu et al. 2025 et spec §4.)
- **Données :** 🔶 `earlybuyers/` + `wallet-histories/` ; module `clusters.ts` à construire.
- **Falsificateur :** corrélation concentration_entité vs concentration_wallet
  ≥ 0,95 ET mêmes verdicts → le clustering n'apporte rien, on garde le brut.
- **Gain :** 5/5 — clé de voûte : tout l'aval (concentration, coordination,
  bundle) dépend de l'unité d'analyse.

### 002 · [A] Ancienneté des early buyers → survie ?
- **Question :** la médiane de l'âge on-chain des early buyers (première
  signature antérieure à t0) prédit-elle la survie à 24h ?
- **Données :** 🔶 `wallet-histories/` (première signature ; à compléter).
- **Falsificateur :** ρ de Spearman ≈ 0 sur discovery+calibration, p > 0,2.
- **Gain :** 4/5.

### 003 · [A] Wallets à historique positif pré-t0 → graduation ?
- **Question :** la fraction d'early buyers ayant un historique positif
  (présents tôt sur ≥1 token gradué AVANT t0 — passé seul, jamais le futur)
  prédit-elle la graduation à 7j ? (Niveau token, vs H-EARLY du blueprint qui
  est un prédicteur au niveau wallet.)
- **Données :** 🔶 `wallet-histories/` + `scans/` (gradués antérieurs à t0).
- **Falsificateur :** taux de graduation identique entre terciles haut/bas
  (IC 95 % recouvrants).
- **Gain :** 4/5.

### 004 · [A] Diversité des financeurs → survie ?
- **Question :** un set d'early buyers financé par peu de sources distinctes
  (fan-in : peu de fundeurs uniques) a-t-il une survie plus faible
  (DD80 plus fréquent) ?
- **Données :** ❌ à collecter — deltas SOL de funding absents du cache actuel
  (extension du cache nécessaire, cf. état des lieux §8 HORS SCOPE).
- **Falsificateur :** DD80 indépendant du nombre de financeurs distincts.
- **Gain :** 3/5 — coût de collecte élevé, question structurelle forte.

### 005 · [A] Arrivée « grumeleuse » vs lisse → survie ?
- **Question :** le coefficient de variation des intervalles inter-arrivées des
  wallets (rafales vs flux régulier) prédit-il le DD80 ? (Distinct de
  H-PRED-WAL-05 « vitesse d'arrivée » : ici la FORME, pas le niveau.)
- **Données :** 🔶 `earlybuyers/` (timestamps disponibles).
- **Falsificateur :** pas de relation CV → DD80 sur n≥30.
- **Gain :** 3/5.

### 006 · [A] Cardinalité du set → graduation, à SOL locké égal ?
- **Question :** le nombre d'early buyers distincts prédit-il la graduation
  (label binaire on-chain) après contrôle du SOL locké à t0 ?
- **Données :** 🔶 `earlybuyers/` + `scans/`.
- **Falsificateur :** AUROC ≈ 0,5 après contrôle.
- **Gain :** 3/5.

### 007 · [A] Quelle définition de fenêtre donne le signal le plus stable ?
- **Question :** les relations features→Y sont-elles stables entre définitions
  `pre_t0_set` / `first_block` / `first_5_slots` / `first_60s` / `first_300s`
  (concordance des signes) ? (Spec §3 — `windows.ts`.)
- **Données :** 🔶 `earlybuyers/` (le cache 1 000 sigs permet de reconstruire
  plusieurs fenêtres par token).
- **Falsificateur :** concordance des signes < 50 % entre fenêtres → aucune
  définition n'est robuste, la question des fenêtres est mal posée.
- **Gain :** 5/5 — fondatrice : sans fenêtre robuste, tout le reste est sable.

### 008 · [A] Poids des toutes premières signatures → survie ?
- **Question :** la part du SOL apportée par les 3 premières signatures
  (rank 0–2) prédit-elle négativement la survie à 24h ?
- **Données :** 🔶 `earlybuyers/` (rank + montants).
- **Falsificateur :** ρ ≈ 0.
- **Gain :** 3/5.

### 009 · [A] Hétérogénéité des mises (« deux vitesses ») → Y ?
- **Question :** un set « deux vitesses » (ratio p90/p10 des montants élevé :
  quelques gros + beaucoup de petits) a-t-il une distribution de Y différente
  d'un set homogène ?
- **Données :** 🔶 `earlybuyers/`.
- **Falsificateur :** distributions de Y identiques entre déciles
  d'hétérogénéité (test KS non significatif).
- **Gain :** 3/5.

### 010 · [A] Recyclage du set d'un launch à l'autre → échec ?
- **Question :** la fraction d'early buyers déjà présents tôt sur le token
  PRÉCÉDENT du même créateur (recyclage du set) prédit-elle négativement la
  graduation ?
- **Données :** 🔶 `earlybuyers/` multi-tokens (n≥30 tokens à sets valides)
  + `scans/`.
- **Falsificateur :** taux de graduation indépendant du taux de recyclage.
- **Gain :** 3/5.

---

## Famille B — Vélocité du capital

### 011 · [B] Vélocité APRÈS contrôle de la concentration → Y ?
- **Question :** à HHI fixé (stratification par terciles de concentration), la
  vélocité d'entrée du capital (SOL/minute en fenêtre pré-t0) prédit-elle
  encore Y@6h ? (Désentrelace les deux dimensions confondues dans le résultat
  Phase 1 « frénésie → pertes ».)
- **Données :** 🔶 `earlybuyers/` + `history/`.
- **Falsificateur :** l'effet vélocité disparaît après stratification
  (Δρ ≈ 0) → la frénésie n'était que de la concentration déguisée.
- **Gain :** 5/5 — le confond central du programme.

### 012 · [B] Accélération vs vitesse : la dérivée seconde apporte-t-elle ?
- **Question :** l'accélération des achats (dérivée seconde du SOL cumulé)
  prédit-elle Y au-delà de la vitesse (R² partiel) ?
- **Données :** 🔶 `earlybuyers/`.
- **Falsificateur :** R² partiel ≈ 0 → la vitesse suffit.
- **Gain :** 3/5.

### 013 · [B] Asymétrie précoce achats/ventes DANS la fenêtre → DD ?
- **Question :** un ratio sells/buys élevé déjà dans la fenêtre pré-t0
  prédit-il le DD30 ?
- **Données :** 🔶 `earlybuyers/` (direction des transactions à parser ;
  attention au biais -32015, cf. Q-096).
- **Falsificateur :** ratio sans relation au DD30.
- **Gain :** 4/5.

### 014 · [B] Time-to-5-SOL vs survie ?
- **Question :** le temps nécessaire pour que 5 SOL cumulés entrent dans la
  courbe (depuis le create) prédit-il la survie à 24h ?
- **Données :** 🔶 `earlybuyers/` + `scans/` (create ts) + `history/`.
- **Falsificateur :** ρ ≈ 0.
- **Gain :** 4/5 — métrique simple, potentiellement robuste, coût faible.

### 015 · [B] La vélocité pré-t0 persiste-t-elle post-t0 ?
- **Question :** l'autocorrélation vélocité pré-t0 → vélocité post-t0 est-elle
  > 0, et une RUPTURE de persistance prédit-elle le retournement ?
- **Données :** 🔶 `earlybuyers/` + ✅ `history/` (snapshots post-t0).
- **Falsificateur :** autocorrélation ≈ 0 → pas de persistance mesurable.
- **Gain :** 3/5.

### 016 · [B] Vélocité RELATIVE (vs cohorte horaire) → graduation ?
- **Question :** la vélocité normalisée par le débit médian des creates de
  l'heure de naissance prédit-elle la graduation mieux que la vélocité absolue ?
- **Données :** 🔶 `earlybuyers/` + ✅ `scans/`.
- **Falsificateur :** la normalisation ne change pas le pouvoir prédictif
  (ΔAUROC ≈ 0).
- **Gain :** 3/5.

### 017 · [B] Concentration TEMPORELLE du capital (rafales) → survie ?
- **Question :** le Gini des montants par tranche de temps (le capital
  arrive-t-il en rafales ?) prédit-il la survie ?
- **Données :** 🔶 `earlybuyers/`.
- **Falsificateur :** pas de relation.
- **Gain :** 2/5.

### 018 · [B] « Second souffle » pré-t0 : reprise après creux → continuation ?
- **Question :** les tokens avec un second pic de vélocité avant t0
  survivent-ils mieux que ceux à vélocité monotone décroissante ?
- **Données :** 🔶 `earlybuyers/`.
- **Falsificateur :** pas de différence de survie.
- **Gain :** 2/5.

### 019 · [B] Vitesse d'exécution du devBuy (1 tx vs fractionné) → graduation ?
- **Question :** un devBuy exécuté en une seule transaction vs fractionné en
  plusieurs prédit-il différemment la graduation ? (H-DEVBUY falsifiée portait
  sur le MONTANT ; ici c'est la VITESSE d'exécution — question différente.)
- **Données :** ✅ `scans/` (initialBuy brut) + 🔶 `earlybuyers/`.
- **Falsificateur :** pas de différence 1-tx vs fractionné.
- **Gain :** 3/5.

### 020 · [B] Rendements décroissants : la vélocité marginale s'épuise-t-elle ?
- **Question :** dVélocité/dSOL_locké < 0 systématiquement, et la pente de cette
  décroissance prédit-elle la stagnation ?
- **Données :** 🔶 `earlybuyers/` + ✅ `history/`.
- **Falsificateur :** relation linéaire ou positive.
- **Gain :** 2/5.

---

## Famille C — Organicité (organique vs synthétique)

### 021 · [C] Coordination = danger ? → DD80
- **Question :** la fraction coordonnée du set (`coordinatedSetFrac`, entités
  liées par preuves `same_slot`/`temporal_sync`/`persistent_cooccurrence`)
  prédit-elle le DD80 comme FILTRE DE RISQUE ? (Mandatée. Distincte de
  H-PRED-WAL-04 « même slot → Y » : ici entités multi-preuves → DD80,
  cadrée risque, pas rendement.)
- **Données :** 🔶 `earlybuyers/` + module `clusters.ts` à construire.
- **Falsificateur :** DD80 indépendant de `coordinatedSetFrac`.
- **Gain :** 5/5 — version risque de H-BUNDLE, le risque le plus sous-estimé
  selon le red team.

### 022 · [C] Ratio organique vs survie ?
- **Question :** `organicRatio = 1 − coordinatedSetFrac − sniperShare`
  prédit-il la survie à 24h de façon monotone en terciles ?
- **Données :** 🔶 `earlybuyers/` + ✅ `history/`.
- **Falsificateur :** survie plate sur les terciles.
- **Gain :** 4/5.

### 023 · [C] sniper_share vs drawdown ?
- **Question :** la part des achats au slot de création (rank 0, `blockTime`
  identique) prédit-elle le drawdown maximal de façon monotone ?
- **Données :** 🔶 `earlybuyers/`.
- **Falsificateur :** DD indépendant de `sniperShare`.
- **Gain :** 4/5.

### 024 · [C] Topologie de la coordination : un gros cluster vs N petits ?
- **Question :** à `coordinatedSetFrac` égal, un seul gros cluster est-il plus
  dangereux que N petits clusters ?
- **Données :** 🔶 `earlybuyers/` + clustering.
- **Falsificateur :** pas de différence de DD80.
- **Gain :** 3/5.

### 025 · [C] Wallets « frais » (< 24h) parmi les early buyers → mort rapide ?
- **Question :** la fraction de wallets créés < 24h avant t0 prédit-elle
  `death_liq` < 6h ?
- **Données :** 🔶 `wallet-histories/` (première signature).
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 026 · [C] Wallets dormants réactivés → proxy d'achat de wallets ?
- **Question :** la part de wallets dormants (> 90j inactifs) réactivés pour ce
  token est-elle corrélée à `coordinatedSetFrac` ?
- **Données :** 🔶 `wallet-histories/`.
- **Falsificateur :** pas de corrélation → la réactivation n'est pas un proxy
  de coordination.
- **Gain :** 2/5.

### 027 · [C] Montants « ronds » (proxy humain) → survie ?
- **Question :** la fraction de montants ronds (0,5 / 1,0 SOL vs 0,4997…)
  prédit-elle la survie à 24h ?
- **Données :** 🔶 `earlybuyers/` (montants bruts).
- **Falsificateur :** pas de relation.
- **Gain :** 2/5.

### 028 · [C] Synchronie fine inter-wallets → dump coordonné ?
- **Question :** la synchronie fine (écarts < 2s répétés entre paires,
  `temporal_sync`) à t0 prédit-elle des ventes groupées post-t0 ?
  (Sells post-t0 = LABEL uniquement, jamais feature.)
- **Données :** 🔶 `earlybuyers/` + ✅ `history/` (sells post-t0 comme label).
- **Falsificateur :** pas de relation synchronie → dump groupé.
- **Gain :** 3/5.

### 029 · [C] Les « lone wolf » (zéro coordination détectable) surperforment-ils ?
- **Question :** les tokens à `coordinatedSetFrac = 0` ont-ils une survie
  supérieure au reste, et quel est leur taux de base (rareté) ?
- **Données :** 🔶 `earlybuyers/` + ✅ `history/`.
- **Falsificateur :** survie identique au reste.
- **Gain :** 3/5.

### 030 · [C] Dérive de l'organicité juste après t0 → DD ?
- **Question :** une dégradation rapide de l'organicité entre t0 et t0+30min
  prédit-elle le DD ? (Mesure de STABILITÉ, pas un signal d'entrée à t0 :
  feature à t0+30min inutilisable comme feature pré-t0.)
- **Données :** 🔶 `earlybuyers/` + ✅ `history/`.
- **Falsificateur :** pas de relation.
- **Gain :** 2/5.

---

## Famille D — Historique des wallets (pré-t0 uniquement)

### 031 · [D] Activité médiane pré-t0 des wallets → graduation ?
- **Question :** le nombre médian de signatures (30j pré-t0) des early buyers
  (bots très actifs vs humains occasionnels) prédit-il la graduation ?
- **Données :** 🔶 `wallet-histories/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 032 · [D] Spécialisation memecoin des early buyers → ?
- **Question :** la fraction d'activité pré-t0 sur programmes memecoin
  (pump/bonk) vs autres programmes prédit-elle différemment la survie
  (spécialistes vs généralistes) ?
- **Données :** ❌ à enrichir — programmes touchés par wallet (extension du cache).
- **Falsificateur :** pas de différence spécialistes/généralistes.
- **Gain :** 2/5.

### 033 · [D] « Dumpeurs rapides » historiques → DD80 ?
- **Question :** la fraction d'early buyers ayant vendu vite (< 5 min) sur
  leurs tokens précédents prédit-elle le DD80 ? (Comportemental, pas
  structurel.)
- **Données :** 🔶 `wallet-histories/` (sells historiques ; biais -32015 —
  cf. Q-096).
- **Falsificateur :** pas de relation.
- **Gain :** 4/5.

### 034 · [D] « Holders » historiques → survie ?
- **Question :** la fraction d'early buyers ayant tenu > 24h leurs tokens
  précédents prédit-elle la survie à 24h ?
- **Données :** 🔶 `wallet-histories/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 035 · [D] Qualité de sortie passée des wallets → Y ?
- **Question :** le MFE médian RÉALISÉ des wallets sur leurs tokens précédents
  (proxy via prix) prédit-il Y ?
- **Données :** ❌ difficile — prix historiques par wallet indisponibles
  (HORS SCOPE honnête, état des lieux §8) ; à collecter si jugé prioritaire.
- **Falsificateur :** pas de relation.
- **Gain :** 2/5 — coût élevé, incertitude sur la faisabilité.

### 036 · [D] Arrivée anormalement précoce vs habitude du wallet → graduation ?
- **Question :** les wallets qui arrivent PLUS TÔT que leur propre habitude
  (écart à leur rang d'arrivée médian historique) prédisent-ils la graduation ?
  (Distinct de H-PRED-WAL-08 « récurrence inter-tokens » : ici l'ÉCART à
  l'habitude, pas la présence.)
- **Données :** 🔶 `wallet-histories/` multi-tokens.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 037 · [D] Entropie des profils (mélange vs homogénéité) → survie ?
- **Question :** l'entropie du mélange âge × activité des early buyers
  prédit-elle la survie ?
- **Données :** 🔶 `wallet-histories/`.
- **Falsificateur :** pas de relation.
- **Gain :** 2/5.

### 038 · [D] Wallets « pont » (early ici + early sur gradué récent ≤7j) → graduation ?
- **Question :** la fraction de wallets-pont prédit-elle la graduation ?
  (Passé ≤ t0 uniquement — pas de « smart money » futur.)
- **Données :** 🔶 `earlybuyers/` + ✅ `scans/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 039 · [D] L'âge du doyen apporte-t-il au-delà de la médiane ?
- **Question :** l'ancienneté du PLUS VIEUX wallet du set a-t-elle un pouvoir
  marginal au-delà de la médiane (R² partiel) ?
- **Données :** 🔶 `wallet-histories/`.
- **Falsificateur :** R² partiel ≈ 0.
- **Gain :** 2/5.

### 040 · [D] Early buyers eux-mêmes déployeurs → graduation ?
- **Question :** la fraction d'early buyers ayant déjà DÉPLOYÉ un token
  (traderPublicKey croisé) prédit-elle la graduation ? (Distinct de
  H-PRED-WAL-09 « historique du dev du token » : ici le rôle déployeur des
  ACHETEURS.)
- **Données :** 🔶 `earlybuyers/` ∩ ✅ `scans/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.
---

## Famille E — Créateur (déployeur)

### 041 · [E] Interaction creator × flow → graduation ?
- **Question :** le terme d'interaction (historique créateur × organicRatio)
  améliore-t-il la prédiction de la graduation au-delà des effets principaux ?
  (Un bon flow compense-t-il un créateur faible, et inversement ?)
- **Données :** ✅ `scans/` (historique créateur) + 🔶 `earlybuyers/`.
- **Falsificateur :** interaction non significative en régression logistique.
- **Gain :** 4/5.

### 042 · [E] Créateur « en forme » vs « en froid » : persistance du dernier résultat ?
- **Question :** le résultat du token PRÉCÉDENT du même créateur (gradué ou
  non) prédit-il le suivant — test apparié ? (Distinct de H-SERIAL
  « n°1 vs n°5+ » : ici la dynamique RÉCENTE.)
- **Données :** ✅ `scans/` (séquence par traderPublicKey).
- **Falsificateur :** pas de persistance (test apparié non significatif).
- **Gain :** 3/5.

### 043 · [E] Délai inter-launch du créateur → graduation ?
- **Question :** le délai médian entre créations du déployeur (farm
  industrielle = rapprochés vs lancement espacé) prédit-il la graduation ?
- **Données :** ✅ `scans/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 044 · [E] Le créateur rachète-t-il son propre token pré-t0 ? → survie ?
- **Question :** des achats additionnels du créateur dans la fenêtre pré-t0
  (conviction révélée, au-delà du devBuy initial) prédisent-ils la survie ?
- **Données :** 🔶 `earlybuyers/` (identifier le wallet créateur) + ✅ `scans/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 045 · [E] Le créateur vend-il avant t0 ? → DD80 ?
- **Question :** une vente du créateur dans la fenêtre pré-t0 prédit-elle le
  DD80 ?
- **Données :** 🔶 `earlybuyers/` (sells du créateur).
- **Falsificateur :** pas de relation.
- **Gain :** 4/5 — signal de danger fort s'il est réel.

### 046 · [E] Fidélité du set au créateur → graduation ?
- **Question :** la fraction d'early buyers ayant déjà acheté tôt un token du
  MÊME créateur (réputation révélée par les autres) prédit-elle la graduation ?
- **Données :** 🔶 `earlybuyers/` + ✅ `scans/` + 🔶 `wallet-histories/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 047 · [E] Outil de déploiement × organicité : interaction ?
- **Question :** l'effet de l'organicRatio sur la survie varie-t-il selon le
  domaine d'URI (outil pro type j7tracker vs déploiement manuel) ?
  (H-TOOL seul est NON ACTIONNABLE ; ici c'est l'INTERACTION.)
- **Données :** ✅ `scans/` (uri) + 🔶 `earlybuyers/`.
- **Falsificateur :** pas d'interaction significative.
- **Gain :** 3/5.

### 048 · [E] Régime de lancement (pool pump / bonk / mayhem) : les signaux sont-ils stables ?
- **Question :** les relations flow→survie sont-elles stables entre
  `pool=pump`, `pool=bonk` et `is_mayhem_mode` ?
- **Données :** ✅ `scans/` + 🔶 `earlybuyers/`.
- **Falsificateur :** relations stables → un seul modèle suffit, pas de
  modulation par régime de lancement.
- **Gain :** 3/5.

### 049 · [E] Comportement de fees du créateur → tenue ?
- **Question :** le créateur qui réinvestit/retire ses creator fees
  (comportement observable) prédit-il la tenue du token ?
- **Données :** ❌ à collecter (H-FEEFLOW — mapping bénéficiaires de fees,
  spec rédigée, ne pas approximer).
- **Falsificateur :** pas de relation.
- **Gain :** 2/5 — bloquée par la collecte.

### 050 · [E] Premier token vs N-ième, à flow égal → différence ?
- **Question :** à flow égal (appariement), les premiers tokens d'un créateur
  graduent-ils différemment des suivants (effet « débutant ») ?
- **Données :** ✅ `scans/` + 🔶 `earlybuyers/`.
- **Falsificateur :** pas de différence à flow égal.
- **Gain :** 3/5.

---

## Famille F — Survie (durée de vie, hazard)

### 051 · [F] Définitions de mort multiples : la « survie » est-elle un construit unique ?
- **Question :** les classements de features sont-ils concordants entre
  `death_liq`, `death_price` et `death_dd80` ? (Spec §6 — table de sensibilité.)
- **Données :** ✅ `history/` (labels à construire).
- **Falsificateur :** concordance < 50 % → la « survie » n'est pas un construit
  unique ; chaque définition = question séparée.
- **Gain :** 5/5 — fondatrice, coût quasi nul.

### 052 · [F] Forme du hazard : pic précoce puis plateau ?
- **Question :** la fonction de hazard instantané de mort (Kaplan-Meier) est-elle
  en cloche (risque maximal précoce) ?
- **Données :** ✅ `history/`.
- **Falsificateur :** hazard constant ou monotone → pas de structure temporelle.
- **Gain :** 3/5.

### 053 · [F] Survie conditionnelle : les features t0 survivent-elles au conditionnement ?
- **Question :** les features t0 gardent-elles un pouvoir prédictif sur la
  survie 6h→24h CONDITIONNELLE à la survie à 6h, ou la sélection se fait-elle
  entièrement tôt ?
- **Données :** ✅ `history/` + 🔶 `earlybuyers/`.
- **Falsificateur :** pouvoir → 0 après conditionnement → tout se joue avant 6h.
- **Gain :** 4/5.

### 054 · [F] Cox PH multivarié : quelles features gardent un hazard ratio significatif ?
- **Question :** en modèle de Cox PH (spec §8 — méthode recommandée par la
  littérature), quelles features t0 gardent un HR significatif après ajustement
  mutuel et correction multiple ?
- **Données :** ✅ `history/` + 🔶 `earlybuyers/` ; module `survival.ts` à construire.
- **Falsificateur :** aucun HR significatif après correction → NO EVIDENCE en
  multivarié.
- **Gain :** 5/5 — départage les features une fois pour toutes.

### 055 · [F] Deux régimes de mort : « saignement » vs « falaise » ?
- **Question :** les morts par DD progressif vs gap violent ont-elles des
  signatures t0 différentes (deux mécanismes, deux prédicteurs) ?
- **Données :** ✅ `history/`.
- **Falsificateur :** signatures indistinguables → un seul mécanisme.
- **Gain :** 3/5.

### 056 · [F] Censure : les tokens encore vivants biaisent-ils les estimations ?
- **Question :** les conclusions changent-elles entre (a) exclusion des
  censurés et (b) modèle de survie propre avec censure ?
- **Données :** ✅ `history/`.
- **Falsificateur :** pas de changement → estimations robustes à la censure.
- **Gain :** 3/5 — question de méthode, coût faible.

### 057 · [F] Demi-vie du signal : à quel horizon les features t0 meurent-elles ?
- **Question :** le pouvoir prédictif des features t0 décroît-il avec l'horizon
  (1h / 6h / 24h / 7j), et à partir de quel horizon → 0 ?
- **Données :** ✅ `history/` (7j : fenêtre actuelle limitée — borne basse) +
  🔶 `earlybuyers/`.
- **Falsificateur :** pouvoir constant sur les horizons → suspect
  (ou signal anormalement persistant — à investiguer).
- **Gain :** 4/5.

### 058 · [F] Survie RELATIVE à la cohorte de naissance → suite ?
- **Question :** le rang de survie d'un token dans sa cohorte horaire de
  naissance prédit-il sa survie long terme ?
- **Données :** ✅ `history/` + ✅ `scans/`.
- **Falsificateur :** pas de relation.
- **Gain :** 2/5.

### 059 · [F] Les survivants 7j sont-ils distinguables à t0 ?
- **Question :** les tokens survivant 7j ont-ils une signature t0 distincte du
  reste (test de permutation), ou est-ce du hasard ?
- **Données :** ✅ `history/` — LIMITÉ par la fenêtre 5j actuelle ; nécessite
  une collecte plus longue pour un vrai 7j.
- **Falsificateur :** indistinguables.
- **Gain :** 3/5.

### 060 · [F] Risques concurrents : graduation vs mort — mêmes prédicteurs ?
- **Question :** en modèle à risques concurrents, les features qui prédisent la
  graduation prédisent-elles aussi la mort (corrélées) ou sont-elles
  découplées ?
- **Données :** ✅ `history/` + ✅ `scans/`.
- **Falsificateur :** HR graduation et HR mort parfaitement corrélés → un seul
  axe sous-jacent.
- **Gain :** 4/5.

---

## Famille G — Danger (rug, drawdown, filtres de risque)

### 061 · [G] Ventes groupées des early wallets → DD80 ? (T-BUNDLE)
- **Question :** les tokens dont les early wallets vendent de façon groupée
  post-t0 (LABEL) ont-ils un DD80 systématique — exécution du test T-BUNDLE
  pré-enregistré (H-BUNDLE : filtre d'exclusion, risque le plus sous-estimé
  selon le red team) ?
- **Données :** 🔶 `earlybuyers/` + ✅ `history/` ; spec de collecte rédigée
  (insider-economics §2, ~210 crédits/token).
- **Falsificateur :** pas de différence de DD80 → H-BUNDLE tuée.
- **Gain :** 5/5.

### 062 · [G] Ventes précoces « en vagues » → DD ?
- **Question :** ≥3 vagues de sells distinctes dans l'heure post-t0
  prédisent-elles le DD ?
- **Données :** ✅ `history/` (txns buys/sells par snapshot).
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 063 · [G] Seuil binaire sells/buys à t0 : rappel/précision sur les DD80 ?
- **Question :** un filtre binaire `sells/buys > X` à t0 exclut-il les DD80
  avec quel rappel et quelle précision ? (H-PRED-FLOW-01 a montré la direction ;
  ici c'est l'OPÉRATIONNALISATION en filtre.)
- **Données :** ✅ `history/`.
- **Falsificateur :** précision ≈ taux de base → filtre inutile.
- **Gain :** 3/5.

### 064 · [G] Effondrement de liquidité post-t0 → mort ?
- **Question :** Δliq < −50 % dans l'heure post-t0 prédit-il `death_liq` ?
- **Données :** ✅ `history/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 065 · [G] « Dead cat » : le rebond après −50 % prédit-il la rechute ?
- **Question :** après une chute ≥50 %, un rebond >30 % mène-t-il
  systématiquement à une seconde mort (dead cat) ou à la survie ?
- **Données :** ✅ `history/`.
- **Falsificateur :** 50/50 → pas de structure.
- **Gain :** 2/5.

### 066 · [G] Les vendeurs sont-ils les mêmes entités que les acheteurs ?
- **Question :** la concentration des vendeurs post-t0 (par entité) est-elle
  corrélée à la concentration des acheteurs pré-t0 (« ceux qui pompent sont
  ceux qui dumpent ») ?
- **Données :** ❌ à collecter — sellers post-t0 par entité (extension du cache
  earlybuyers au versant ventes).
- **Falsificateur :** pas de corrélation → vendeurs ≠ acheteurs, le mécanisme
  supposé est faux.
- **Gain :** 4/5 — teste le mécanisme central du danger.

### 067 · [G] Vitesse du premier DD20 → profondeur finale ?
- **Question :** un DD20 rapide (< 30 min) mène-t-il plus souvent au DD80
  qu'un DD20 lent ?
- **Données :** ✅ `history/`.
- **Falsificateur :** pas de différence.
- **Gain :** 3/5.

### 068 · [G] Signature de rug : retrait de liquidité + vente créateur → mort < 6h ?
- **Question :** (Δliq < −70 % ET vente du créateur < 2h) classifie-t-il
  `death_liq` < 6h, avec quelle précision ?
- **Données :** ✅ `history/` + 🔶 `earlybuyers/`.
- **Falsificateur :** précision ≈ taux de base.
- **Gain :** 3/5.

### 069 · [G] Filtre turnover > P90 : quel rappel sur les DD80 ?
- **Question :** quelle fraction des DD80 est capturée par le filtre binaire
  turnover > P90 (H-PRED-LIQ-01 opérationnalisé en filtre d'exclusion) ?
- **Données :** ✅ `history/`.
- **Falsificateur :** rappel ≈ 10 % (hasard) → filtre sans valeur.
- **Gain :** 3/5.

### 070 · [G] Morts « silencieuses » vs « bruyantes » : signatures t0 distinctes ?
- **Question :** les tokens qui meurent SANS pic de volume ni frénésie ont-ils
  une signature t0 distincte (faible vélocité + forte concentration) des morts
  bruyantes ?
- **Données :** ✅ `history/` + 🔶 `earlybuyers/`.
- **Falsificateur :** signatures indistinguables.
- **Gain :** 3/5.

---

## Famille H — Graduation (migration comme événement)

### 071 · [H] Graduation conditionnelle → survie : la graduation « réinitialise »-t-elle le destin ?
- **Question :** parmi les tokens GRADUÉS, les features t0 prédisent-elles
  encore la survie post-graduation, ou la graduation réinitialise-t-elle le
  destin (pouvoir → 0) ?
- **Données :** 🔶 `earlybuyers/` + ✅ `scans/` + ✅ `history/`.
- **Falsificateur :** aucun pouvoir conditionnel → tout l'appareil pré-t0 est
  sans objet après graduation ; la famille I doit repartir d'autres features.
- **Gain :** 5/5 — pont H→I ; décide si le pré-t0 a un sens post-graduation.

### 072 · [H] Distance au seuil à t0 → graduation, sur univers genuine ?
- **Question :** sur univers genuine UNIQUEMENT (sans late-discovery), la
  distance au seuil de graduation à t0 prédit-elle la migration ?
  (H-CURVE v1 est NON CONCLUANT par biais de sélection ; ici protocole corrigé.)
- **Données :** ✅ `scans/` (genuine).
- **Falsificateur :** pas de relation sur genuine → la distance au seuil ne
  prédit rien, point final.
- **Gain :** 4/5.

### 073 · [H] Stagnation près du seuil vs arrivée rapide : processus avec ou sans mémoire ?
- **Question :** à distance au seuil égale, les tokens qui STAGNENT près du
  seuil graduent-ils plus ou moins que ceux qui y arrivent vite ?
  (Complète H-MAGNET « hazard convexe » déjà inscrite : ici c'est la MÉMOIRE
  du processus, pas la forme du hazard.)
- **Données :** ✅ `history/`.
- **Falsificateur :** pas de différence → processus sans mémoire.
- **Gain :** 4/5.

### 074 · [H] « Presque gradués » (90 %+ puis retombée) : seconde chance ?
- **Question :** les tokens ayant atteint ≥90 % du seuil sans graduer ont-ils
  un taux de graduation ultérieure différent de ceux n'ayant jamais approché ?
- **Données :** ✅ `history/` + ✅ `scans/`.
- **Falsificateur :** pas de différence.
- **Gain :** 3/5.

### 075 · [H] Pente d'approche du seuil → graduation, au-delà du niveau ?
- **Question :** la pente d'approche (SOL/heure vers le seuil) prédit-elle la
  graduation au-delà du niveau atteint (R² partiel) ?
- **Données :** ✅ `history/`.
- **Falsificateur :** seul le niveau compte (R² partiel ≈ 0).
- **Gain :** 3/5.

### 076 · [H] Qualité de la graduation (organique vs poussée) → suite ?
- **Question :** les graduations à organicRatio haut survivent-elles mieux
  post-migration que les graduations poussées (coordonné) ?
- **Données :** 🔶 `earlybuyers/` + ✅ `scans/`.
- **Falsificateur :** pas de différence → la manière de graduer n'a pas
  d'importance.
- **Gain :** 4/5.

### 077 · [H] Prix du SOL à la naissance → taux de graduation ?
- **Question :** le prix du SOL à la naissance (seuil plus ou moins dur en USD)
  module-t-il le taux de graduation genuine ?
- **Données :** ✅ `scans/` + prix SOL.
- **Falsificateur :** pas de modulation.
- **Gain :** 2/5.

### 078 · [H] Mayhem mode : taux de graduation différent à flow égal ?
- **Question :** les tokens `is_mayhem_mode` graduent-ils à un taux différent,
  à flow égal (appariement) ?
- **Données :** ✅ `scans/` + 🔶 `earlybuyers/`.
- **Falsificateur :** pas de différence à flow égal.
- **Gain :** 2/5.

### 079 · [H] Imbalance acheteuse cumulée pré-t0 → graduation ?
- **Question :** l'imbalance cumulée (buys−sells)/(buys+sells) en fenêtre
  pré-t0 prédit-elle la graduation ?
- **Données :** 🔶 `earlybuyers/` (direction des transactions).
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 080 · [H] Heure de la graduation (pas de la création) → suite ?
- **Question :** l'heure UTC de l'événement `migrate` est-elle informative sur
  la survie post-migration ?
- **Données :** ✅ `scans/` (migrate ts) + ✅ `history/`.
- **Falsificateur :** pas de relation.
- **Gain :** 2/5.
---

## Famille I — Transition post-graduation

### 081 · [I] Dérive post-migration : existe-t-il une structure descriptive ?
- **Question :** le rendement médian 24h post-migration, conditionnel au type
  de graduation (organique vs poussée), est-il ≠ 0 ?
  (DESCRIPTIF uniquement — le second filtre a montré l'entrée post-migration
  inexécutable ; aucune conclusion de trade n'en sera tirée. Distinct de
  H-POSTMIG « pattern ±60min » : ici horizon 24h + conditionnement par type.)
- **Données :** ✅ `history/` + ✅ `scans/`.
- **Falsificateur :** médiane ≈ 0 dans tous les buckets → aucune structure
  descriptive.
- **Gain :** 4/5.

### 082 · [I] SOL locké au migrate → survie post-migration ?
- **Question :** la taille du pool initial (SOL migré vers Raydium) prédit-elle
  la survie 7j post-migration ?
- **Données :** ✅ `scans/` (événements migrate) + ✅ `history/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 083 · [I] Les entités coordonnées sortent-elles plus vite que les organiques ?
- **Question :** après migration, la vitesse de sortie des entités coordonnées
  vs organiques diffère-t-elle (demi-vie de rétention par type) ?
  (Distinct de H-PRED-WAL-07 « rétention +5min → Y » : ici vitesse
  DIFFÉRENTIELLE par type d'entité.)
- **Données :** ❌ à collecter — suivi des wallets post-migration par entité
  (extension du cache).
- **Falsificateur :** vitesses identiques.
- **Gain :** 4/5.

### 084 · [I] Les snipers pré-migration deviennent-ils les dumpers post-migration ?
- **Question :** les entités sniper pré-t0 sont-elles surreprésentées parmi les
  vendeurs post-migration (continuité des entités à travers l'événement) ?
- **Données :** ❌ à collecter — lien entités pré/post-migration.
- **Falsificateur :** pas de surreprésentation → les vendeurs post-migration
  sont d'autres acteurs.
- **Gain :** 3/5.

### 085 · [I] Volatilité de transition (2h post-migration) → survie 7j ?
- **Question :** la volatilité réalisée dans les 2h suivant le migrate
  prédit-elle la survie à 7j ?
- **Données :** ✅ `history/`.
- **Falsificateur :** pas de relation.
- **Gain :** 2/5.

### 086 · [I] Premier retest du prix de migration : rebond ou cassure ?
- **Question :** le premier retest du prix de migration mène-t-il plus souvent
  au rebond (>50 %) ou à la cassure ?
- **Données :** ✅ `history/`.
- **Falsificateur :** 50/50 → pas de structure.
- **Gain :** 2/5.

### 087 · [I] Rétention des holders à J+1 → J+7 ?
- **Question :** le taux de holders restants à J+1 post-graduation prédit-il la
  survie à J+7 ?
- **Données :** ❌ à collecter — holders post-migration (Helius).
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 088 · [I] Changement de régime de volatilité à la migration ?
- **Question :** le ratio volatilité post/pré-migration (apparié par token)
  est-il systématiquement > 1 (changement de régime structurel) ?
- **Données :** ✅ `history/`.
- **Falsificateur :** ratio ≈ 1 → pas de changement de régime.
- **Gain :** 2/5.

### 089 · [I] Temps create→migrate (« gradués lents » vs « rapides ») → survie ?
- **Question :** le temps écoulé entre création et migration prédit-il la
  survie post-migration ?
- **Données :** ✅ `scans/` + ✅ `history/`.
- **Falsificateur :** pas de relation.
- **Gain :** 3/5.

### 090 · [I] « Faux gradués » (mort < 24h post-migration) : détectables à t0 ?
- **Question :** les tokens gradués qui meurent < 24h après migration
  avaient-ils une signature t0 distincte des gradués survivants ?
- **Données :** 🔶 `earlybuyers/` + ✅ `scans/` + ✅ `history/`.
- **Falsificateur :** signatures indistinguables → la mort post-graduation
  rapide n'est pas écrite à t0.
- **Gain :** 4/5.

---

## Famille J — Régime de marché

### 091 · [J] Les relations flow→survie sont-elles stables entre régimes de congestion ?
- **Question :** les coefficients flow→survie sont-ils stables entre terciles
  de congestion du flux (débit de creates/heure à la naissance) ?
- **Données :** ✅ `scans/` + 🔶 `earlybuyers/`.
- **Falsificateur :** coefficients stables → pas d'effet régime, un seul
  modèle suffit.
- **Gain :** 4/5.

### 092 · [J] Régime de volatilité SOL : les signaux tiennent-ils ?
- **Question :** les relations features→Y sont-elles stables quand SOL est
  volatil vs calme (terciles de vol réalisée SOL) ?
- **Données :** ✅ prix SOL + 🔶 `earlybuyers/`.
- **Falsificateur :** stables → les signaux sont idiosyncratiques au token.
- **Gain :** 3/5.

### 093 · [J] « Heures de bot » vs « heures humaines » : la composition du flux varie-t-elle ?
- **Question :** la part de creates via outils pro (domaine d'URI) varie-t-elle
  selon l'heure UTC, et l'organicité moyenne suit-elle ?
- **Données :** ✅ `scans/` (uri, heure).
- **Falsificateur :** pas de variation horaire → le flux est homogène dans le temps.
- **Gain :** 2/5.

### 094 · [J] Frénésie collective : densité de graduations récentes → survie ?
- **Question :** la densité de graduations dans les ±6h autour de la naissance
  module-t-elle la survie (effet d'entraînement vs dilution de l'attention) ?
- **Données :** ✅ `scans/` + ✅ `history/`.
- **Falsificateur :** pas de modulation.
- **Gain :** 3/5.

### 095 · [J] Le taux de base genuine est-il stationnaire sur la fenêtre ?
- **Question :** le taux de graduation genuine est-il stationnaire du 24 au 28
  sept. (test de rupture) ?
- **Données :** ✅ `scans/`.
- **Falsificateur :** stationnaire → les walk-forwards sur cette fenêtre sont
  valides ; NON-stationnaire → TOUT (walk-forwards, seuils, taux de base) est
  à revoir.
- **Gain :** 4/5 — coût quasi nul, enjeu maximal si rupture.

---

## Famille Q — Qualité des données (5 questions)

### 096 · [Q] Les ventes manquantes (-32015) biaisent-elles les conclusions sell-side ?
- **Question :** sur un échantillon re-fetché avec tolérance -32015, les
  métriques sell-side (D-033, C-028, G-061) changent-elles de signe ou
  d'amplitude ?
- **Données :** re-fetch ciblé borné (coût Helius maîtrisé).
- **Falsificateur :** pas de changement → le biais -32015 est négligeable
  pour ces questions.
- **Gain :** 5/5 — invalide ou valide tout le versant ventes du programme.

### 097 · [Q] t0 scan vs t0 on-chain : les labels changent-ils ?
- **Question :** sur n≥30 tokens fastlane, quelle est la concordance des
  labels Y entre t0 = premier scan DexScreener et t0 = premier slot on-chain
  (p50 détection ~140 ms) ?
- **Données :** 🔶 `fastlane/` (runs bornés — firehose brut exclu, cf. addendum).
- **Falsificateur :** concordance ≥ 95 % → la définition actuelle de t0 est
  suffisante, pas besoin d'ancrage on-chain systématique.
- **Gain :** 5/5 — tout le programme repose sur l'ancrage t0.

### 098 · [Q] Backfill tronqué : les résultats tiennent-ils sur fichiers validés ?
- **Question :** les statistiques discovery (familles A–C) changent-elles quand
  on ne garde que les fichiers `earlybuyers/` passant le test de
  non-troncature ?
- **Données :** 🔶 `earlybuyers/` + rapport de validation de l'agent backfill
  (2 sections : VALIDATION BACKFILL / VALIDATION QUALITÉ).
- **Falsificateur :** pas de changement → la troncature est sans effet sur les
  conclusions.
- **Gain :** 4/5.

### 099 · [Q] Biais hot-token : les 3 filtres de risque Phase 1 tiennent-ils sur l'univers froid ?
- **Question :** réplication de H-PRED-FLOW-01, H-PRED-LIQ-01, H-PRED-TEMP-LEVEL
  sur le sous-univers froid uniquement (stratification chaud/froid de
  `history/`) — les signaux survivent-ils à la borne pessimiste ?
- **Données :** ✅ `history/`.
- **Falsificateur :** signaux intacts sur froid → les filtres sont robustes ;
  s'ils disparaissent → les « bornes optimistes » (+12 pts) invalident les
  filtres actuels.
- **Gain :** 4/5.

### 100 · [Q] Fenêtre 1 000 signatures : biais sur les features d'activité ?
- **Question :** sur un échantillon de contrôle avec pagination complète, les
  features d'ancienneté/activité (D-031, D-036, A-002) diffèrent-elles de la
  version fenêtre-1000 pour les wallets très actifs ?
- **Données :** 🔶 `wallet-histories/` + fetch complet de contrôle (borné).
- **Falsificateur :** pas de biais mesurable → la fenêtre 1 000 est acceptable.
- **Gain :** 3/5.

---

## TOP-10 — meilleur ratio gain / coût

| # | Exp. | Justification (1 ligne) |
|---|---|---|
| 1 | 097 · t0 scan vs on-chain | Coût faible (runs fastlane bornés) ; tranche l'ancrage de TOUS les labels du programme. |
| 2 | 096 · biais -32015 | Re-fetch borné ; invalide ou valide d'un coup tout le versant sell-side (D-033, C-028, G-061). |
| 3 | 051 · définitions de mort | Coût quasi nul (history) ; décide si « survie » est un construit unique ou trois questions. |
| 4 | 095 · stationnarité du taux de base | Scans uniquement ; si rupture, tous les walk-forwards sont à revoir. |
| 5 | 011 · vélocité \| concentration | Données déjà là ; tranche le confond central (« frénésie » = vitesse ou concentration ?). |
| 6 | 001 · entité vs wallet | Clé de voûte méthodologique (Liu 2025) : un test qui peut forcer à recalculer toute la famille A–C. |
| 7 | 021 · coordination = danger | Version risque de H-BUNDLE — le risque le plus sous-estimé selon le red team. |
| 8 | 071 · graduation → survie conditionnelle | Décide si l'appareil pré-t0 a un sens après graduation (pont H→I, oriente toute la famille I). |
| 9 | 007 · robustesse des fenêtres | Fondatrice (§3 spec) : sans fenêtre robuste, les features early-buyer sont du sable. |
| 10 | 054 · Cox PH multivarié | La méthode recommandée par la littérature ; départage les features une fois pour toutes. |

## Couverture des questions obligatoires du mandat

| Question mandatée | Expérience |
|---|---|
| entité vs wallet pour la concentration ? | 001 |
| ancienneté des early buyers ? | 002 |
| wallets à historique positif pré-t0 ? | 003 |
| diversité des financeurs ? | 004 |
| vélocité après contrôle de la concentration ? | 011 |
| coordination = danger ? | 021 |
| ratio organique vs survie ? | 022 |
| creator × flow ? | 041 |
| signaux selon régime ? | 091 (+048, +092) |
| graduation conditionnelle → survie ? | 071 |
| transition post-graduation exploitable ? (descriptif) | 081 |
| time-to-5-SOL vs survie ? | 014 |
| sniper_share vs drawdown ? | 023 |
| data quality : ventes -32015 | 096 |
| data quality : t0 scan vs t0 on-chain | 097 |
| data quality : backfill tronqué | 098 |
| data quality : biais hot-token | 099 |
| data quality : fenêtre 1000 signatures | 100 |

*Registre tenu par Muse. Aucune de ces 100 questions ne rouvre un verdict gelé ;
chacune porte son falsificateur — le kill switch §16 s'applique avant toute
promotion vers la batterie pré-enregistrée.*
