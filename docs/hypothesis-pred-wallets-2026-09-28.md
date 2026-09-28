# Hypothèses prédictives — Wallet Behavior / Early Buyers (2026-09-28)

Programme prédictif, **phase DÉCOUVERTE** : chercher une relation stable entre
variables à t0 (composition des premiers acheteurs) et rendement futur Y /
survie future. **Aucune stratégie construite.** Toutes les hypothèses sont
**NON TESTABLES** à ce stade (n=1 en discovery ; seuil de conclusivité n ≥ 30).

Convention de phases : DÉCOUVERTE → VERROUILLAGE → CALIBRATION → MESURE HOLDOUT
(unique, sur `data/track-unbiased/`, jamais avant le gel).

Question prioritaire commune : **la structure des participants à t0 prédit-elle
la qualité du mouvement futur** (vs « prix monte → acheter ») ?

---

## H-PRED-WAL-01 — Nombre d'acheteurs précoces → Y / survie

- **Phase :** DÉCOUVERTE
- **Variable X :** `buyerCount` (wallets distincts dans `buyers[]`).
- **Rationale :** un grand nombre d'acheteurs indépendants tôt = demande
  distribuée, potentiellement plus résiliente qu'une poignée de snipers.
- **n actuel (discovery) :** 1. **Verdict : NON TESTABLE.**

## H-PRED-WAL-02 — Concentration top-5 → Y / survie

- **Phase :** DÉCOUVERTE
- **Variable X :** `top5Share` (part des 5 plus gros montants ; = `metrics.top5_share`,
  re-vérifié par recomputation exacte).
- **Rationale :** concentration extrême (ex. 0,99) = quelques wallets peuvent
  vider le marché ; distribution large = offre moins capturable. Lien direct
  avec H-BUNDLE (clusters de vente coordonnée).
- **n actuel (discovery) :** 1. **Verdict : NON TESTABLE.**

## H-PRED-WAL-03 — Inégalité des montants (Gini) → Y / survie

- **Phase :** DÉCOUVERTE
- **Variable X :** `gini` des `amountRaw` (re-vérifié = metrics).
- **Rationale :** le Gini capte l'inégalité sur toute la distribution, là où le
  top-5 ne voit que la tête. Complémentaire à H-PRED-WAL-02, pas redondant :
  même top-5, Gini différent selon la queue.
- **n actuel (discovery) :** 1. **Verdict : NON TESTABLE.**

## H-PRED-WAL-04 — Coordination temporelle (même slot) → Y / survie

- **Phase :** DÉCOUVERTE
- **Variable X :** `sameSlotMax` (part max de buyers partageant un slot).
- **Rationale :** arrivée groupée dans le même slot = snipe coordonné / bundle
  (cf. H-BUNDLE, cas « fred » : cluster 29,74 %). Un bundle précoce peut dumper
  dès la migration.
- **n actuel (discovery) :** 1. **Verdict : NON TESTABLE.**

## H-PRED-WAL-05 — Vitesse d'arrivée des wallets → Y / survie

- **Phase :** DÉCOUVERTE
- **Variable X :** `arrivalSpanSec` = blockTime(rank 9) − blockTime(rank 0)
  (+ `medianInterArrivalSec` en complément).
- **Rationale :** arrivée fulgurante (span ≈ 0 s) = bots/snipers pré-positionnés ;
  arrivée étalée = découverte organique progressive. Qualité du mouvement
  potentiellement différente.
- **n actuel (discovery) :** 1. **Verdict : NON TESTABLE.**

## H-PRED-WAL-06 — Poids du top-1 → Y / survie

- **Phase :** DÉCOUVERTE
- **Variable X :** `top1AmountShare` (part du plus gros acheteur par montant).
- **Rationale :** un seul wallet dominant (ex. 0,42) = risque de vente unique
  massive ; c'est la version « whale individuelle » de la concentration.
- **n actuel (discovery) :** 1. **Verdict : NON TESTABLE.**

## H-PRED-WAL-07 — Rétention à +5 min post-migration → Y / survie

- **Phase :** DÉCOUVERTE
- **Variables X :** `sellersOver50` (nb wallets ayant vendu >50 %) et
  `medianSoldFrac` (soldFrac médian des wallets couverts).
- **Rationale :** des early buyers qui conservent après la migration signalent
  une conviction (ou une incapacité à sortir) ; une vente immédiate massive
  = extraction de valeur précoce.
- **Données :** quasi absentes (`walletsCovered = 0` sur la plupart des fichiers,
  échecs Helius `-32015` côté backfill). **Verdict : NON MESURABLE** en l'état —
  en suspens jusqu'à un backfill sells fonctionnel.

## H-PRED-WAL-08 — Wallets récurrents inter-tokens → Y / survie

- **Phase :** DÉCOUVERTE
- **Variable X :** `overlapFrac` (part des buyers déjà vus sur ≥2 tokens du dataset).
- **Rationale :** des wallets qui reviennent sur les launches = snipers
  professionnels / insiders de l'écosystème ; leur présence précoce pourrait
  signaler (ou fabriquer) la qualité du mouvement. Face positive de H-BLOCK.
- **n actuel :** dégénéré à 0 sur 11 fichiers (dataset trop petit).
  **Verdict : NON TESTABLE** — ne deviendra informatif qu'à l'échelle de
  centaines de tokens.

## H-PRED-WAL-09 — Historique dev wallet (one-shot vs répété) → Y / survie

- **Phase :** DÉCOUVERTE
- **Variable X :** `devHistory` — le dev wallet a-t-il déjà lancé (et gradué)
  d'autres tokens ? (travaux H-DEV / H-BLOCK antérieurs, cf. `docs/`).
- **Rationale :** un dev répété avec historique de graduations vs un one-shot
  : la réputation on-chain du créateur pourrait prédire la tenue du token.
- **Données : MANQUANTES** — aucun artefact mint → dev wallet disponible
  (events PumpPortal `traderPublicKey` absents de `data/scans/`).
  Interface prête (`devHistory` dans `WalletFeatures`, null documenté).
  **Verdict : NON MESURABLE** — à brancher quand le registre existera.

---

## Grille de passage de phase (rappel)

1. Backfill `data/earlybuyers/` → n ≥ 30 **en discovery** : lecture des
   Spearman/déciles/stabilités (pipeline `lab/predictive/wallets/pipeline.ts`).
2. Si une relation survit (stable temporellement et par cohorte, avec et sans
   outliers) : **VERROUILLAGE** écrit de l'hypothèse (seuils, horizons, métrique).
3. `--phase=calibration` : mesure sur discovery + calibration.
4. Si confirmée : gel, puis **UNE SEULE** mesure holdout (script dédié,
   `data/track-unbiased/` — jamais ces données biaisées).
5. Si rien ne prédit hors échantillon : **NO EVIDENCE OF PREDICTIVE SIGNAL**,
   écrit plainement, domaine classé.

*Hypothèses créées le 2026-09-28. Aucune n'est validée. Aucun commit.*
