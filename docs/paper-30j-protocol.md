# Protocole paper 30 jours — formalisation (28 sept. 2026)

Statut : **paper uniquement**. Le live n'est pas à l'ordre du jour avant la fin
des 30 jours + red team validée + décision explicite d'Hervé.

## Cadre
- **Durée** : 30 jours calendaires à partir du jour J (date de démarrage choisie par Hervé).
- **Deux comptes** : N (narratif, filtre à 6 points) vs S (systématique, signaux labo) —
  cf. `lab/journal/session-protocol.md` § deux comptes.
- **Enveloppe partagée** : 200 $ exposition max, 70 $ perte max/jour, 50 $/position,
  pas de moyennage. Identique des deux côtés.
- **Rythme** : sessions à heures fixes, 10 h/semaine max (pas 16 h/jour).

## Routine quotidienne (15 min hors sessions)
1. Brief du matin (`npx tsx lab/brief/generate.ts .`) — 5 min.
2. Sessions planifiées (journal `-N.md` / `-S.md` séparés) — cf. protocole de session.
3. Fin de journée : P&L paper par compte, notés dans le journal du jour.

## Revue hebdo (dimanche, 30 min)
Par compte : P&L net, win rate, gain/perte moyens, R moyen, taux de hors-plan,
respect de la fenêtre, respect du filtre N (thèse écrite avant chaque entrée ?).
Décisions possibles en revue hebdo :
- Compte N en pause si hors-plan > 30 % sur 2 semaines (règle déjà écrite).
- Ajuster le nombre de trades/session selon le régime de volume.
- **Jamais** : changer la politique, le Risk Engine ou les poids (proposition écrite + red team requises).

## Décision J+30 — matrice
| Résultat | Décision |
|---|---|
| Un compte nettement meilleur (P&L + R + discipline) | On garde le meilleur, on archive l'autre |
| Les deux positifs, profils différents | On garde les deux, enveloppes séparées |
| Les deux négatifs ou indisciplinés | Pas de live. Retour recherche, pas d'argent réel |
| Données insuffisantes (< 30 trades/comptes) | On prolonge le paper, pas de raccourci |

## Conditions bloquantes avant tout live (même micro-montants)
Voir `docs/red-team-2026-09-28.md` (en cours de rédaction) : toutes les conditions
bloquantes doivent être levées + décision explicite d'Hervé. Le paper positif ne
suffit pas seul.
