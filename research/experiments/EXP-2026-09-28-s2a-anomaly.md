# EXP-2026-09-28-s2a-anomaly — Famille O : ANOMALY_SCORE

- **hypothesis_id** : H-S2A-O
- **question** : La distance au régime du jour (anomalie) prédit-elle survie, drawdown, rendements — et dans quelle direction (ANOMALY ≠ OPPORTUNITY par défaut) ?
- **method** :
  1. Régime = jour calendaire du t0 ; z robustes leave-one-out (0,6745·(x−médiane)/MAD) sur log(liqT0), log(turnoverH1), log(buys+sells m5+1). Cohorte jour < 10 → null. `lab/research-sprint2/divergence/anomaly.ts`.
  2. `ANOMALY` = moyenne des |z| disponibles (≥ 2 dims). Testé aussi en |z| et signé par dimension, sur Y@1h/Y@6h/Y@24h/ddMax24h/dd50 (Spearman + déciles + bootstrap).
  3. Les deux directions lues dans les déciles (D10 = forte anomalie).
- **data** : discovery, 503 tokens (ANOMALY calculable sur 503 ; jour 2026-09-24 n=13 → régime null). **Biais : tokens chauds → borne OPTIMISTE.**
- **leakage_status** : **PASS** — régime leave-one-out intra-discovery, features ≤ t0ms, labels post-t0 nettoyés. Holdout jamais lu.
- **results** :
  - À première vue spectaculaire : ANOMALY → Y@6h r=0,457 (p=1×10⁻¹¹, n=177), D10−D1=+0,752 IC [0,424 ; 1,127] ; ANOMALY → dd50 r=−0,253 (p=1,6×10⁻⁶, n=339), mortalité par décile 88/88/88/91/65/71/79/53/50/**21 %**. Direction = « anomalie → MEILLEURS outcomes » (opportunité, pas risque).
  - **Autopsie (WHERE IS THE TRAP ?)** :
    - H1 « deux côtés » réfutée : z_liq ∈ [−1,20 ; +6,98] (p5=−1,00, p95=+4,52) → **|z| est un effet de niveau unilatéral** (queue haute de liquidité), pas une anomalie bilatérale. Les déciles du z signé sont monotones croissants (D1 −0,23 … D10 +0,25), pas en U.
    - **Redondance E1** : spearman(logLiqT0, Y@6h)=0,409 vs |z_liq|=0,510 — le « régime » n'ajoute qu'un raffinement au **niveau de liquidité déjà connu** (E1 : HR=0,691/doublement). ANOMALY → dd50 redit la même chose sur une autre cible.
    - **Biais de sélection des labels** : spearman(|z_liq|, has_Y@6h)=**0,294** (n=503) — les tokens à forte liquidité sont davantage suivis à 6 h ; l'échantillon Y@6h (n=177/503) sur-représente la queue haute → effet gonflé sur Y@6h.
    - Le composite mélange trois dims dont z_velo_signe → dd50 = +0,220 (la frénésie prédit les morts — H-PRED-FLOW-01, direction opposée) : l'agrégat |z| masque des directions contradictoires.
  - Stabilité : pumpswap/raydium cohérents sur Y@6h (+0,55/+0,50) mais c'est la stabilité de l'effet liquidité, pas d'une anomalie.
- **verdict** : **NULL** comme signal d'anomalie — l'effet mesuré = niveau de liquidité (E1) + sélection de couverture des labels. Le raffinement « relatif au régime du jour » est réel mais marginal (+0,10 de corrélation de rang) et ne constitue pas une famille.

## Fiche triage

- **HYPOTHESIS** : H-S2A-O — la distance z au régime prédit Y/survie/DD.
- **N** : 503 (ANOMALY) ; 177 (Y@6h) ; 339 (dd50).
- **EFFECT** : ANOMALY → Y@6h r=0,457 ; → dd50 r=−0,253 (mortalité D10 = 21 % vs D1 = 88 %).
- **P-VALUE** : 1×10⁻¹¹ (Y@6h), 1,6×10⁻⁶ (dd50).
- **CI** : D10−D1 Y@6h [0,424 ; 1,127] ; dd50 [−0,821 ; −0,489].
- **OOS EFFECT** : non mesuré — holdout gelé.
- **COHORT STABILITY** : stable sur pumpswap/raydium (mais c'est l'effet liqT0).
- **TIME STABILITY** : stable (1re moitié r=0,49, 2e r=0,39 sur Y@6h).
- **LEAKAGE STATUS** : PASS.
- **VERDICT** : **NULL** (famille) — pas de signal d'anomalie distinct ; re-découverte de l'effet liquidité E1 + biais de couverture des labels.

## GUT_HYPOTHESIS (priorité de recherche, pas un fait)

- **OBSERVATION** : |z_liq| relatif au régime du jour (r=0,510) bat le log-liqT0 brut (r=0,409) sur Y@6h, même après l'autopsie.
- **WHY_IT_FEELS_UNUSUAL** : la normalisation par le jour calendaire ne devrait rien apporter si seule la liquidité absolue comptait.
- **POSSIBLE_EXPLANATIONS** : H1 — la barre du « chaud » se déplace selon le jour (jour calme : 30k$ de liq = énorme ; jour de frénésie : 30k$ = banal) ; H2 — artefact résiduel de la sélection de couverture ; H3 — bruit (Δr=0,10 sur n=177).
- **DATA_CHECKS** : re-mesurer sur `data/track-unbiased/` (couverture uniforme, pas de sélection) ; comparer rang intra-jour vs valeur brute à n ≥ 200.
- **TEST** : Spearman(rang intra-jour de liqT0, Y@6h) vs Spearman(log-liqT0, Y@6h), test de différence dépendante.
- **EXPECTED_DIRECTION** : si H1 est vraie, le rang intra-jour gagne sur données propres.
- **KILL_CRITERION** : Δr ≤ 0 sur données à couverture uniforme → tuer.

## Suivi suggéré

- Ne pas construire de famille « anomalie » ; conserver « rang de liquidité intra-jour » comme feature candidate à tester contre liqT0 brut sur données propres.
- Corriger le biais de couverture des labels Y@6h/Y@24h dans les analyses futures (cf. M-005) : rapporter systématiquement P(label couvert | feature).
