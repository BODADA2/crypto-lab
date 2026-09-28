# MYSTERY QUEUE — anomalies inexpliquées (Master R&D)

Format : WHAT_HAPPENED / WHY_UNEXPECTED / POSSIBLE_EXPLANATIONS / DATA_NEEDED / TEST_PRIORITY (1-5)

## M-001 — Décile D1 (liq la plus basse) survit MIEUX que D2–D8 (E1)
- WHAT : S(24h) D1=0,228 vs <0,11 pour D2–D8, alors que le Cox est monotone (HR=0,691/doublement).
- WHY_UNEXPECTED : la relation monotone du modèle est contredite en déciles à l'extrême bas.
- H1 : tokens quasi-illiquides que personne ne trade → pas de dump possible. H2 : artefact de composition (D1 = tokens morts-nés jamais découverts). H3 : biais de mesure liqT0 sur micro-caps.
- DATA_NEEDED : composition de D1 (snapshots, volume, découverte).
- LIEN S2D (28/09) : le filtre F_LIQT0 dégrade le P10 de −1,34 pt @6h — cohérent : la queue basse-liq contient à la fois des survivants improbables (D1) et des catastrophes. Filtrer sur liqT0 coupe les deux.
- PRIORITY : 4 — peut révéler un mécanisme (illiquidité = protection) ou un biais.

## M-002 — 14/61 sets pré-t0 vides (E4)
- WHAT : 23 % des mints avec cache early buyers n'ont AUCUN buyer pré-t0.
- WHY_UNEXPECTED : un mint sans aucun acheteur avant t0 est suspect.
- H1 : t0 scan trop tardif (découverte après les premiers achats — biais late-discovery). H2 : échec de pagination (-32015, troncation silencieuse). H3 : mints réellement sans activité (spam).
- DATA_NEEDED : comparer t0 scan vs plus ancienne signature on-chain par mint.
- PRIORITY : 5 — data quality bloquante pour la famille B.

## M-003 — Glitches décimaux type SKHY : quelle fréquence réelle ? [RÉSOLUE 2026-09-28, EXP-s2a-glitchscan]
- WHAT : SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3 : 192 $ → 0,0038 $ → 192 $ (+4 939 704 % artificiel).
- WHY_UNEXPECTED : un seul cas trouvé par hasard ; la prévalence systématique est inconnue.
- H1 : cas isolé (erreur DexScreener ponctuelle). H2 : pattern récurrent sur certains DEX/agrégateurs.
- RÉSOLUTION : scan exhaustif 35 262 ticks / 2 926 mints → **3 ticks (0,0085 %), 3 mints (0,10 %)** — spikes mono-tick avec retour exact (×4 922 à ×19 949), tous sur raydium/orca/meteora (0 pumpswap). **H1 CONFIRMÉE.** Impact labels discovery : nul (0 label modifié). Garde `aberrantMask` conservée par principe.
- DATA_NEEDED : rien de plus.
- PRIORITY : 0 — close.

## M-004 — Paradoxe H-HEDGE-EXPOSURE sur V10
- WHAT : le disjoncteur améliore E_w sur V1 mais le DÉTÉRIORE sur V10 (−9,79→−16,02 %) en coupant l'exposition du trade outlier.
- WHY_UNEXPECTED : un mécanisme réducteur de risque qui amplifie la perte sur une variante.
- H1 : le disjoncteur coupe aussi les queues positives (coût d'opportunité asymétrique). H2 : V10 dépend d'un seul outlier — le résultat V10 lui-même est fragile.
- DATA_NEEDED : distribution des trades coupés (gagnants vs perdants) par variante.
- PRIORITY : 3 — famille hedge gelée, valeur méthodologique.

## M-005 — Wallets « systématiques » : early buyers dans 13–22 mints discovery (S2C-E)
- WHAT : 8 wallets apparaissent comme early buyers pré-t0 dans 13 à 22 des 34 mints discovery (ex. `27HFmP7ccLad…` : 22 mints ; `GoU9mTtFwQyC…` : 19). Outcomes mixtes (survie et non-survie), donc PAS une cohorte parfaite.
- WHY_UNEXPECTED : une poignée d'adresses capte une part énorme des early buys sur tokens chauds — infrastructure de snipe automatisée ? collecteur biaisé ? Ces wallets dominent l'incidence (76 récurrents / 886).
- H1 : bots de snipe généralistes (multi-mints, pas de sélection). H2 : artefact du biais « tokens chauds » (le collecteur ne voit que les mints où ces bots opèrent). H3 : wallets liés à l'infrastructure du labo (à exclure : vérifier contre nos propres adresses).
- DATA_NEEDED : distribution temporelle de leurs buys (slot 0 ? latence ?), montants, pattern inter-mints ; exclure nos adresses connues.
- PRIORITY : 4 — si ce sont des bots génériques, leur « qualité historique » (H-S2C-E2) est mécaniquement diluée ; si c'est un artefact, l'incidence est biaisée.
- SUSPICION : ne pas transformer « présent partout » en « smart money » — outcomes mixtes = pas de signal.

## M-007 — Couverture des labels Y@6h/Y@24h corrélée aux features (biais de sélection)
- WHAT : seuls 177/503 tokens discovery ont un label Y@6h (46 pour Y@24h). P(couverture Y@6h | |z_liq|) : ρ=+0,294 — les tokens à forte liquidité sont systématiquement plus suivis à 6 h.
- WHY_UNEXPECTED : le biais « tokens chauds » documenté porte sur la SÉLECTION de l'univers ; ici c'est la COUVERTURE DU LABEL elle-même qui est sélectionnée, ce qui gonfle mécaniquement tout effet mesuré sur Y@6h/Y@24h (ex. ANOMALY → Y@6h r=0,457).
- H1 : les tokens qui meurent vite cessent d'être scannés (attrition de suivi). H2 : le collecteur privilégie les tokens « intéressants » (boucle de rétroaction). H3 : les deux.
- DATA_NEEDED : pour chaque token sans Y@6h : dernier tick post-t0, cause (mort du token vs arrêt du suivi) ; comparer dd50 des couverts vs non-couverts.
- PRIORITY : 4 — affecte TOUTES les mesures sur Y@6h/Y@24h (sprint 1 inclus). En attendant : toujours rapporter P(label couvert | feature) à côté de l'effet.

## M-006 — Momentum 120min : pente full-sample qui disparaît dans les moitiés (S2B-L)
- WHAT : Spearman(dirPrice_120min → Y@1h) = +0,256 (p=0,0002) sur l'échantillon complet, mais early ρ=+0,067 (nul) et late ρ=+0,350 avec D1–D9 plat dans LES DEUX moitiés — la pente monotone D1→D9 n'existe que dans l'agrégat.
- WHY_UNEXPECTED : un signal « significatif » qui n'existe dans aucune sous-période = effet de composition (Simpson-like) probable : les distributions de dirPrice diffèrent entre moitiés.
- H1 : composition — early et late ont des distributions dirPrice différentes et des Y moyens différents, l'agrégation fabrique la pente. H2 : régime — le momentum existe vraiment mais seulement en régime « late » (à tester : interaction avec le régime de marché).
- DATA_NEEDED : distributions de dirPrice par moitié ; re-test sur track-unbiased/ avec interaction régime×dirPrice pré-enregistrée.
- PRIORITY : 3 — valeur méthodologique (piège classique) ; le reversal D10, lui, est stable dans les deux moitiés.
