# Pré-enregistrement — stratégies memecoins (S1, S3)

**Figé le 25 septembre 2026, avant tout résultat.** Ce document et `lab/backtest/preregistered.ts` ne doivent pas être
modifiés avant le verdict. La date du commit GitHub sert de preuve.

## Pourquoi

Trois robots MNQ/NQ testés sur 7 ans n'ont montré aucun avantage réel une fois les frais payés (gains ÷ pertes entre 1,02
et 1,13). La littérature (Fetna 2026, SSRN 7428398) montre que tester beaucoup de réglages sur les mêmes données fabrique
des « gagnants » par hasard. Règle retenue : **on fixe tout d'avance, on teste une fois, on accepte le verdict.**

## Ce qui est testé

| Stratégie | Version | Entrée | Sortie |
|---|---|---|---|
| S1 volume anormal | s1-volume@1.0.0, paramètres par défaut | signal BUY → achat à l'observation suivante | +50 % / −25 % / après 24 observations (~6 h) |
| S3 post-migration | s3-migration@1.0.0, paramètres par défaut | signal BUY → achat à l'observation suivante | +80 % / −30 % / après 96 observations (~24 h) |

**Exclues :** S2 (aucune liste de wallets suivis validée à ce jour) et S4 (IVB transposé : la stratégie d'origine a échoué
sur 7 ans de MNQ, et l'ORB ne survit pas aux frais selon Fetna 2026).

## Conditions de simulation

- Données : `data/history/` (DexScreener, ~15 min) et `data/scans/pump-*.jsonl` (migrations PumpPortal), collectées par
  GitHub Actions depuis le 24 septembre 2026. Aucune donnée future : la migration n'est connue qu'après son horodatage.
- Taille : 15 $ US (≈ 20 $ CAD) par trade. Liquidité minimale 20 000 $.
- Frais : 1,3 % aller-retour (1 % plateforme + 0,3 % swap) + glissement estimé taille ÷ liquidité, plafonné à 3 % par côté.
- **Anti-biais :** une position ouverte sur un token qui disparaît des données (> 2 h avant la fin) compte **−100 %**.

## Périodes

- **A :** du début de la collecte au 5 octobre 2026 inclus.
- **B :** du 6 octobre au 16 octobre 2026. Verdict calculé le **17 octobre 2026** (workflow `verdict.yml`).

## Critères (sur A **et** sur B, séparément)

1. Au moins **30 trades** (sinon : NON CONCLUANT).
2. **Gains ÷ pertes ≥ 1,3** (plus exigeant que pour les futures : les fills memecoins sont plus incertains).
3. **Espérance par trade > 0** après frais.

## Décisions fixées d'avance

- **RETENUE** (A et B passent) → 4 semaines de plus en paper, en temps réel. Argent réel seulement ensuite, sur décision
  d'Hervé, dans les limites du Risk Engine (wallet séparé, plafonds, kill switch).
- **REJETÉE** → abandonnée. Aucun nouveau réglage sur ces mêmes données.
- **NON CONCLUANT** → la collecte continue ; aucun argent réel ; un nouveau pré-enregistrement sera nécessaire.

## Amendement 1 — 25 septembre 2026 (collecte seulement, règles de test inchangées)

Fait **avant tout résultat de gain ou de perte**. Seuls des comptages de données ont été regardés (277 tokens suivis,
240 migrations vues, dont 21 seulement suivies en prix ; ~20 % des tokens échantillonnés au-dessus de 20 000 $ de
liquidité). Deux défauts de collecte auraient rendu le test inutile ou biaisé :

1. **Tokens suivis abandonnés.** La collecte n'interrogeait que 60 tokens par cycle : les tokens suivis au-delà du
   60e cessaient d'être observés, et la règle « token disparu = −100 % » les aurait comptés comme des pertes totales
   alors qu'ils existaient toujours. Correction : jusqu'à 300 tokens par cycle, dans cet ordre : nouveaux, migrés depuis
   moins de 48 h, puis suivis encore vivants (liquidité ≥ 5 000 $, vus depuis ≤ 7 jours), du plus liquide au moins liquide.
2. **Migrations sans prix.** S3 ne peut trader que des tokens migrés dont on a la série de prix ; ils n'étaient pas
   ajoutés à la liste observée. Correction : chaque migration vue est observée pendant 48 h au moins. L'écoute PumpPortal
   passe de 5 à 10 minutes par cycle (dépôt public : minutes GitHub Actions illimitées).

Stratégies, paramètres, frais, périodes, critères et décisions : **inchangés.** Les données de la période A antérieures à
cet amendement restent incluses telles quelles.

## Hypothèse 2 — S1 sur Robinhood Chain (ajoutée le 25 septembre 2026, avant toute donnée)

Demande d'Hervé : tester le trading de memecoins **basé sur le volume** sur Robinhood Chain (L2 lancée le 1er juillet
2026, où les memecoins dominent le volume DEX). Aucune donnée Robinhood n'existait dans le lab au moment de cet ajout.

- **Stratégie :** S1 exactement comme ci-dessus (s1-volume@1.0.0, paramètres par défaut, +50 % / −25 % / ~6 h).
- **Données :** `data-rh/` (DexScreener `chainId = robinhood`, mêmes endpoints et même rythme de 15 min que Solana,
  même règle de suivi que l'amendement 1). Séparées de `data/` : le test Solana n'est pas touché.
- **Frais :** mêmes 1,3 % aller-retour + glissement plafonné à 3 % par côté (prudent : le gaz L2 est faible, mais
  beaucoup de pools Uniswap prennent 1 %).
- **Périodes, critères, anti-biais, décisions :** identiques (A jusqu'au 5 octobre, B du 6 au 16 octobre, ≥ 30 trades,
  gains ÷ pertes ≥ 1,3, espérance > 0, token disparu = −100 %). La période A sera courte (collecte à partir du
  26 septembre) : un NON CONCLUANT est possible et sera accepté tel quel.
- **Verdict :** `lab/backtest/preregistered-rh.ts` (réutilise `preregistered.ts` sans le modifier), le 17 octobre 2026,
  dans `reports/verdict-memecoins-robinhood-2026-10-17.md`.

## Hypothèses 3 et 4 — calls Telegram « Gambles MadApes » (ajoutées le 25 septembre 2026, avant toute donnée)

Demande d'Hervé : s'inspirer du canal Telegram public **Gambles 🎲 MadApes** (@mad_apes_gambles, ~100 000 abonnés) et
« mixer » avec nos signaux de volume. Observation du 25 septembre (lecture seule) : environ un message sur cinq est un
call (nom, chaîne SOL / RBH / autre, adresse du contrat) ; les autres sont des « updates » qui ne citent que les gagnants
(×3, ×10, ×13…). Les perdants n'étant jamais mentionnés, le vrai taux de réussite est inconnu : c'est ce qu'on mesure.
Aucun prix de ces calls n'avait été regardé au moment de cet ajout.

- **Collecte :** `lab/collect/calls.ts`, toutes les 15 min, dans `data-calls/` (séparé : les hypothèses 1–2 ne sont pas
  touchées). Lecture de l'aperçu web public `t.me/s/mad_apes_gambles` (aucun compte, aucun message envoyé). Un call =
  un message contenant une adresse de contrat ; seule la **première apparition** de chaque adresse vue par le collecteur
  compte. Chaînes testées : Solana et Robinhood Chain ; les autres (ARC…) sont comptées mais pas testées. Chaque call est
  suivi 7 jours sur DexScreener, même mort.
- **H3 — copier les calls.** Achat à l'observation qui suit la première observation postérieure au call (≈ 15 à 30 min
  de retard : ce qu'un abonné peut réellement faire). Sorties de S3 : **+80 % / −30 % / ~24 h**.
- **H4 — call + volume (le « mix »).** Dans les **2 h** après le call, première observation où le volume 5 min
  ≥ **5 % de la liquidité** et les achats 5 min ≥ les ventes 5 min (seuils de S1, déjà figés), puis achat à
  l'observation suivante. Sorties de S1 : **+50 % / −25 % / ~6 h**. Aucun paramètre nouveau n'est inventé.
- **Frais, taille, liquidité minimale 20 000 $, « disparu = −100 % », périodes A/B, critères, décisions :** identiques
  aux hypothèses 1–2.
- **Tableau descriptif (hors verdict) :** part des calls ayant touché ×2 dans les 24 h et part valant moins de la
  moitié 24 h après — pour comparer aux « ×13 » affichés par le canal.
- **Verdict :** `lab/backtest/preregistered-calls.ts`, le 17 octobre 2026, dans `reports/verdict-calls-2026-10-17.md`.
