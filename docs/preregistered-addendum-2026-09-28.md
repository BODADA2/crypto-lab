# Addendum pré-enregistré — vague insider economics (2026-09-28)

**Statut** : document d'amendement à la batterie gelée `docs/preregistered-tests-2026-09-28.md`.
Conformément à ses règles d'amendement : ce fichier est un **nouveau document daté** — la
batterie gelée n'est pas modifiée. Les trois tests ci-dessous sont rédigés **avant** toute
donnée propre ; deux sont *gated* (ne peuvent tourner qu'une fois la collecte spécifiée en
place). Règles R1–R8 de la batterie s'appliquent (interdiction de piocher, publication même
négative, double gate train+test, n≥30, médianes + IC 95 %).

Motivation : vague « insider economics » du 2026-09-28 (`docs/insider-economics-2026-09-28.md`).
H-DEV face + a montré un signal exploratoire (persistance du taux passé : ρ≈0,29 ; hot-devs
×1,9 sur données historiques biaisées) qui mérite un test propre ; H-BUNDLE et H-FEEFLOW
sont en attente de données.

---

### T-SERIAL-HOT — la persistance du taux de graduation par wallet

- **Hypothèse :** un wallet développeur dont le taux de graduation passé dépasse la base
  lance des tokens qui graduent plus que la base dans le futur (version corrigée de la
  leçon Deku : ce n'est pas la répétition qui compte, c'est le taux passé).
- **Protocole :** fenêtre train = jours 1–15 de la collecte propre, test = jours 16–30.
  Sur le train, pour chaque wallet avec ≥ 5 creates genuine : taux de graduation.
  « Hot » = taux > base train. Sur le test : taux de graduation des nouveaux tokens des
  wallets hot vs base test. Wallets avec ≥ 5 creates sur le train uniquement (pas de
  re-sélection sur le test).
- **Succès :** lift (taux hot / base test) avec IC 95 % excluant 1, n≥30 wallets hot.
- **Falsificateur :** IC incluant 1, ou lift < 1.
- **Caveat documenté :** la rotation des wallets atténue le signal (biais conservateur :
  il travaille *contre* la détection, pas pour).

### T-BUNDLE — le filtre d'exclusion par concentration des early buyers [GATED]

- **Gate :** ne peut tourner qu'une fois N≥100 tokens migrés avec leurs 50 premiers
  acheteurs collectés (spec : `docs/insider-economics-2026-09-28.md` §2).
- **Hypothèse :** un token dont les premiers achats sont concentrés (bundle) performe
  moins bien post-migration — filtre d'**exclusion** (insight Cupsey), pas de sélection.
- **Protocole :** par token : `top5_share` = part des 50 premiers achats captée par les
  5 plus gros wallets (seuil pré-enregistré : **≥ 40 %** = « bundled »).
  Groupes bundled / non-bundled, n≥30 chacun. Outcome : taux de tokens atteignant ×2
  post-migration sur données propres (médianes + IC 95 %) ; secondaire : drawdown max 24 h.
- **Succès :** taux ×2 des bundled significativement inférieur, IC de la différence
  excluant 0, même sens train/test.
- **Falsificateur :** pas de différence, ou différence en sens inverse.

### T-FEEFLOW — le pattern « encaisse puis relance » [GATED]

- **Gate :** ne peut tourner qu'une fois les retraits de creator fees collectés
  (spec : `docs/insider-economics-2026-09-28.md` §3 : bénéficiaire des fees via la
  transaction de création Helius + historique du wallet).
- **Hypothèse :** un créateur qui retire ses fees < 24 h avant de relancer un token
  lance un token qui gradue différemment de la base (sens non pré-spécifié : le test
  tranche, il ne parie pas).
- **Protocole :** paires (wallet, create) avec withdraw<24h avant le create vs creates
  témoins du même wallet sans withdraw récent ; appariement par wallet ; n≥30 paires.
  Outcome : taux de graduation, médianes + IC 95 %.
- **Succès :** différence avec IC excluant 0, même sens train/test.
- **Falsificateur :** pas de différence.

---

*Addendum rédigé le 2026-09-28, avant toute donnée propre. Ne modifie pas la batterie gelée.*
