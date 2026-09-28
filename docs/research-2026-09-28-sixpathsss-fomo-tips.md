# Fiche de recherche — « Beginner Tips Trading On FOMO » (TikTok @sixpathsss)

**Source :** vidéo TikTok de démonstration écran (~2 min 21), compte @sixpathsss.
Titre affiché : « Beginner Tips Trading On FOMO ». Plateforme montrée : terminal
« FOMO » (trading Solana : onglets Alerts/Tokens/Leaderboard/Feed, copy/notifs de traders).

**Biais de lecture :** la vidéo se termine par un code promo affilié (« Use Code : ayosix —
10% OFF ON ALL THE FEES TRADING ON THIS PLATFORM. LINK IN THE BIO... BEFORE I DELETE IT »).
C'est un contenu marketing pour la plateforme. P&L affichés non vérifiés
(ex. @fmpumpguy : +$1,281,904.83, 14K trades — sélectionnés pour l'accroche
« YOU WANNA GO FROM THIS TO THIS »).

## Les 6 tips montrés
1. **Onglet « Graduating »** : surveiller les tokens qui graduent (sortie de bonding curve)
   pour séparer « the good from the trash ».
2. **Ne pas acheter les charts paraboliques** : « charts like this that go all the way up...
   it will drop. Do not put your bread in here, you will lose it. »
3. **Vérifier le narratif sur X** : aller sur le Twitter du projet, comprendre « what they about ».
   Règle : « IF YOU DON'T UNDERSTAND THE NARRATIVE, DO NOT PUT YOUR MONEY IN IT ».
4. **BubbleMaps en continu** : copier le contrat, coller sur bubblemaps.io (v2), vérifier
   combien le dev possède et **regarder les clusters**. Point clé : re-vérifier pendant le trade,
   « it does change as you're in a trade ».
5. **Double feed** : feed des traders + feed des tokens côte à côte (« split bottom »).
6. **Leaderboard comme boussole, pas copy-trading** : « I wouldn't advise copy trading them
   but you can use them as a rule of thumb » — trouver des petits traders (< 1 000 followers),
   les suivre, recevoir des notifs live à chaque investissement (montants d'entrée/sortie visibles).

## Le cas d'école « fred » (le twist)
- Token « fred », créé il y a 32 min, chart « solid buyers and sellers ».
- Narratif vérifié sur X : dev **Kiro @Kirodev7**, personnage grenouille verte « just fred »,
  posts sur Pepe/Moodeng/Doge, « pretty trustworthy Twitter developer », suivi par
  Robinhood Army et d'autres. → Surimpression : « **(Or So We Thought 😂 Wait For What Happens)** ».
- BubbleMaps initial : « looks pretty healthy » (Cluster 1 à 9.35 %).
- Puis : « SOMEONE JUST SOLD A CHUNK TON. THAT'S NOT NORMAL. » Refresh de BubbleMaps :
  **un cluster passe à 29.74 % (132 wallets)** — « they up the price, they up their
  percentages, they up the clusters. That is why it's dropping... drops straight to the ground.
  As you can see it's dead. »

## Hypothèses labo
- **H-BUNDLE — VALIDÉ par la pratique pro** : la détection de bundles/clusters est le filtre
  central des traders sérieux, pas un gadget. **Détail opérationnel nouveau** : le check n'est
  pas unique à l'entrée — les clusters bougent pendant le trade (« it does change as you're
  in a trade »). À intégrer : re-vérification périodique du bundle sur positions ouvertes.
  Rappel : notre H-BUNDLE est implémenté mais attend toujours des données wallet réelles.
- **Filtre narratif = EXCLUSION, pas prédiction** : la règle « don't understand → don't buy »
  est un filtre négatif. C'est cohérent avec notre verdict NO ACTION sur H-NARR v2 :
  le narratif ne prédit pas les gagnants, mais son incompréhension justifie de passer.
- **H-CHASE (piste nouvelle, pas de code)** : pas d'entrée sur bougie verticale / après +X %
  en N minutes. À opérationnaliser (ex. prix > X % au-dessus de la MM 15 min) puis backtester
  n≥30 avant toute implémentation.
- **H-DEV, extension piste** : au registre de *deployers*, ajouter un registre de *traders*
  sharps à faible audience (< 1 000 followers) avec notifs — version systématique du tip n°6.
- **Leçon pour le compte N (protocole deux comptes)** : l'exemple « fred » montre que
  l'analyse narrative seule échoue — le dev avait l'air « trustworthy » et a quand même
  largué un cluster de 29.74 %. Seule la donnée on-chain a vu venir le dump. Valide le
  point 5 du filtre N : **H-BLOCK/H-BUNDLE s'appliquent même aux trades narratifs**.
