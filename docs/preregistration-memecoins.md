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
