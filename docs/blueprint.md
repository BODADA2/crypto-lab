---
title: "Crypto Lab — Blueprint"
subtitle: "1 000 $ CAD · 5 mois · un laboratoire qui cherche, teste, exécute dans des limites et apprend"
author: "Lead AI Strategist, Researcher, Developer & Operator — pour Hervé Rakotoniaina"
date: "24 septembre 2026"
lang: fr-CA
---

# 0. Lecture honnête du mandat

1 000 $ CAD, cinq mois, cible 10 000 $. Le multiple demandé est ×10. Voici ce que ce chiffre implique, sans détour.

Un ×10 en cinq mois par le trading discrétionnaire de memecoins avec 700 $ de capital de trading exige, avec des coûts aller-retour de 3 à 5 % par position et des tailles de 50 $, soit **une** position qui fait ×40 (loterie), soit une suite d'une trentaine de gains de +20 % sans série de pertes (aucun trader ne fait ça avec des memecoins). Le trading ne sera donc pas le moteur principal du résultat ; il sera le **terrain d'apprentissage** du laboratoire, avec des limites qui rendent la ruine impossible et le signal mesurable.

Ce qui peut réellement produire un multiple avec ce capital, ce sont des activités où l'argent n'est pas l'intrant principal : les **frais de création** sur les launchpads (un lancement qui fait 1 M$ de volume rapporte ~2 500 $ sans vendre un token), les **outils** que le lab construit (le robot Tap Tap, le vérificateur, le moniteur) vendus ou monétisés, et le **lancement pour d'autres** (des communautés qui ont une audience et pas de pipeline). Ces moteurs ont une propriété que le trading n'a pas : un échec coûte du temps, pas du capital.

Le système ci-dessous est donc construit pour trois choses : ne jamais perdre plus que ce qui est écrit dans la politique de risque ; transformer chaque action en donnée ; et chercher en permanence ce que nous ne voyons pas encore. La cible de 10 000 $ n'entre dans aucun calcul du système. Elle sert à une chose : refuser les activités dont le plafond est trop bas pour compter.

# 1. Ce que nous avons raté

## 1.1 Les idées qui revenaient sans être exécutées

Trois idées sont revenues dans presque chaque document depuis le début et aucune n'a été testée : **détecter un volume anormal avant la viralité** (MemeScan, septembre), **suivre des wallets performants** (Cupsey, Kimchi, Orangie), et **le vérificateur comme produit** (Tap Tap). Nous avons écrit un pipeline de création de token complet, trois audits et quatre documents stratégiques, mais pas une seule ligne de backtest. Le laboratoire a produit de la certitude technique là où il fallait de l'incertitude mesurée.

## 1.2 Hypothèses jamais testées

| Hypothèse | Où elle apparaît | Comment la tester (maintenant possible) |
|---|---|---|
| Un z-score de volume 5 min prédit une hausse dans l'heure | MemeScan, brief Make/Airtable | `lab/backtest/harness.ts` sur `data/history/` collecté 2 semaines ; n ≥ 30 ; espérance nette de coûts |
| Les wallets présents tôt sur plusieurs tokens gradués sont prédictifs | Cupsey/Kimchi, « smart money » | `lab/signals/earlybuyers.ts` : overlap sur 100 dernières migrations, puis suivi prospectif 30 jours |
| Le personnage aye-aye produit du partage organique | $AYE, plan Phase 0 | Phase 0 sans token, joins/1 000 vues |
| Un lancement honnête convertit une audience en volume | $AYE V2 | Phase 1 seulement après Phase 0 |
| Le contenu IA « drôle » fonctionne | Content engine | Tests A/B hooks, partages/1 000 vues |
| Les frais créateur d'un launchpad sont un revenu significatif | Analyse V2 | Un lancement instrumenté, frais mesurés vs heures |

## 1.3 Nos erreurs probables

Nous avons confondu « sûr » et « bon » : 130 tests protègent la baisse, aucun n'augmente la hausse. Nous avons choisi Token-2022 pour la testabilité, à contre-courant des launchpads. Nous avons pensé la traction comme un problème de contenu ; c'est un problème de conversations. Nous avons traité le trading comme un sujet à part, alors que le même moniteur, les mêmes données et le même vérificateur servent les deux. Et nous avons dimensionné le travail humain sans plafond, pour une seule personne aux études.

## 1.4 Signaux sous-estimés

- **Le modèle « frais au créateur »** (pump.fun 0,30 % sur la courbe, Bags.fm, Believe, LaunchLab, Burn & Earn de Raydium) : c'est un changement structurel de qui gagne de l'argent sur un memecoin. Nous l'avons vu tard et seulement pour $AYE.
- **Le narratif « outils pour développeurs IA »** : le token GAS (framework multi-agents de Steve Yegge) a fait +500 % et 109 M$ de volume en 24 h sur Bags.fm en 2026, sans animal ni politique. Nous construisons exactement ce genre d'outils ; nous ne l'avons pas relié à un narratif.
- **PumpPortal offre gratuitement le flux temps réel des créations et des migrations** : c'est le point d'entrée du signal « avant la popularité » que MemeScan cherchait à travers Make.com.
- **Dune est passé en lecture seule** pour les comptes gratuits (10 septembre 2026) : le backtest « facile » sur SQL n'existe plus ; il faut collecter nous-mêmes.
- **X n'a plus de palier gratuit** : la veille narrative devra passer par Reddit, Telegram Bot API, DexScreener (boosts, trending metas), GitHub et les noms des tokens créés.

## 1.5 Hypothèses testables du laboratoire (les cinq premières)

1. **H-VOL** : « Un token de plus de 10 min et 20 k$ de liquidité dont le volume 5 min dépasse 3 écarts-types de sa moyenne mobile a une espérance nette positive à 60 min avec TP +40 % / SL −25 %. » Test : 30 jours de collecte, backtest, puis paper trading 30 jours.
2. **H-EARLY** : « Un wallet présent dans les 50 premiers acheteurs d'au moins 3 tokens gradués sur les 100 derniers est plus souvent présent tôt sur les prochains gradués que le hasard. » Test : overlap rétrospectif, puis suivi prospectif.
3. **H-NARR** : « Un terme dont la fréquence dans les noms de tokens créés en 24 h est ×5 vs 7 jours précède de 24–72 h un pic de volume sur les tokens de ce thème. » Test : `signals/narrative.ts` + volumes DexScreener.
4. **H-FEES** : « Un lancement honnête avec 150 membres préalables produit ≥ 100 k$ de volume en 72 h et ≥ 250 $ de frais créateur. » Test : Phase 0 puis Phase 1 de $AYE.
5. **H-TOOL** : « Un robot de vérification gratuit avec personnalité acquiert ≥ 300 utilisateurs en 30 jours sans publicité. » Test : @AyeTapTap.

# 2. Ce que je ferais si je repartais de zéro

Je commencerais par la **donnée**, pas par le token : deux semaines de collecte automatique (créations, migrations, volumes, boosts, Reddit, GitHub) pour avoir un historique à interroger. Je construirais le **vérificateur** le premier jour, parce qu'il sert au trading, au lancement et à l'acquisition. Je lancerais le **robot Telegram** la première semaine, comme produit d'appel et capteur de demande. Je ferais du **paper trading** dès la deuxième semaine, avec le Risk Engine en place avant le premier dollar. Je ne créerais un token que pour une communauté qui existe déjà, et je prendrais les frais créateur plutôt qu'une allocation. Je plafonnerais mon temps à 10 h par semaine et j'écrirais la date de KILL de chaque expérience avant de la commencer. Enfin, je chercherais chaque semaine un mécanisme que personne dans nos documents n'a nommé, et je l'écrirais dans le journal même si je ne le teste pas.

C'est exactement l'ordre du plan de cinq mois (section 14). Le laboratoire livré aujourd'hui exécute déjà les points 1, 2 et 4.

# 3. Capital et moteurs de rendement

| Poche | Montant | Usage | Plafond de perte |
|---|---|---|---|
| Trading (paper 30 j, puis live) | 700 $ CAD | Positions de 50 $ max, 4 simultanées, 200 $ d'exposition | 70 $/jour, 140 $/semaine, drawdown 35 % → arrêt |
| Opérations | 300 $ CAD | Illustration, DexScreener Enhanced Token Info (299 $ US, à décider), domaine, dev buy d'un lancement | Dépenses par paliers conditionnels |

Trois moteurs, classés par asymétrie (coût d'un échec vs plafond d'un succès) :

1. **Frais et outils** (coût : temps ; plafond : élevé). Lancements instrumentés avec frais créateur ; Tap Tap comme produit ; « launch-as-a-service » pour des communautés existantes (créateurs, groupes Telegram, projets qui veulent un lancement propre) en échange d'une part des frais créateur. Le pipeline memecoin-lab (vérificateur, moniteur, site, checklist) est déjà l'outil de cette offre.
2. **Trading sur signaux mesurés** (coût : capital borné ; plafond : moyen). Uniquement des stratégies dont le backtest et le paper montrent une espérance nette positive sur n ≥ 30.
3. **Découverte narrative** (coût : temps ; plafond : variable). Repérer un thème 24–72 h avant le marché et choisir entre lancer, trader ou ne rien faire.

# 4. Données et connecteurs

Contrainte vérifiée aujourd'hui : depuis l'environnement où Claude travaille, seules les API GitHub sont accessibles ; DexScreener, Helius, Birdeye, pump.fun, Jupiter, Reddit, Telegram sont bloqués. La collecte doit donc tourner **ailleurs** (GitHub Actions gratuit, ou ta machine) et déposer ses résultats dans un dépôt GitHub que Claude lit. C'est l'architecture livrée.

| Source | Rôle | Plan gratuit (vérifié 24/09/2026) | Permission | État |
|---|---|---|---|---|
| DexScreener API | Paires, volumes, liquidité, boosts, trending metas, profils | 60 req/min, sans clé | READ ONLY | Collecteur livré |
| PumpPortal WebSocket | Créations et migrations pump.fun en temps réel | Créations/migrations gratuites ; trades payants (0,01 SOL / 10 k événements) | READ ONLY | Collecteur livré |
| Helius RPC | Autorités de mint, extensions, top holders, early buyers, historique de wallet | 1 M crédits/mois, 10 req/s ; webhooks probablement payants | READ ONLY | Collecteur livré (clé à créer) |
| Jupiter API | Prix, devis, swap | 1 req/s gratuit | READ (prix) / EXECUTION (swap, machine d'Hervé seulement) | Client livré (stub testé, jamais appelé en test) |
| Reddit API | Posts r/solana, r/CryptoMoonShots, r/memecoins | ~100 req/min | READ ONLY | Collecteur livré |
| GitHub API | Repos « solana » en tendance (signal narratif dev), et **le dépôt du lab lui-même** | 5 000 req/h authentifié | READ (veille) / WRITE (briefs, intents, journal) | Livré ; dépôt à créer |
| Telegram Bot API | Alertes, robot Tap Tap, lecture des canaux où le bot est admin | Gratuit | WRITE (alertes) ; READ limité | Alertes via moniteur existant ; robot à construire |
| Solana Tracker | Données pump.fun REST | 10 000 req/mois, 3 req/s | READ ONLY | Optionnel, non branché |
| CoinGecko / CMC | Macro, prix SOL, dominance | 30 req/min (démo) / 10 k crédits/mois | READ ONLY | À brancher (brief MARKET) |
| Banque du Canada | Taux USD/CAD | Gratuit | READ ONLY | Utilisé par l'exécuteur |
| RugCheck | Score de risque tiers (recoupement) | Gratuit via site ; API à vérifier | READ ONLY | Lien dans le vérificateur |
| Make.com | Relais Telegram/Airtable, webhooks | Plan gratuit limité | WRITE (notifications) | Webhook prévu dans le moniteur |
| Supabase | Base de données du lab si `data/` devient trop gros | 2 projets gratuits | WRITE (collecteurs) / READ (Claude via connecteur) | Aucun projet créé ; à décider |

**Sources manquantes et pourquoi elles compteraient** : **X** (le narratif memecoin naît sur X ; l'API est passée au paiement à l'usage — remplacé partiellement par les noms de tokens créés, les boosts DexScreener et Reddit ; un compte humain qui lit X reste nécessaire, 15 min par jour) ; **Dune** (lecture seule depuis le 10 septembre 2026 ; nous collectons notre propre historique) ; **Nansen/Arkham** (labels « smart money » payants ; notre `earlybuyers.ts` en est une version maison, à valider) ; **Birdeye** (quotas gratuits non confirmés ; utile pour l'historique OHLCV des tokens, à tester) ; **FOMO** (fomo.family est une plateforme de social trading ; l'API tierce fomoapi.io résout des identités sociales en wallets — intéressant pour H-EARLY, non officiel, à évaluer avec prudence).

# 5. Architecture multi-agents

Un agent = une fonction, une entrée, une sortie dans le dépôt, une cadence, et une liste d'interdits. Aucun agent ne lit la sortie d'un autre comme une instruction. Aucun agent n'a de clé.

| Agent | Fonction | Entrées | Sorties | Cadence | Ne peut pas |
|---|---|---|---|---|---|
| **SCOUT** | Nouvelles opportunités : tokens, launchpads, outils, mécanismes | PumpPortal, DexScreener profils/boosts, GitHub trending, Reddit | `data/scans/`, `journal/opportunites.jsonl` | 15 min (collecte) / quotidien (synthèse) | Conclure ; acheter |
| **ON-CHAIN ANALYST** | Autorités, extensions, top 10, early buyers, flux de wallets | Helius, `data/tokens/` | `data/tokens/*.json`, `data/wallets/*.json` | 15 min (pré-filtré), quotidien (wallets) | Inventer une valeur manquante (écrit UNKNOWN) |
| **NARRATIVE ANALYST** | Termes en accélération, thèmes, migrations de communautés | Noms de tokens 24 h, Reddit, GitHub, trending metas | `data/narratives/` | Quotidien | Utiliser X sans compte |
| **RED TEAM** | Détruire chaque thèse avant décision | Intents proposés, thèses du brief | Section RISKS, veto écrit | À chaque intent et chaque lancement | Être ignoré : un veto non levé par Hervé = NO ACTION |
| **DEVELOPER** | Outils, collecteurs, tests, dashboards | Journal, demandes | Code testé, jamais dans `lab/exec` sans re-scellement | Hebdomadaire | Modifier la politique ou le manifeste |
| **GROWTH** | Traction organique, communautés, robot Tap Tap, plan Phase 0 | Métriques Telegram, contenus | `growth/` (calendrier, métriques, UGC) | Quotidien (15 min humain) | Faux comptes, bots, paiements à des influenceurs |
| **TRADING AGENT** | Transforme un signal validé en intent | Signaux, backtests, journal | `intents/*.json` (BUY/SELL/NO_ACTION, thèse, invalidation, expiration) | Selon signaux | Exécuter ; dépasser la politique ; agir sans backtest n ≥ 30 |
| **RISK ENGINE** | Autoriser ou refuser | Intent, snapshot re-vérifié localement, ledger local, politique locale | Verdict + raisons | À chaque intent | Être contourné par le dépôt (voir garanties) |
| **MONITOR** | Surveillance 24/7 : positions, tokens lancés, alertes | RPC, DexScreener, ledger | Alertes Telegram, `alertes/` | 5 min | Décider |
| **LEARNING** | Résultats → hypothèses ; rapport hebdo | Ledger, journal, briefs | `journal/`, `reports/semaine-N.md` | Hebdomadaire | Changer une stratégie sur n < 10 |

**Séparation des responsabilités** : SCOUT et ON-CHAIN produisent des faits ; NARRATIVE et TRADING produisent des thèses ; RED TEAM produit des vetos ; RISK ENGINE produit des verdicts ; seul l'**Execution Engine** (sur ta machine) produit des transactions ; LEARNING ferme la boucle. Un fait, une thèse, un veto, un verdict et une transaction ne sont jamais écrits par le même agent.

# 6. DEV : ce qui mérite d'être construit

« Créer un token » n'est pas une opportunité. Ce qui en est une, c'est un mécanisme que les gros acteurs négligent parce qu'il est trop petit pour eux et trop technique pour les amateurs.

| Mécanisme | Pourquoi les gros le négligent | Ce que nous avons déjà | Ce qui manque |
|---|---|---|---|
| **Vérification gratuite avec personnalité** (Tap Tap) | Les outils de sécurité sont austères ; les memecoins sont drôles ; personne ne fait les deux | `verify`, moniteur, brand $AYE | Le robot Telegram (1 jour) |
| **Lancement instrumenté pour des communautés existantes** | Les launchpads vendent l'outil, pas le service ; les communautés ont l'audience, pas le pipeline | Pipeline complet, checklist, transparence, moniteur | Une offre en une page + 3 premiers clients (part des frais créateur) |
| **Frais créateur comme modèle** (pump.fun, Bags, Believe, LaunchLab, Burn & Earn) | Ils considèrent ça acquis ; les créateurs ne le comprennent pas | Analyse V2 | Un comparatif chiffré à jour et un tableau de bord des frais |
| **Narratif « outils IA pour développeurs »** | Ils cherchent des animaux ; le token GAS a montré qu'un framework d'agents peut porter 109 M$ de volume | Nous construisons des agents | Décider si l'un de nos outils mérite un token — seulement s'il a des utilisateurs avant |
| **Journal public de lab** | Personne ne publie ses échecs chiffrés | Journal, rapports hebdo | Publication (contenu + crédibilité + acquisition) |
| **Détection de lancements « bundlés »** | Outils payants ou fermés (GMGN) | early buyers, top 10 | Heuristique : N wallets financés par le même wallet dans les 2 minutes |

Règle d'or du DEV : un outil n'est construit que s'il sert au moins deux des trois moteurs (frais/outils, trading, découverte). Le robot Tap Tap sert aux trois.

# 7. TRADING : gouvernance et stratégies

## 7.1 Gouvernance (livrée et testée)

Claude propose (`intents/`), le Risk Engine autorise ou refuse (code pur, politique locale, ledger local chaîné, snapshot re-vérifié depuis ta machine), l'Execution Engine exécute (ta machine, ta clé, Jupiter). Le red team a prouvé quatre contournements critiques dans la première version (code du dépôt exécuté après `git pull`, ledger réécrit, snapshot forgé, kill retiré) ; les quatre sont corrigés et testés (222 tests). Ce qui reste hors de portée : une machine compromise, un RPC menteur, et la perte maximale d'une journée qui peut atteindre perte quotidienne + exposition ouverte + frais si tout s'effondre en même temps.

## 7.2 Trois stratégies candidates, chacune avec son red team

**S1 — Volume anormal (H-VOL).** Entrée sur z-score ≥ 3 avec filtres ; sortie TP +40 % / SL −25 % / time-stop 60 min. *Ce qui rendrait l'analyse fausse* : le volume anormal est souvent du wash trading ou un bundle ; le signal est visible par tous les bots en même temps ; le slippage réel dépasse le modèle. *Trop tard ?* : à 5 min de retard, probablement. *Risque de 100 %* : par position, oui (rug, freeze) ; d'où la re-vérification des autorités avant chaque ordre.

**S2 — Wallets récurrents (H-EARLY).** Suivre 20 wallets à récurrence prouvée ; entrer quand ≥ 2 achètent le même token dans les 10 min. *Fausse si* : les wallets sont des sybils d'un même acteur qui bundle ses propres lancements (le signal est alors la fraude elle-même) ; ils changent d'adresse ; ils vendent avant nous. *Données manipulables* : oui, c'est précisément le vecteur. *Ce qu'un trader expérimenté verrait* : la latence entre leur achat et le nôtre, et le fait qu'ils sont parfois le pump.

**S3 — Migration (graduation) avec profondeur.** Acheter juste après la migration d'un token dont la liquidité dépasse un seuil et dont le top 10 est sous 30 %, tenir 24 h max. *Fausse si* : la migration est le sommet (fréquent) ; aucune donnée publique fiable sur le rendement post-graduation n'a été trouvée — **c'est une hypothèse vide tant que nous ne l'avons pas mesurée**.

Aucune des trois n'est autorisée en live avant : backtest n ≥ 30 avec espérance nette > 0, puis 30 jours de paper avec le même verdict, puis revue red team écrite. Si le backtest est négatif : NO TRADE, et c'est un résultat.

# 8. Automatisation : ce qui l'est, ce qui ne peut pas l'être

| Étape | État | Où ça tourne | Si non automatisable, pourquoi |
|---|---|---|---|
| Collecte (DexScreener, PumpPortal, Reddit, GitHub, autorités via Helius) | Automatisée | GitHub Actions toutes les 15 min → `data/` | — |
| Analyse des signaux (volume, early buyers, narratifs) | Automatisée | GitHub Actions + Claude planifié | — |
| Comparaison / détection d'anomalies | Automatisée | `signals/`, moniteur | — |
| Coder et tester | Automatisée à 90 % | Agents DEVELOPER, vitest | Le scellement du code exécuté reste humain (sécurité) |
| Backtests | Automatisés | `backtest/harness.ts`, job quotidien | La conclusion reste humaine sous n < 30 |
| Brief du matin | Automatisé | Claude planifié (6 h) lit le dépôt, écrit `briefs/` | Sans dépôt GitHub, le brief est limité à la recherche web |
| Proposition d'intents | Automatisée | TRADING AGENT | Chaque intent expire en 30 min |
| Exécution | Automatisée **sur ta machine** | `lab/exec` en `--watch` | Ne peut pas tourner dans le cloud : clé privée et vérification locale ; c'est voulu |
| Alertes | Automatisées | Moniteur → Telegram/Make | — |
| Apprentissage hebdo | Automatisé (brouillon) | LEARNING → `reports/` | La décision de changer une stratégie est humaine |
| Lever un KILL | **Humain** | `~/.crypto-lab/KILL` | Un kill qui se lève seul n'est pas un kill |
| Sceller une nouvelle version du code | **Humain** | `seal.ts` après lecture du diff | Sinon Claude peut se réécrire lui-même |
| Toute dépense d'opérations, tout lancement, tout partenariat | **Humain** | — | Irréversible, réputationnel, légal |
| Lire X | **Humain (15 min/jour)** | — | API payante à l'usage ; un compte humain lit plus vite |

# 9. Permissions et sécurité de l'argent

- **Wallet séparé** : `~/.crypto-lab/keypair.json`, financé uniquement du montant de la poche trading, jamais ta clé principale. Le mode live exige `--live`, `EXECUTION_MODE=live`, cette clé, un vérificateur local (RPC) opérationnel, l'absence de KILL et un code scellé identique au manifeste.
- **Limites** : dans `~/.crypto-lab/risk.policy.json` (jamais dans le dépôt) — 50 $ par ordre, 200 $ d'exposition, 70 $/jour, 140 $/semaine, 35 % de drawdown, borne dure en lamports calculée sur le devis du moment.
- **Kill switch** : fichier `KILL` dans le dépôt (Claude peut le poser, jamais le lever : cliquet vers `~/.crypto-lab/KILL`), fichier local, ou variable d'environnement. Chaque cycle le revérifie avant chaque intent.
- **Logs** : ledger local chaîné HMAC (toute rupture arrête tout), export en lecture seule dans le dépôt, journal des hypothèses, brief quotidien.
- **Désactivation immédiate** : `touch ~/.crypto-lab/KILL` ou fermer le processus ; aucun ordre en attente ne survit à un redémarrage sans réévaluation.
- **Connecteurs** : tout en READ ONLY sauf GitHub (WRITE pour briefs, intents, journal), Telegram (WRITE pour alertes) et Jupiter (EXECUTION, ta machine seulement). Supabase : rien tant qu'un projet n'est pas créé, et alors WRITE pour les collecteurs, READ pour Claude.

# 10. Découverte continue

Chaque cycle cherche des avantages de quelques minutes ou heures, jamais de secondes (les bots gagnent les secondes).

| Signal cherché | Comment, avec les outils livrés | Fréquence |
|---|---|---|
| Wallets qui apparaissent avant les mouvements | `earlybuyers.ts` sur les migrations ; suivi prospectif ; alerte quand ≥ 2 wallets suivis entrent | Quotidien / temps réel |
| Nouvelles narratives | Fréquence des termes dans les noms de tokens créés (PumpPortal) vs 7 jours ; Reddit ; GitHub trending ; trending metas DexScreener | Quotidien |
| Accélérations de volume | z-score 5 min, ratio volume/liquidité | 15 min |
| Changements de liquidité | Moniteur (invariant k, vault LP) sur nos positions et nos lancements | 5 min |
| Comportements de développeurs | Créateurs récidivistes (même wallet créateur sur PumpPortal), lancements bundlés | Quotidien |
| Migrations de communautés | Nouveaux groupes Telegram cités sur Reddit, changements de bio des gros comptes (lecture humaine) | Hebdomadaire |
| Nouveaux outils et infrastructures | GitHub trending, changelogs Helius/Jupiter/DexScreener/PumpPortal | Hebdomadaire |
| Corrélations inhabituelles | Backtest croisé signal × contexte (heure, jour, prix SOL, dominance BTC) | Hebdomadaire |
| Anomalies statistiques | Distribution des volumes par heure ; tokens dont holders montent sans volume (airdrop/bundle) | Quotidien |

# 11. Red team obligatoire

Avant tout intent live et tout lancement, cinq questions, réponses écrites dans le journal :

1. Qu'est-ce qui pourrait rendre cette analyse fausse ? (au moins deux mécanismes concrets)
2. Quelles données pourraient être manipulées ? (volume, holders, boosts, wallets sybils, snapshots)
3. Qu'est-ce qu'un trader expérimenté verrait que nous ne voyons pas ? (latence, qui est en face, qui sort)
4. Est-ce que nous sommes déjà trop tard ? (âge du signal, âge du token, où en est la courbe)
5. Quel est le risque de perdre 100 % ? (autorités, liquidité, concentration, LP)

Seuils de refus automatique : réponse 2 = « oui, facilement » ; réponse 4 = « oui » ; réponse 5 = « élevé ». Un veto red team n'est levé que par Hervé, par écrit, dans le journal.

# 12. Apprentissage

Chaque action devient une ligne de `journal/hypotheses.jsonl` : hypothèse, signal, données, décision, résultat, erreur, rendement, drawdown, contexte. Le ledger local fournit rendement et drawdown ; le journal fournit le pourquoi. Chaque semaine, LEARNING produit `reports/semaine-N.md` : **WHAT WORKED / WHAT FAILED / WHAT WE MISSED / WHAT TO CHANGE**, avec une règle codée : aucune proposition de changement de stratégie si le signal a moins de 10 observations. Un résultat isolé, bon ou mauvais, ne change rien.

# 13. Mode opérationnel : le brief du matin

Chaque matin à 6 h (heure de l'Atlantique), une session planifiée lit le dépôt et produit `briefs/AAAA-MM-JJ.md` :

**MARKET** — ce qui change (prix SOL, dominance, volume memecoin 24 h, tendance des créations/migrations).
**NARRATIVES** — termes en accélération, thèmes, ce qui commence.
**ON-CHAIN** — mouvements inhabituels : volumes anormaux, wallets suivis actifs, migrations notables, changements sur nos positions.
**OPPORTUNITIES** — nouvelles opportunités classées par moteur (frais/outils, trading, découverte), chacune avec sa question red team.
**DEV** — ce qui peut être construit cette semaine, en heures.
**TRADING** — setups (paper ou live), intents proposés, intents rejetés et pourquoi.
**RISKS** — ce qui pourrait nous faire perdre de l'argent aujourd'hui (positions, marché, opérations).
**AUTOMATION** — ce qui peut maintenant être automatisé, ce qui a cassé.
**UNKNOWN** — ce que nous ne savons pas encore, et ce qu'il faudrait pour le savoir.

Règle : chaque chiffre cite son fichier source ; une section sans donnée dit « aucune donnée » ; le brief ne fait jamais de prédiction de prix. Tant que le dépôt GitHub n'existe pas, le brief n'a que MARKET, NARRATIVES (recherche web) et UNKNOWN.

# 14. Plan des cinq mois

| Mois | Objectif | Portes (GO / KILL) | Capital engagé |
|---|---|---|---|
| **1 — Données et paper** | Dépôt en place, collecte 15 min, robot Tap Tap en ligne, Phase 0 $AYE lancée, paper trading S1 | GO si 14 jours de données propres et n ≥ 30 sur S1 ; KILL de S1 si espérance nette ≤ 0 | 0 $ trading, ≤ 200 $ ops |
| **2 — Validation** | Backtests S1/S2/S3, paper 30 jours, décision Phase 1 $AYE | GO live seulement pour une stratégie positive en backtest ET paper ; Phase 1 seulement si Phase 0 atteint ses seuils | ≤ 200 $ trading live si GO |
| **3 — Live borné et frais** | Live avec limites, premier lancement instrumenté (le nôtre ou pour un tiers), journal public | KILL live si drawdown 35 % ou 2 semaines sans espérance positive | 700 $ trading max, frais mesurés |
| **4 — Mise à l'échelle de ce qui marche** | Doubler ce qui a une espérance prouvée, couper le reste ; 2ᵉ et 3ᵉ lancements pour des communautés | Un moteur doit couvrir ses heures (≥ 20 $/h) sinon arrêt | idem |
| **5 — Bilan et suite** | Rapport complet, décision sur les 5 mois suivants | Bilan honnête : capital, frais, heures, ce qui est répétable | — |

La cible de 10 000 $ ne figure dans aucune porte. Les portes portent sur l'espérance mesurée, le drawdown et le rapport revenu/heures.

# 15. Ce qui est construit, et ce qu'il te reste à faire

**Construit et testé aujourd'hui** (`crypto-lab/`, 222 tests, typage strict) : collecteurs DexScreener, PumpPortal, Helius (autorités, extensions, top 10, early buyers), Reddit, GitHub ; signaux volume anormal, early-buyer overlap, narratifs ; harnais de backtest avec refus sous n < 30 ; générateur de brief à 9 sections ; Risk Engine pur avec toutes les règles de la politique ; exécuteur paper/live avec intégrité du code scellée, ledger local chaîné, re-vérification on-chain, kill à cliquet, reduce-only ; journal et rapport hebdomadaire ; workflows GitHub Actions (collecte 15 min, brief quotidien) ; red team complet du plan exécution.

**À faire par toi, dans l'ordre** (≈ 2 h) :

1. Créer un dépôt GitHub privé `crypto-lab`, y pousser le dossier, activer Actions. Ajouter le secret `HELIUS_API_KEY` (clé gratuite sur helius.dev).
2. Sur ta machine : `mkdir ~/.crypto-lab`, copier `lab/risk/policy.example.json` en `~/.crypto-lab/risk.policy.json` (relis chaque ligne), puis `npx tsx lab/exec/seal.ts` après avoir lu le code. Lancer `npx tsx lab/exec/executor.ts --watch --paper` : le paper trading démarre, sans clé.
3. Me donner l'URL du dépôt : la tâche planifiée du matin lira `data/` et écrira `briefs/`.
4. Plus tard, seulement après un backtest et 30 jours de paper positifs : créer un wallet dédié, le financer du montant de la politique, poser `~/.crypto-lab/keypair.json`, et relancer avec `--live`.

Jusqu'au point 4, aucun dollar n'est exposé, et le laboratoire produit déjà des données, des briefs et des résultats de paper. Si les résultats ne justifient aucune action, le système dira NO ACTION, et ce sera la bonne réponse.

# Sources

Toutes les affirmations datées sur les API, les plans gratuits, les frais et les cas de marché proviennent de `docs/research-2026-09-24.md` (28 vérifications, URLs incluses) et des documents précédents du projet (`memecoin-lab/docs/00-sources.md`, analyse stratégique V2, plan Phase 0). Les taux de conversion et les paramètres de stratégies sont des hypothèses à mesurer, jamais des faits.
