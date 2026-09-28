# Recherche — Le playbook de Cupsey (interview rasmr, 11 août 2026)

Date : 28 septembre 2026
Source : « How Cupsey Makes $2M A Month Trading Memecoins », chaîne rasmr, ~57 min.
Lien : https://youtu.be/EUybINsX9QU
Type : transcription lue (vidéo non visionnée). Description contient un lien de parrainage (fomo.family) — contenu sponsorisé, recul requis.

Statut : **recherche uniquement**. Aucun changement de code, de politique ou de stratégie live. Règle du labo : backtest n ≥ 30, 30 jours de paper positifs, red team écrit — sinon NO ACTION.

Note : à lire après `research-2026-09-28-deku.md`. Les deux traders se recoupent et se contredisent par endroits — les deux lectures sont utiles.

---

## 1. Ce que fait Cupsey, mécaniquement

| Élément | Détail (ses mots) |
|---|---|
| Style | « Trencher » ultra-haute-fréquence (~500 coins/jour selon lui) ; aujourd'hui : achète moins, tient plus longtemps qu'avant. |
| Entrée | À l'origine : refresh manuel de Photon/pump.fun sur les coins nouvellement créés (il a « inventé » ce style). Aujourd'hui : narrative runners + info wallets sur les launches (« finding info on some type of launch with wallets... I'm early »). |
| Détection de bundles | Regarde si le bundle vend : sur le chart, contrôle de l'offre visible ; si les entrées précoces (3k/5k/10k) vendent en bloc → c'est le bundle qui dump. |
| Moteur n°1 d'un token | « Attention and catalyst » — l'attention + un catalyseur. |
| Le trade « 67 » | ~40k$ en swinguant à haute market cap un meme déjà viral ; conseil pour le « prochain 67 » : acheter et tenir, mais les plays TikTok « take a long time to cook ». |
| Sizing (conseil 1 000 $) | Tout mettre on-chain, mais des **toutes petites tailles par coin**. Jamais 1 000 $ dans un coin. |
| Social | Trade toujours en VC Discord : « multiple eyes », on ne rate rien ; groupe petit et de confiance (il met en garde contre les groupes Telegram qui farment les petits). |
| Chaînes | Thèse « volume war » : Robinhood, BNB, Base se battent pour le volume ; il parie que **pump.fun gagne** (ancienneté, trésorerie, airdrop potentiel). Reste focus Solana : quand Robinhood était chaud, Solana était vide → « insanely free to hit ». |
| Routine | Réveil → check des coins migrés pendant la nuit → lecture des chats ratés → trench. |
| Streaming | Ne stream plus : gagne plus hors-stream, plus concentré. Ne jamais copy-trader les streamers aveuglément. |
| Hygiène | Ne dépense presque rien (chaise 300 $, vieux iPhone, PC 8k$), caféine ~400 mg/j, comptable pour les taxes (~500 trades/jour). |

## 2. Ce que ça change pour nous (vs la note Deku)

### 2.1 H-BUNDLE — nouvelle hypothèse prioritaire

C'est l'apport le plus actionnable de cette vidéo, et il complète notre `maxTop10Pct: 40` (statique) par une version **dynamique**.

- **Hypothèse H-BUNDLE** : « Quand les wallets des 50 premiers acheteurs vendent en bloc dans les 30 premières minutes après détection, le token sous-performe les tokens sans ce pattern à 60 min, net de frais. »
- **Donnée à construire** : pour chaque token suivi, distribution des entrées/sorties précoces par wallet (le collecteur PumpPortal voit les trades ; il faut agréger par wallet sur la première demi-heure).
- **Test** : rétrospectif sur `data/` (n ≥ 30 tokens avec pattern bundle vs 30 sans), puis filtre d'exclusion en paper : pas d'entrée si pattern détecté.
- **Lien avec l'existant** : `lab/signals/earlybuyers.ts` (overlap) + `mintinfo.ts` (top holders) sont les briques ; H-BUNDLE est leur usage défensif.

### 2.2 H-NARR renforcée — « attention + catalyst »

Cupsey confirme notre H-NARR (blueprint §1.5) et la précise : la fréquence d'un terme ne suffit pas, il faut un **catalyseur** (compte qui lance, mention notable, viralité TikTok).

- **Donnée à construire** : dans `lab/signals/narrative.ts`, ajouter une dimension « catalyst » — un terme ×5 en 24 h **avec** au moins une mention par un compte suivi = signal ; sans catalyst = bruit.
- **Corollaire** : les plays TikTok/virals « take a long time to cook » → ne pas les traiter comme des scalps pré-bond ; deux régimes, deux jeux de paramètres (à séparer dans le backtest).

### 2.3 Thèse chaînes — indicateur de régime, pas un pari

Son pari « pump.fun gagne la volume war » conforte notre focus Solana/PumpPortal **aujourd'hui**, mais c'en est aussi l'avertissement :

- **À construire** : un indicateur de régime simple dans le brief quotidien — part du volume memecoin par chaîne (Solana vs autres). Si le volume migre durablement, toutes nos hypothèses calibrées sur Solana doivent être revalidées.
- **Ne pas en faire** : un pari directionnel ou un changement de chaîne en live sans données.

### 2.4 Routine du matin → déjà notre brief

Sa routine (migrations de la nuit + chats ratés) = exactement ce que `lab/brief/generate.ts` est censé produire chaque matin. Vérifier que le brief couvre : migrations des dernières 24 h, nouveaux devs scorés apparus, termes narratifs en accélération. Si un élément manque, c'est un trou à boucher, pas un nouveau système.

### 2.5 Sizing — confirmation

« Tout on-chain, minuscule par coin » : notre 10 $ min / 50 $ max est la traduction correcte à notre échelle. Rien à changer.

## 3. Deltas proposés à la politique de risque (paper d'abord)

1. **Filtre anti-bundle** (H-BUNDLE) : exclusion d'entrée si pattern de vente groupée des early wallets — à tester en paper avant d'en faire une règle dure.
2. **Deux régimes de sortie** : scalps pré-bond (sortie rapide, cf. H-EXIT de la note Deku) vs plays narratifs/virals (tenue plus longue, stop plus large) — paramètres séparés, jamais mélangés dans une même statistique.
3. **Rien d'autre.** Surtout pas : 500 trades/jour (nos frais de 3–5 % aller-retour l'interdisent mathématiquement), 16 h d'écran, copy-trading de streamers.

## 4. Ce que cette vidéo change concrètement cette semaine

1. Spécifier **H-BUNDLE** (agrégation par wallet des trades précoces) — avec H-DEV (note Deku), les deux chantiers data les plus rentables.
2. Ajouter la dimension **catalyst** au signal narratif (H-NARR v2).
3. Ajouter au brief quotidien l'**indicateur de régime par chaîne** (part de volume Solana).
4. Séparer les **deux régimes de sortie** dans le harnais de backtest.

## 5. Limites de cette note

- Chiffres auto-déclarés et invérifiables dans l'interview (« $2M/month », « $21M cette année », « 500 coins/jour ») — à traiter comme du récit, pas des données.
- Survivorship bias maximal : on interviewe le gagnant du casino, pas les milliers de trenchers ruinés avec le même style.
- Style à haute fréquence incompatible avec nos coûts et notre temps disponible : on en extrait les **filtres** (anti-bundle, catalyst, régime), pas le **débit**.
- En contradiction partielle avec Deku : Cupsey tient plus longtemps et swing à haute market cap quand c'est viral ; Deku sort vite et évite le post-bond. Les deux ont raison **dans leur régime** — d'où la séparation des deux régimes en §3.2.
