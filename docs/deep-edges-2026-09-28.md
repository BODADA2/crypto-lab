# Deep edges — recherche nocturne 2026-09-28

**Mandat :** trouver des edges non-obvious à partir des premiers principes, là où personne
ne regarde. Pas de code, pas de données fabriquées, pas de conclusion sans test —
uniquement des hypothèses falsifiables.

**Données réelles disponibles (vérifiées ce soir) :**
- `data/scans/pump-*.jsonl` : 5 jours, **68 229 creates / 2 223 migrates** → taux de
  migration de base **≈ 3,3 %**. Chaque create porte : `traderPublicKey`, `solAmount`,
  `marketCapSol`, `pool` (pump/bonk), et en `raw` : `initialBuy`, `vSolInBondingCurve`,
  `vTokensInBondingCurve`, `bondingCurveKey`, `uri` (domaine de métadonnées),
  `is_mayhem_mode`.
- `data/history/` : 2 727 tokens × ~11,4 snapshots (prix, liquidité, volume, txns
  buys/sells, marketCapUsd) — trajectoires exploitables.
- `data/mintinfo/` : 850 tokens avec `top10Pct` + `topAccounts` (adresse, owner, pct,
  excluded) — distribution des holders, pas du vent.
- `data-snipe/` : 226 tokens avec `devBuySol` + checks prix à 60 s / 300 s.
- `data-calls/` + `data-channels/` : 122 calls Telegram avec `postedAt` vs `seenAt`.
- `data/earlybuyers/` : 1 seul fichier (clairsemé — insuffisant seul).

**Découvertes de cartographie (non analysées à ce jour) :**
- **30,6 % des creates** portent `metadata.j7tracker.io` comme domaine d'URI (612/2000
  échantillonnés) — près d'un tiers du flux vient d'un seul outil de déploiement.
- `is_mayhem_mode` = **22 %** des creates ; pool `bonk` présent (~3 %).
- Domaines d'URI : ipfs.io, j7tracker, uxento, launchblitz, pinata… = **empreinte digitale
  de l'outil de déploiement**, collectée mais jamais exploitée.

---

## I. Ce que les verdicts négatifs nous ont appris (où l'edge N'EST PAS)

**H-NARR v2 tué (lift x1,03) :** l'attention mesurée côté créateurs (noms/symboles) ne
prédit pas la migration. Leçon structurelle : **l'argent bouge, les mots ne bougent pas.**
Toute hypothèse future doit être basée sur le comportement des wallets, pas sur du
texte. Ce n'est plus un slogan, c'est un résultat empirique.

**H-CHASE tué (entrées verticales : MFE x1,25 vs x1,20) :** le momentum persiste à
court terme. Leçon structurelle : **la bonding curve EST une machine à momentum par
construction** — chaque achat fait monter le prix mécaniquement, sans carnet d'ordres
pour absorber. « Ne pas acheter la verticale » est une sagesse populaire qui ignore
le mécanisme. La vraie question n'est pas « est-ce vertical ? » mais
**« où en est la courbe ? »** (distance au seuil de graduation).

**H-EXIT non concluant (médianes négatives) :** le problème n'est ni l'entrée ni la
sortie — c'est le **taux de base de 3,3 %**. L'edge doit venir de la SÉLECTION
(filtrage), pas du timing. Cela valide l'architecture filtre-d'abord du labo.

**Méta-principe :** tout edge tactique (timing, patterns de chandeliers) se fait
arbitrer ; les edges structurels (mathématiques de la courbe, frais, incitations)
persistent parce qu'ils sont **constitutifs du jeu**.

---

## II. Edges candidats — Tier 1 (testables cette semaine, signal élevé)

### E1. H-CURVE — la progression sur la bonding curve comme variable maîtresse
- **Idée :** la position d'un token sur sa courbe (x % du chemin vers la graduation)
  prédit mieux son destin que le prix, le momentum ou le narratif.
- **Pourquoi ça existerait :** la courbe est une fonction de prix **déterministe**.
  `marketCapSol / seuil` est donc une variable d'état exacte, pas un indicateur bruité.
  Conséquences mécaniques : upside restant borné et connu ; la migration est un
  changement de régime de liquidité prévisible ; en fin de courbe, on achète à des
  entrants déjà mécaniquement en profit (asymétrie vendeuse).
- **Test :** pour chaque token de `data/history`, calculer `progress =
  marketCapUsd(snapshot) / seuil_usd` au premier snapshot ; buckets
  [0-25 %, 25-50 %, 50-75 %, 75-100 %] ; mesurer taux de migration et MFE médian par
  bucket, walk-forward par jour (le seuil en USD est recalculé par jour pour absorber
  le prix du SOL). n≥30 par bucket.
- **Falsificateur :** taux de migration et MFE plats sur les 4 buckets.

### E2. H-TOOL — l'empreinte de l'outil de déploiement
- **Idée :** le domaine de l'URI de métadonnées (outil de déploiement : J7, uxento,
  launchblitz…) prédit le comportement du token.
- **Pourquoi ça existerait :** un outil de déploiement professionnel = un déployeur
  professionnel, souvent industrialisé (farms à tokens). 30 % du flux via un seul
  outil, c'est une concentration que personne ne modélise — les « pros du volume »
  ne sont pas les mêmes acteurs que le dev manuel occasionnel.
- **Test :** grouper les creates par domaine d'URI ; taux de migration par domaine
  (n≥30), walk-forward. Sous-test : `is_mayhem_mode` et `pool=bonk` comme buckets
  de régime.
- **Falsificateur :** taux de migration identiques entre domaines (IC 95 % qui se
  recouvrent).

### E3. H-DEVBUY — la mise du dev (skin in the game)
- **Idée :** la taille de l'achat initial du dev (`devBuySol`) prédit la migration.
- **Pourquoi ça existerait :** un dev qui met 2 SOL des siens a une fonction de
  payoff différente d'un dev qui met 0,05 SOL — le coût irrécupérable aligne les
  incitations (ou signale au minimum un acteur capitalisé, pas un farmeur jetable).
- **Test :** `data-snipe` (n=226) : buckets de `devBuySol` (terciles) → taux de
  migration + prix à 300 s vs p0. n≥30 par bucket.
- **Falsificateur :** aucune corrélation monotone entre devBuySol et outcomes.

### E4. H-POSTMIG — le chemin de prix autour de la migration
- **Idée :** il existe un pattern systématique du prix dans les ±60 min autour de
  l'événement `migrate` (spike puis fade, ou continuation).
- **Pourquoi ça existerait :** la migration est un **choc de liquidité mécanique** :
  le SOL et les tokens de la courbe sont déposés dans l'AMM, les snipers se
  positionnent, les détenteurs de la courbe prennent leurs profits. C'est le seul
  événement du cycle de vie d'un token qui est 100 % mécanique, pas sentimental.
- **Test :** joindre les `migrate` aux snapshots `data/history` par mint ; prix
  normalisé à t-60…t+60 min ; courbe moyenne + médiane ; tester fade systématique
  (règle d'évitement) ou spike (signal d'entrée). n≥30 migrates avec snapshots
  des deux côtés.
- **Falsificateur :** chemin moyen plat / variance dominant toute structure.

### E5. H-CALLTRACK — le palmarès des channels d'appels
- **Idée :** les channels Telegram d'appels ont un taux de migration mesurable —
  certains sont de l'alpha, d'autres de la liquidité de sortie.
- **Pourquoi ça existerait :** un « call » est une recommandation horodatée et
  vérifiable ex post. Personne ne tient le score — l'asymétrie d'information est
  dans l'agrégation, pas dans le call lui-même.
- **Test :** joindre les 122 calls (`data-calls`, `data-channels`) aux `migrate`
  par adresse/mint ; taux de migration des tokens appelés vs base 3,3 % ;
  par channel si n≥30, sinon poolé. Sous-test : `seenAt - postedAt` (latence) —
  la valeur d'un call décroît avec le retard de réception.
- **Falsificateur :** tokens appelés ≤ taux de base, ou latence sans effet.

---

## III. Tier 2 (testables, effort moyen)

### E6. H-CONC — la concentration à la naissance
- **Idée :** `top10Pct` au premier snapshot (`data/mintinfo`, n=850) prédit la
  migration — le « fair launch » a une prime mesurable.
- **Pourquoi :** une distribution large = plus de détenteurs indépendants à
  convaincre de vendre ; une concentration élevée = un seul acteur peut tuer le
  token. C'est la version statique et honnête de H-BUNDLE (dont la partie
  dynamique attend des données wallet).
- **Test :** buckets de top10Pct → taux de migration, n≥30, walk-forward.
- **Falsificateur :** pas de relation monotone.

### E7. H-TIME — les heures creuses
- **Idée :** le taux de migration varie selon l'heure UTC de création.
- **Pourquoi :** l'attention est une ressource rare et cyclique ; à 4h UTC la
  concurrence pour l'attention est minimale (mais les acteurs présents sont
  peut-être surtout des bots). Personne ne teste parce que c'est ennuyeux —
  exactement le genre d'endroit où un edge survit.
- **Test :** buckets horaires des creates (68k événements) → taux de migration
  par heure, test d'uniformité (chi²).
- **Falsificateur :** distribution uniforme.

### E8. H-LIQMIRAGE — le ratio volume/liquidité comme détecteur de manipulation
- **Idée :** un ratio volume/liquidité extrême (ex. 152 k$ de volume sur 3,5 k$ de
  liquidité, observé sur CNN) signale du wash trading ou un dump en cours.
- **Pourquoi :** sur une courbe/AMM peu profonde, un vrai volume déplace le prix
  violemment ; un gros volume SANS déplacement proportionnel = volume artificiel.
  C'est de la microstructure, pas du sentiment.
- **Test :** ratio `volume1h / liquidityUsd` au premier snapshot → distribution des
  rendements à 1h suivante ; le décile extrême sous-performe-t-il ?
- **Falsificateur :** pas de relation.

### E9. H-HALFLIFE — la demi-vie du narratif (second regard sur H-NARR v2)
- **Idée :** le lift du catalyst est >1 dans les premières heures puis <1 ensuite —
  H-NARR v2 a mesuré une moyenne plate (x1,03) qui masque peut-être une structure
  temporelle.
- **Pourquoi :** l'attention est périssable ; `narrativeDistance` existe déjà dans
  `score.weights.json` mais n'a jamais été backtestée en conditionnel.
- **Test :** refaire le backtest catalyst en bucketisant par `narrativeDistance`
  (≤6h, 6-24h, >24h) ; lift par bucket, n≥30.
- **Falsificateur :** lift plat sur les buckets — alors H-NARR v2 est enterré
  définitivement.

### E10. H-SERIAL — la décrépitude du déployeur en série
- **Idée :** via `traderPublicKey`, le N-ième token d'un déployeur migre moins bien
  que son premier (farm industrielle) — ou mieux (compétence).
- **Pourquoi :** les deux théories sont plausibles, d'où le test : la répétition
  révèle le type d'acteur. Version positive = H-DEV ; version négative jamais testée.
- **Test :** pour chaque `traderPublicKey` avec ≥5 creates, taux de migration du
  token n°1 vs n°5+ (apparié par acteur).
- **Falsificateur :** pas de différence.

### E11. H-MAGNET — le seuil comme aimant réflexif
- **Idée :** le taux de migration conditionnel (hazard rate) accélère de façon
  non linéaire près du seuil — parce que tout le monde connaît le seuil.
- **Pourquoi :** réflexivité : les snipers se concentrent sur les tokens proches
  de la graduation, ce qui les fait graduer (prophétie autoréalisatrice). C'est
  l'envers structurel de H-CURVE.
- **Test :** hazard de migration par tranche de `marketCapSol` (snapshots
  history) — le hazard est-il convexe près du seuil ?
- **Falsificateur :** hazard linéaire ou plat.

### E12. H-COPYCAT — la réutilisation de métadonnées
- **Idée :** un URI de métadonnées réutilisé sur plusieurs mints (= déployeur
  paresseux / farm) prédit l'échec.
- **Pourquoi :** le copier-coller de métadonnées est la signature d'une
  industrialisation sans conviction — l'inverse du soin artisanal.
- **Test :** grouper les creates par `uri` ; taux de migration 1ère utilisation
  vs 2e+ (n≥30).
- **Falsificateur :** pas de différence.

---

## IV. Tier 3 (potentiel élevé, nouvelles données requises — ne pas tester à l'aveugle)

### E13. H-FEEFLOW — suivre les bénéficiaires de fees, pas les traders
- **Idée :** les wallets qui reçoivent le plus de creator fees sont les déployeurs
  des tokens à plus gros volume réel — en temps réel.
- **Pourquoi c'est structurel :** les fees ne mentent pas : on ne touche des fees
  que si le volume est réel (le wash trading coûte des fees à son auteur). C'est
  le « smart money » révélé par la comptabilité, pas par les P&L affichés.
  PAID l'a rendu visible : les bénéficiaires sont publics et incités à shiller
  (le catalyst devient semi-prévisible : qui reçoit le plus a le plus intérêt
  à amplifier).
- **Données requises :** mapping bénéficiaires de fees (programmes pump.fun /
  PAID) — non collecté aujourd'hui. **Ne pas approximer.**

### E14. H-EXTRACT — le taux d'extraction du dev
- **Idée :** extraction totale du dev = achat initial + fees créateur estimées
  (1 % du volume) + ventes des wallets liés ; au-delà de X % du SOL de la courbe,
  le token est mathématiquement un rug en cours.
- **Pourquoi c'est structurel :** borne comptable, pas opinion.
- **Données requises :** trades par wallet (partiellement payant via PumpPortal)
  + estimation des fees. Partiellement approchable via `initialBuy` + volume.

### E15. H-SNIPER — les acheteurs du même slot
- **Idée :** les wallets qui achètent dans le même slot que la création
  (`earlybuyers` : rank 0, même `blockTime`) = bundle/sniper → exclusion.
- **Pourquoi :** un humain ne peut pas acheter au slot 0 ; c'est une signature
  mécanique de bot/bundle.
- **Données requises :** collecte `earlybuyers` systématique (1 seul fichier
  aujourd'hui — insuffisant).

---

## V. Vérités structurelles (contraintes de design, pas des trades)

1. **Le hurdle frais+MEV :** ~6-10 % de handicap par round-trip à 50 $
   (déjà au red team). Tout edge tactique doit d'abord battre ce hurdle —
   cela tue à lui seul la plupart des idées haute-fréquence.
2. **Le taux de base (3,3 %) :** même un « prédicteur de graduation parfait »
   n'a de valeur que si sa précision dépasse massivement ce taux après coûts.
3. **La maison gagne toujours :** launchpads (1 % pump.fun), Raydium, validateurs
   Jito (tips MEV), outils (J7 et ses frais) — tous gagnent quand les traders
   perdent. **Suivre l'argent, pas le narratif** : la question n'est pas « quel
   token va monter » mais « où va le flux de fees ».
4. **Le catalyst PAID est une nouveauté structurelle :** des fees versées à des
   non-cryptos qui ont une incitation financière à amplifier = le catalyst
   n'est plus purement aléatoire sur ce launchpad. À surveiller (H-MULTI),
   pas à modéliser sans données.

---

## VI. Ordre de test recommandé (potentiel × faisabilité)

| # | Hypothèse | Potentiel | Effort | Données |
|---|---|---|---|---|
| 1 | E1 H-CURVE | ★★★★★ | moyen | ✅ dispo |
| 2 | E2 H-TOOL | ★★★★ | faible | ✅ dispo |
| 3 | E4 H-POSTMIG | ★★★★ | moyen | ✅ dispo |
| 4 | E3 H-DEVBUY | ★★★★ | faible | ✅ dispo (n=226) |
| 5 | E5 H-CALLTRACK | ★★★ | faible-moyen | ✅ dispo (n=122) |
| 6 | E9 H-HALFLIFE | ★★★ | faible | ✅ dispo |
| 7 | E6 H-CONC | ★★★ | faible | ✅ dispo (n=850) |
| 8 | E11 H-MAGNET | ★★★ | moyen | ✅ dispo |
| 9 | E7 H-TIME | ★★ | faible | ✅ dispo |
| 10 | E8 H-LIQMIRAGE | ★★ | faible | ✅ dispo |
| 11 | E10 H-SERIAL | ★★ | moyen | ✅ dispo |
| 12 | E12 H-COPYCAT | ★★ | faible | ✅ dispo |
| 13 | E13 H-FEEFLOW | ★★★★★ | collecte à bâtir | ❌ à collecter |
| 14 | E14 H-EXTRACT | ★★★★ | collecte partielle | ⚠️ partiel |
| 15 | E15 H-SNIPER | ★★★ | collecte à bâtir | ❌ clairsemé |

**Règle d'arrêt :** tout test suit le protocole du labo (walk-forward strict,
n≥30 par bucket, médianes pas moyennes, biais documentés). Un edge qui ne survit
pas au premier backtest propre rejoint H-NARR v2 et H-CHASE au cimetière —
c'est le processus qui est l'edge, pas chaque hypothèse.
