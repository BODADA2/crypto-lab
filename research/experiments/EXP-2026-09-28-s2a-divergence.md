# EXP-2026-09-28-s2a-divergence — Famille K : DIVERGENCE_FEATURES

- **hypothesis_id** : H-S2A-K
- **question** : L'incohérence entre prix, liquidité, volume et transactions prédit-elle les rendements futurs / la survie ?
- **method** :
  1. Features par token (discovery, SKHY exclu) — `lab/research-sprint2/divergence/features.ts` :
     - K1 `mismatchPre` : signe(Δprix) vs signe(Δliq), leg pré-t0 → t0 (100 % pré-t0, zéro leakage) ;
     - K2 `mismatchPost` : t0 → 1er tick post-t0 (médiane 13,7 min) — labels recalculés depuis le tick d'observation (`labelsFrom`, aucun chevauchement feature/label) ;
     - K3 `logMcapLiq` = log2(mcap/liq) à t0, testé en |z| et signé vs population discovery ;
     - K4 `frictionH1` = turnoverH1 / (|chgH1| + 1pp) — volume sans mouvement de prix ;
     - K5 `logVolPerTrade` = log(volM5 / nb trades m5), testé en |z| et signé.
  2. Cibles : Y@1h / Y@6h / Y@24h / ddMax24h / dd50_24h (binaire). Spearman + p, déciles (D10−D1 + IC95 % bootstrap), cohortes dex + moitiés temporelles.
  3. **Contrainte de cadence** : les snapshots sont espacés de ~13–14 min (médiane 3 ticks/token) → les fenêtres « 60 s / 5 min post-t0 » du mandat ont une couverture de **0 %** ; remplacées par les legs pré-t0 → t0 et t0 → 1er tick post-t0.
- **data** : `data/history/*.jsonl` (2926 séries), lecture seule, univers **discovery** (503 tokens avec t0). **Biais déclaré : tokens chauds → borne OPTIMISTE.**
- **leakage_status** : **PASS** — K1 100 % pré-t0 ; K2 labels depuis le tick d'observation (ticks ≤ featMs exclus) ; K3/K4/K5 mesurés au snapshot t0 ; prix nettoyés par `aberrantMask`. Holdout (hash ≥ 75) jamais lu.
- **results** :
  - **K1** : 36 legs pré-t0 → t0 mesurables, **0 incohérent / 36** (100 % cohérents). Le leg d'entrée en t0 est mécaniquement cohérent (t0 = traversée du seuil de liquidité sur une vague d'achats). → **NULL** (le phénomène n'existe pas pré-t0).
  - **K2** : 476 legs post-t0, 11 incohérents. Incohérents vs cohérents sur Y@1h (depuis obs.) : Δ = **−0,304**, IC95 % [−0,620 ; −0,011] (n+=11, n−=265). Direction suggestive (l'incohérence prix/liq → −30 pp à 1 h) mais **n=11 ≪ 30** → **UNSTABLE** (à re-tester sur données propres, n ≥ 30).
  - **K3** : |z| → Y@6h r=0,521 (p=8,9×10⁻¹⁶, n=176), D10−D1=+0,854 IC [0,514 ; 1,229] — spectaculaire, **mais** :
    - corr(logMcapLiq, logLiqT0)=0,896 et corr(logMcapLiq, logMcapT0)=0,965 → proxy confondu du niveau de mcap/liquidité ;
    - stratifié par liqT0, le signe **s'inverse** : r=−0,362 (liq ≤ médiane) vs r=+0,354 (liq > médiane) → artefact de mélange (Simpson) ;
    - instable par dex : pumpswap +0,58 / raydium +0,35 / **other −0,84** (n=10).
    → **KILLED** (pas une incohérence prédictive ; proxy confondu).
  - **K4** : → Y@6h r=−0,417 (p=1,3×10⁻⁹) **mais** → ddMax24h r=**+0,378** (p=7,2×10⁻¹⁴) — directions contradictoires selon la cible ; corr(frictionH1, logLiqT0)=**−0,654** (redondant avec 1/liqT0, i.e. l'effet E1 déguisé) ; signe inversé sur raydium (Y@6h : −0,45 pumpswap vs **+0,52** raydium). → **NULL** (redondant + instable).
  - **K5** : signé → dd50 r=−0,201 (p=1,8×10⁻⁴, n=337), D10−D1=−0,247 IC [−0,431 ; −0,040] (gros trades → moins de morts) ; mais stratifié par liqT0 : r=0,029 (bas) vs 0,229 (haut) ; corr avec liqT0 = −0,300. → **NEAR_MISS** (effet faible, dépendant du strate ; re-test avec contrôle liqT0 requis).
- **verdict** : **aucune divergence PROMISING**. K1 NULL, K2 UNSTABLE (n=11), K3 KILLED (confounding), K4 NULL (redondant E1), K5 NEAR_MISS.

## Fiche triage

| Feature | N | Effet | p | CI D10−D1 | Stabilité | Verdict |
|---|---|---|---|---|---|---|
| K1 mismatchPre | 36 (0 incoh.) | — | — | — | — | **NULL** |
| K2 mismatchPost → Y@1h | 11/265 | Δ=−0,304 | CI exclut 0 de justesse | n insuffisant | **UNSTABLE** |
| K3 \|z\| mcap/liq → Y@6h | 176 | r=0,521 | 8,9×10⁻¹⁶ | [0,514;1,229] | signe inversé par strate/dex | **KILLED** |
| K4 friction → Y@6h / ddMax | 177/339 | r=−0,417/+0,378 | <10⁻⁸ | contradictoire | signe inversé raydium | **NULL** |
| K5 signé vol/trade → dd50 | 337 | r=−0,201 | 1,8×10⁻⁴ | [−0,431;−0,040] | strate-dépendant | **NEAR_MISS** |

- **HYPOTHESIS** : H-S2A-K — l'incohérence prix/liq/volume prédit Y/survie.
- **OOS EFFECT** : non mesuré — holdout gelé.
- **COHORT STABILITY** : instable — K3 et K4 changent de signe sur « other »/raydium.
- **TIME STABILITY** : 1re/2e moitiés cohérentes en signe pour K3/K4 sur Y@6h (mais le niveau est un artefact).
- **LEAKAGE STATUS** : PASS (voir method).
- **VERDICT** : **famille K : pas de signal d'incohérence exploitable** (1 NULL, 1 UNSTABLE petit-n, 1 KILLED, 1 NULL redondant, 1 NEAR_MISS).

## Suivi suggéré

- K2 : re-test sur `data/track-unbiased/` après 30 j (n ≥ 30 d'incohérences requis avant toute conclusion).
- K5 : test avec contrôle de liqT0 (régression partielle) sur données propres.
- Ne pas réutiliser mcap/liq comme « anomalie » : c'est un proxy confondu du niveau de mcap.
