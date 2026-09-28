# Protocole de session paper — H-SESS

Date : 28 septembre 2026. Origine : interviews Deku & Cupsey (le vrai edge est la routine).
Statut : **paper uniquement**. Aucun effet sur le live, la politique ou l'exécuteur.

## Hypothèse H-SESS

« Des sessions de paper trading à heures fixes, avec brief écrit avant et journal
après, réduisent le taux de trades hors-plan par rapport à des sessions ad hoc. »

Deku traite le trading « comme un job » (heures fixes, 365 jours verts visés).
Cupsey : réveil → migrations de la nuit → chats ratés → trench (c'est notre brief
quotidien). On systématise, à notre échelle (10 h/semaine max, pas 16 h/jour).

## La session type (60–90 min)

### Avant (10 min) — le brief
1. Lire le brief du matin (`npx tsx lab/brief/generate.ts .`).
2. Noter par écrit : fenêtre de la session, nombre max de trades (≤ 4 positions
   ouvertes, cf. politique), niveau de fatigue/émotion (1–5).
3. Si fatigue ≥ 4 ou émotion forte → **pas de session** (noter pourquoi).

### Pendant — règles d'exécution paper
- Fenêtre fixe choisie à l'avance (ex. 19 h–21 h America/Moncton), jamais 2 h–8 h
  (`forbiddenWindow` de la politique).
- Chaque trade paper suit les mêmes filtres que le Risk Engine (liquidité ≥ 20 k$,
  âge ≥ 10 min, pas d'autorités mint/freeze, slippage ≤ 3 %).
- Un trade sans motif écrit **avant** l'entrée = trade hors-plan (compté, pas caché).
- Arrêt immédiat après 3 pertes consécutives (`maxConsecutiveLosses`, déjà en politique).

### Après (10 min) — le journal
Fichier : `lab/journal/sessions/<AAAA-MM-JJ>.md` (créer le dossier si besoin).
Contenu minimal :
- Heures de session, nombre de trades, P&L paper net de frais.
- Pour chaque trade : motif d'entrée (1 ligne), respect du plan (oui/non), émotion dominante.
- Une phrase : « qu'est-ce que je referais / ne referais pas ».

## Métriques suivies (revue hebdo)

| Métrique | Où | Cible paper (à calibrer) |
|---|---|---|
| Taux de trades hors-plan | journal | < 10 % |
| Jours verts / jours tradés | journal | suivi, pas un objectif |
| P&L net par heure de session | journal | > 0 sur 30 jours |
| Respect de la fenêtre | journal | 100 % (2 h–8 h jamais) |

## Extension H-NARR / H-EXIT / régime (28 sept. 2026)

Les hypothèses issues de Cupsey/Cented s'intègrent à la session **sans changer
la politique** : ce sont des champs de journal et des choix de régime de
sortie, pas des paramètres du Risk Engine.

### Avant — enrichir le brief (5 min de plus)
1. Noter le **régime de volume Solana** du brief (section ON-CHAIN :
   `famine / calme / normal / chaud / frénésie`, avec son historique de base).
   - Régime `frénésie` ou `famine` → réduire le nombre max de trades de la
     session (ex. 2 au lieu de 4) : contexte extrême = bruit extrême.
   - Régime `inconnu` (historique < 3 jours) → aucune conclusion macro,
     session normale.
2. Noter les **termes narratifs en accélération** (section NARRATIVES du
   brief) : ce sont les seuls « catalysts » que le labo mesure aujourd'hui
   (chevauchement nom/symbole ↔ termes accélérés, walk-forward strict).

### Pendant — catalyst à l'entrée, régime de sortie fixé d'avance
- À chaque entrée paper, noter le **score catalyst** du token
  (`lab/signals/catalyst.ts` : 0–100, 0 = neutre, pas un rejet).
- Le **régime de sortie est choisi à l'entrée et ne change plus** :
  - catalyst ≥ 40 → régime **runner** (paliers 25 % à +50/+150/+300 %,
    solde au time-stop 48 obs., SL −25 %).
  - sinon → régime **scalp** (sortie unique : TP +30 %, SL −20 %,
    time-stop 6 obs.).
- Sortie réelle vs sortie prévue : tout écart est un **trade hors-plan**
  (compté dans la métrique, même si « ça a mieux marché »).
- Résultats des backtests du 28 sept. 2026 à garder en tête (données réelles,
  pas des ordres) : le catalyst mesuré **ne prédit ni la migration
  (lift x1.03) ni les gros multiples (médiane MFE x1.20 vs x1.15)** ; la
  comparaison scalp/runner est **non concluante** (moyennes dominées par des
  ticks aberrants, médianes négatives). Donc : le régime de sortie est une
  **discipline d'exécution**, pas une prédiction de gain.

### Après — journal enrichi
Ajouter par trade : régime de volume du jour, score catalyst à l'entrée,
régime de sortie choisi (scalp/runner), sortie prévue vs réelle.
En revue hebdo : le taux de hors-plan se calcule **par régime** (les runners
sont-ils tenus moins bien que les scalps ?).

### Garde-fous inchangés
- Aucun changement de `lab/risk/policy.example.json`, de l'exécuteur, du Risk
  Engine ni des poids de score dans ce protocole.
- `NO ACTION` si données insuffisantes (règle n ≥ 30) — un score catalyst
  élevé n'est jamais une autorisation d'augmenter la taille.
- Le paper mesure la discipline ; il ne prouve pas la rentabilité live.

## Avertissements

- La « série de jours verts » est un **outil de discipline en paper**, jamais un
  objectif en live : en live, elle pousse à couper les gains trop tôt et à
  moyenner les pertes (notre `allowAveragingDown: false` existe contre ça).
- Aucune modification de `lab/risk/policy.example.json` dans ce protocole.
  Si un paramètre doit changer après 30 jours de paper, ça passe par une
  proposition écrite + red team, pas par une édition silencieuse.
- Le paper trading ne prouve pas la rentabilité live (slippage, latence,
  psychologie) : il prouve la **discipline** et permet de mesurer l'**espérance**.
