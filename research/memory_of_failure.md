# MEMORY OF FAILURE — hypothèses tuées (Master R&D)

Format : WHY_KILLED / DATA / RESULT / REASON / NEXT_LESSON. Ne jamais refaire la même expérience sous un nouveau nom.

## H-NARR v2 — Un catalyst narratif (dimension « catalyst » du score) prédit la migration
- WHY_KILLED : lift ×1,03 (buckets catalyst fort/faible/aucun) ; MFE médian ×1,20 vs ×1,15 — ne prédit rien
- DATA : ['catalyst_score'] → migration_12h
- RESULT : n/a / holdout : n/a
- REASON : famille G (legacy J)
- NEXT_LESSON : aucune — verdict gelé (NO ACTION)

## H-EXIT — Sortie en 3 paliers (+40/+100/trailing) bat la sortie unique à +40 %
- WHY_KILLED : espérances proches (65,9 vs 70,0), win rates 44,3 % vs 25,5 %, moyennes dominées par ticks aberrants, médianes négatives ; n=752/variante
- DATA : ['exit_ladder'] → pnl_net
- RESULT : n/a / holdout : n/a
- REASON : famille R (legacy G)
- NEXT_LESSON : aucune — famille momentum/scalp officiellement ABANDONNÉE (H-DECOMP, règle d'arrêt)

## H-CHASE — Rejeter les entrées « verticales » (chase ≥ +50 % sur 3 barres) améliore le scalp
- WHY_KILLED : A n=445, B n=387 ; médiane −1,0 % vs −1,3 % (bruit), win rate 47,4 % vs 45,5 %. Twist : entrées verticales (n=154) MFE médian ×1,25 vs ×1,20 — le momentum persiste à court terme
- DATA : ['chase_3bar'] → pnl_net
- RESULT : n/a / holdout : n/a
- REASON : famille R (legacy G)
- NEXT_LESSON : aucune — verdict gelé (NO ACTION)

## H-DEVBUY — devBuy (mise initiale du dev) prédit la migration, monotone en seuil
- WHY_KILLED : FALSIFIÉE — le 10,73 % (n=3 114, seuil 1,3 SOL) était l'artefact late-discovery (607 creates tardifs à tuple figé 100 % migrés). Sur genuine : 1,66 % IC[1,19–2,13] vs base 1,42 %, monotonicité plate (1,51→1,54→1,50) ; quartiles n=41 619
- DATA : ['devBuy_sol'] → migration_12h
- RESULT : n/a / holdout : n/a
- REASON : famille F (legacy E)
- NEXT_LESSON : aucune — verdict gelé. Leçon : le walk-forward ne protège pas d'un biais présent dans toute la fenêtre.

## H-FILTRE-COMBINE — (ipfs.io ET devBuy ≥ 1,3 SOL) → ~10 % migration, tradable
- WHY_KILLED : ABANDONNÉ — artefact (607 late-discovery à 100 % migrés) ; genuine 1,54 %/1,66 % ; breakeven impossible (gagnants ×4,5 < ×5,2–×10 requis) ; walk-forward train 24–25 / test 26–27, n test=36 196
- DATA : ['uri_domain', 'devBuy_sol'] → migration_12h
- RESULT : n/a / holdout : n/a
- REASON : famille F (legacy E)
- NEXT_LESSON : aucune — verdict gelé

## H-TOOL — Le domaine d'URI (outil de déploiement) prédit la migration
- WHY_KILLED : Résiduel faible, NON ACTIONNABLE — sur genuine : uxento 0,45 %, j7 0,87 % vs ipfs.io 1,31 % ; lift d'exclusion 1,09× (nul) ; ipfs.io n=27 478
- DATA : ['uri_domain'] → migration_12h
- RESULT : n/a / holdout : n/a
- REASON : famille F (legacy E)
- NEXT_LESSON : aucune — verdict gelé

## H-CURVE v1 — La progression sur la courbe (buckets 0–25/50/75/100 %) prédit migration/MFE
- WHY_KILLED : NON CONCLUANT — biais de sélection massif (46,4 % de migrés suivis vs 2,37 % de base) ; n=2 727
- DATA : ['curve_progress'] → migration / MFE
- RESULT : n/a / holdout : n/a
- REASON : famille C (legacy B)
- NEXT_LESSON : aucune — tuée par le biais de sélection (données inutilisables pour cette question)

## H-CURVE v2 — marketCapSol au create prédit la migration
- WHY_KILLED : REDONDANT — mcapSol@create ≈ 30 + devBuy : même mécanisme que H-DEVBUY, pas un edge indépendant ; n=41 619
- DATA : ['mcapSol_create'] → migration_12h
- RESULT : n/a / holdout : n/a
- REASON : famille C (legacy B)
- NEXT_LESSON : aucune — verdict gelé

## H-CALLTRACK — Les channels d'appels ont un taux de migration mesurable (alpha vs exit liquidity)
- WHY_KILLED : FALSIFIÉE (timing) — 27,5 % brut mais 10/11 avaient DÉJÀ migré avant le call : indicateur retardé, pas prédicteur ; 40 calls SOL uniques, 11 migrés
- DATA : ['call_latency', 'call_migrated'] → migration
- RESULT : n/a / holdout : n/a
- REASON : famille G (legacy J)
- NEXT_LESSON : aucune — verdict gelé

## H-SECOND-FILTRE — Parmi les migrés, l'imbalance acheteuse m5 > +0,2 au 1er snapshot post-migration sépare les gagnants (≥×2)
- WHY_KILLED : ABANDONNÉ — signal réel (25,3 % vs 3,2 %, IC disjoints, carac. n=558 dont 45 gagnants) mais INEXÉCUTABLE : net médian test −75,78 % (test n=43), entrée médiane ~30 min après migration (achète le top), MFE médian 0 %
- DATA : ['imbalance_m5_postmig'] → gain_x2
- RESULT : n/a / holdout : n/a
- REASON : famille I (legacy I)
- NEXT_LESSON : aucune — verdict gelé

## H-FRESH — Vitesse d'entrée mesurée via timestamp de première observation
- WHY_KILLED : MESURÉE, CONFONDUE — mesure la latence du scan, pas la naissance du token
- DATA : ['first_obs_latency'] → pnl_net
- RESULT : n/a / holdout : n/a
- REASON : famille C (legacy B)
- NEXT_LESSON : aucune — proxy invalide, ne pas utiliser

## H-HEDGE-1 — Sortie d'urgence −8 %/6b améliore le scalp H-EXIT
- WHY_KILLED : NO ACTION — Δ médiane −1,29 % IC[−3,68 ; −0,18] (DÉGRADATION significative), 3,5 % des gagnants coupés
- DATA : ['emergency_exit'] → pnl_net
- RESULT : n/a / holdout : n/a
- REASON : famille R (legacy G)
- NEXT_LESSON : aucune — verdict gelé

## H-HEDGE-4 — Portfolio 50/50 scalp+runner > scalp seul
- WHY_KILLED : FALSIFIÉ (découverte) — esp. −11,98 %, DD 116 ×mise, pire que V1 seule
- DATA : ['portfolio_50_50'] → pnl_net
- RESULT : n/a / holdout : n/a
- REASON : famille R (legacy G)
- NEXT_LESSON : aucune — verdict gelé

## H-REF-MOM — Stratégie de référence « regime-filtered momentum » bat les variantes H-EXIT au score composite
- WHY_KILLED : RÉFÉRENCE NON ACTIONNABLE — esp. wins. −9,79 % IC[−17,32 ; −2,11], médiane −23,24 %, n=238. Le filtre de régime n'a RIEN exclu (0 jour famine/frénésie sur 5 j) : composante « regime » intestable ici ; momentum pur sous-performe le chase mixte (V3 : −6,15 %)
- DATA : ['chase_entry', 'regime_filter'] → score_composite
- RESULT : n/a / holdout : n/a
- REASON : famille C (legacy B)
- NEXT_LESSON : aucune — référence conservée comme borne, verdict gelé

## H-DECOMP — L'espérance négative de H-REF-MOM vient d'un edge brut détruit par les coûts
- WHY_KILLED : FALSIFIÉE — NO EVIDENCE OF EDGE : brutRéel −8,92 % (significativement négatif), brutIdéal +2,70 % IC[−4,52 ; +12,34] non significatif, médiane −14,21 %. Hiérarchie : drift (−8,92 pts) ≫ frais (1,18) > slippage (0,29). RÈGLE D'ARRÊT DÉCLENCHÉE : arrêter l'optimisation de la famille momentum/scalp
- DATA : ['cost_decomposition'] → pnl_brut_vs_net
- RESULT : n/a / holdout : n/a
- REASON : famille C (legacy B)
- NEXT_LESSON : aucune — verdict gelé ; la famille momentum/scalp est abandonnée

## H-GLITCH — Le trade +4 939 704 % est un vrai moonshot capturable
- WHY_KILLED : FALSIFIÉE — mint SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3, prix 192 $ → 0,0038 $ → 192 $ (glitch décimal DexScreener), INCAPTURABLE. 1/242 trades, +20 412 pts à la moyenne brute. Les 31 autres « outliers » (MAE ≤ −90 %) sont de vraies morts. → filtre anti-tick-aberrant (≥100× vs voisins) ajouté au pipeline
- DATA : ['outlier_forensics'] → n/a
- RESULT : n/a / holdout : n/a
- REASON : famille R (legacy G)
- NEXT_LESSON : aucune — forensique close

## H-STOPGAP — Le stop-loss −20 % protège à −20 %
- WHY_KILLED : FALSIFIÉE — réalisé médian −37,1 % (gap −17,1 pts) ; 12,9 % des trades meurent à ≥ −90 % en une barre. La sortie d'urgence n'existe pas à cette granularité
- DATA : ['stop_loss'] → pnl_realise
- RESULT : n/a / holdout : n/a
- REASON : famille R (legacy G)
- NEXT_LESSON : aucune — verdict gelé

## H-PRED-LIQ-05 — 4 signaux liquidité indépendants
- WHY_KILLED : FALSIFIÉE : corrélations 0,37–0,79 → UNE SEULE dimension
- DATA : ['liqT0', 'turnoverH1', 'liqPerVolH1', 'mcLiq'] → Y_futur
- RESULT : n/a / holdout : n/a
- REASON : famille C (legacy B)
- NEXT_LESSON : aucune — ne pas traiter les 4 signaux comme indépendants

## H-PRED-TEMP-AGE — Jeunesse ⇒ Y
- WHY_KILLED : FALSIFIÉE directionnellement puis NO SIGNAL
- DATA : ['agePairMs', 'ageTokenMs'] → Y_futur
- RESULT : n/a / holdout : n/a
- REASON : famille P (legacy F)
- NEXT_LESSON : aucune — verdict gelé

## H-PRED-WAL-07 — Rétention à +5 min post-migration ⇒ Y / survie
- WHY_KILLED : NON MESURABLE — features sellersOver50/medianSoldFrac DÉPRÉCIÉES (fuite post-migration : mesurées à +5 min après t0, non observables à la décision ; interdites en Phase 2). Données quasi absentes (walletsCovered=0, échecs Helius −32015)
- DATA : ['sellersOver50', 'medianSoldFrac'] → Y_futur / survie
- RESULT : n/a / holdout : n/a
- REASON : famille B (legacy A)
- NEXT_LESSON : ne pas ressusciter les features dépréciées ; en suspens jusqu’à une définition point-in-time (≤ t0)

## H-S1-E3 — Le danger (DD50 binaire) est plus prédictible que le rendement
- WHY_KILLED : KILLED — diff=−0,34/−0,30/−0,40 (danger MOINS prédictible) ; le binaire jette la magnitude. Leçon : préférer ddMax24h continu.
- DATA : ['turnoverM5', 'liqT0'] → P_DD50_24h
- RESULT : n/a / holdout : n/a
- REASON : famille R (legacy G)
- NEXT_LESSON : aucune — hypothèse tuée ; utiliser ddMax24h continu en famille G

## H-FLIP-01 — Cascade de liquidations long (E1) → reversal par absorption plutôt que continuation
- WHY_KILLED : FALSIFIÉE — P(reversal_4h)=81,6 % (n=49) mais indiscernable des big-down appariées (85,7 %, p=0,44) et < hasard (94,9 %, p≈0) ; médiane Y@1h signée = −32,09 bp, IC95 [−59,1 ; −12,9] strictement négatif (falsifier pré-enregistré) ; NET médian −52 bp à coûts 20 bp ; moitiés discovery stables (p=0,87)
- DATA : ['liq_cascade_down_E1'] → Y@1h / reversal_4h (Binance perp SOLUSDT 1m, discovery 2026-04-04→07-16, holdout jamais lu)
- RESULT : EXP-2026-09-28-flip-s1-flip01 / holdout : gelé, non mesuré
- REASON : famille S (Branch B)
- NEXT_LESSON : tester la continuation comme hypothèse alternative (H-FLIP-04/07) ; un taux de reversal absolu élevé n'est pas un edge sans baseline appariée ; E1/E2 = proxies (pas de prints de liquidations), ~68 % sans collapse OI concurrent

## H-FLIP-10 — Lead-lag inter-venues : la dislocation apparaît d'abord sur une venue (HL vs Binance)
- WHY_KILLED : NULL sur le proxy testable — perp↔spot 1m (n=113) : médiane lag 0 s, IQR [0;0], 102/113 synchrones à 1 min, test des signes p=0,13, pas de leader stable ; volet HL↔Binance NON TESTABLE (DATA ISSUE : HL 5m < 17 j d'historique, hors discovery)
- DATA : ['cross_venue_lag'] → leader_venue (Binance perp vs spot 1m, discovery)
- RESULT : EXP-2026-09-28-flip-s1-flip10 / holdout : gelé, non mesuré
- REASON : famille S (Branch B)
- NEXT_LESSON : ne pas confondre « volet HL non testable » avec « preuve d'absence côté HL » ; timestamps spot data.vision en microsecondes (normaliser en ms)
