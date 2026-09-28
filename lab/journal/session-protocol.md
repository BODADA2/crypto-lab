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

## Avertissements

- La « série de jours verts » est un **outil de discipline en paper**, jamais un
  objectif en live : en live, elle pousse à couper les gains trop tôt et à
  moyenner les pertes (notre `allowAveragingDown: false` existe contre ça).
- Aucune modification de `lab/risk/policy.example.json` dans ce protocole.
  Si un paramètre doit changer après 30 jours de paper, ça passe par une
  proposition écrite + red team, pas par une édition silencieuse.
- Le paper trading ne prouve pas la rentabilité live (slippage, latence,
  psychologie) : il prouve la **discipline** et permet de mesurer l'**espérance**.
