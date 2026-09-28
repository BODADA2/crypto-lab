# Recherche — Le playbook de Deku (interview Daumen, 26 août 2026)

Date : 28 septembre 2026
Source : « He Trades Memecoins Every Day And Always Wins (Decu) », chaîne Daumen, 19:34.
Lien : https://youtu.be/4QNfRWqzuag
Type : transcription lue (vidéo non visionnée). Contenu sponsorisé en description (lien de parrainage trade.padre.gg) — à prendre avec recul.

Statut : **recherche uniquement**. Aucun changement de code, de politique ou de stratégie live. Toute hypothèse ci-dessous suit la règle du labo : backtest n ≥ 30, 30 jours de paper positifs, red team écrit — sinon NO ACTION.

---

## 1. Ce que fait Deku, mécaniquement

| Élément | Détail (ses mots) |
|---|---|
| Entrée | Le plus tôt possible, pré-bond, « first to scan, quick buy ». Évite les coins déjà migrés/post-bond : « most of the time when I do I end up losing ». |
| Taille | 2–3 SOL par trade (~300–450 $ CAD), un seul wallet. Splitte sur 2–3 wallets seulement s'il dépasse ~3–4 % de l'offre. |
| Sortie | Pas de « take initials » systématique. Quand il vend : tout d'un coup, ou par clips de 10–20 %. |
| Tenue | Ne dort sur aucun bag (sauf petits moon bags qui vont à zéro la plupart du temps). Protège sa série de jours verts. |
| Edge (son « breakout », fin nov. 2025) | **Tracking de devs** : acheter en quick-buy les launches de créateurs connus qui « pushent » bien leurs coins, parfois sans même lire le narratif. |
| Routine | 5–8 h/jour d'écran, traité « comme un job ». Aucun jour sans trade en 2026. Objectif : 365 jours verts. |
| Social | VC avec 3–4 amis ~50 % du temps de stream : callouts de coins qu'il ne scanne pas lui-même. |
| Psychologie | « Find what works for you » — ne pas copier les autres. Il a essayé le bundling/cabal early : « I got destroyed ». |

## 2. Traduction honnête vers nos contraintes

Deku est un outlier à plein temps (8 h/jour, années de pattern recognition, ~120 SOL/jour). Nous : 700 $ CAD de capital trading, positions max 50 $, plafond de temps ~10 h/semaine (blueprint §2), paper d'abord.

**Ce qui ne se copie pas :** le screen time, le multi-wallet (inutile à notre taille), le sizing absolu, la série de 365 jours (objectif irréaliste et dangereux comme motivation).

**Ce qui se copie :** la *structure* de son edge. Et c'est une bonne nouvelle : chaque composante manuelle de son travail correspond à un collecteur ou un signal que le labo possède déjà ou peut construire. Notre avantage comparatif n'est pas de trader comme Deku, c'est de **systématiser ce qu'il fait à la main**.

## 3. Intégration dans le pipeline du labo

### 3.1 H-DEV — le tracking de devs devient une hypothèse formelle

C'est la validation externe la plus forte de notre H-EARLY existante (blueprint §1.5). `lab/signals/earlybuyers.ts` fait déjà l'overlap des early buyers ; il manque le versant « créateur ».

- **Hypothèse H-DEV** : « Un wallet qui a déployé ≥ 2 tokens gradués sur les 90 derniers jours a une probabilité supérieure au hasard de voir son prochain lancement atteindre la graduation. »
- **Donnée à construire** : registre des devs — pour chaque migration observée par le collecteur PumpPortal, enregistrer le deployer ; scorer par taux de graduation historique ; surveiller leurs nouveaux launches en priorité.
- **Test** : rétrospectif sur `data/` existant (n ≥ 30 launches de devs scorés), puis suivi prospectif 30 jours en paper (signaux sans exécution, ou exécution paper).

### 3.2 H-FRESH — la vitesse d'entrée est mesurable

Deku : « I want to be the first person to scan it ». Notre équivalent : mesurer la latence détection→signal→décision.

- **Hypothèse H-FRESH** : « Parmi les tokens qui graduent, la part achetée dans les N premières minutes après détection a une espérance supérieure à celle achetée plus tard, nette de slippage. »
- **Donnée à construire** : timestamp de première observation par token dans `data/scans/pump-*.jsonl` (si absent, l'ajouter au collecteur) ; en backtest, simuler des entrées à +1, +5, +15 min et comparer l'espérance nette.
- **Garde-fou** : notre `maxSlippageBps: 300` et `minLiquidityUsd: 20000` restent les filtres durs — la vitesse ne doit jamais les contourner.

### 3.3 H-EXIT — sorties par paliers vs tout-ou-rien

Deku ne prend plus d'initials ; il clipe 10–20 % ou sort tout. Notre politique actuelle a `allowSizeAdjustment: false`.

- **Hypothèse H-EXIT** : « Sur les trades gagnants pré-bond, une sortie en 3 paliers (+40 % / +100 % / trailing) bat l'espérance d'une sortie unique à +40 %, nette de frais. »
- **Test** : en backtest d'abord (les deux variantes sur les mêmes entrées, n ≥ 30), puis variante paper. Ne toucher à `allowSizeAdjustment` qu'après validation — et seulement en paper.

### 3.4 H-SESS — la discipline de session comme métrique

Le vrai edge de Deku est peut-être la routine, pas les picks : heures fixes, journal, série de jours verts comme fonction de forçage anti-tilt.

- **Hypothèse H-SESS** : « Des sessions de paper trading à heures fixes avec un journal quotidien (motif d'entrée, émotion, respect du plan) réduisent le taux de trades hors-plan vs des sessions ad hoc. »
- **Métriques à suivre dans `lab/journal/`** : taux de jours verts en paper, nombre de trades hors-plan/semaine, profit net par heure de session (le blueprint l'exige déjà : « rapport revenu/heures »).
- **Proposition de protocole de session** (paper uniquement pour commencer) : fenêtre fixe (ex. 19 h–21 h Moncton, hors `forbiddenWindow` 2 h–8 h déjà en politique), max 4 positions (déjà), arrêt après `maxConsecutiveLosses: 3` (déjà), un brief écrit avant chaque session.
- **Avertissement** : ne pas transformer la « série verte » en objectif de trading live — en paper c'est un outil de discipline, en live ça incite à couper les gains trop tôt et à moyenner les pertes. Notre `allowAveragingDown: false` existe précisément contre ça.

### 3.5 Le VC social → signal narratif

Son VC d'amis = notre `lab/signals/narrative.ts` + collecteurs Telegram/Reddit : des humains qui surfacen des coins hors de son champ de vision. Rien à coder de nouveau ; prioriser la veille narrative existante comme source de callouts, avec la même règle : un callout n'est pas un signal tant qu'il n'a pas passé les filtres (liquidité, âge, autorités mint/freeze).

## 4. Deltas proposés à la politique de risque (paper d'abord, jamais en live sans validation)

1. **Durée max de détention** : pas de bag overnight en phase d'apprentissage (équivalent système de son « I don't sleep on bags »). À tester comme paramètre en paper.
2. **Journal de session obligatoire** : un trade sans motif écrit = trade hors-plan, compté dans la métrique H-SESS.
3. **Fenêtre de session fixe** : réduire la tentation du « toujours scotché » — Deku peut se le permettre, nous non (10 h/semaine).
4. **Rien d'autre.** Les garde-fous existants (50 $ max, 200 $ d'exposition, 70 $/jour, kill switch) restent intacts. La vitesse et l'agressivité ne s'achètent jamais avec la sécurité.

## 5. Ce que cette vidéo change concrètement cette semaine

1. Prioriser le collecteur **registre devs** (H-DEV) — c'est le morceau de son edge le moins couvert par nos signaux actuels.
2. Ajouter le **timestamp de première observation** au collecteur PumpPortal si absent (H-FRESH).
3. Cadrer le **protocole de session paper** (H-SESS) avant la première session : heures, journal, métriques.
4. Spécifier le **backtest H-EXIT** (paliers vs sortie unique) dans `lab/backtest/`.

## 6. Limites de cette note

- Un seul trader, une seule interview, chiffres auto-déclarés (même si on-chain vérifiables selon l'intervieweur).
- Survivorship bias : on n'interviewe pas les centaines de traders qui ont fait pareil et ont perdu.
- Le marché a changé depuis son breakout (fin 2025) : le tracking de devs est maintenant pratiqué par plus de monde, l'edge se compresse — d'où l'importance de mesurer, pas de croire.
