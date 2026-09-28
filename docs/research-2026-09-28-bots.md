# Fiche de recherche — bots & outils (rôle, posture, évaluation)

Date : 28 septembre 2026. Origine : interviews Deku, Cupsey, Cented.
Statut : **recherche uniquement**. Aucun exécuteur live, aucune clé API de
trading, aucun flux payant souscrit dans cette passe.

## Ce que disent les trois interviews (table)

| Trader | Outils / bots mentionnés | Rôle réel décrit |
|---|---|---|
| Deku | bots de snipe/buy rapides | vitesse d'entrée sur les launches ; il ne clique pas à la main |
| Cupsey | bots de trading (achats/ventes rapides), alerts | exécution rapide + ne pas rater les migrations de la nuit |
| Cented | groupe « Elite » (EVM), pas de bot précis nommé | le réseau (VC/débat) prime sur l'outil ; vitesse de jugement 1 s |

Constat honnête : aucun des trois ne décrit son stack technique en détail.
Les chiffres (120 SOL/jour, 2 M$/mois, P&L à 8 chiffres) sont **invérifiables**
— on retient les filtres et les routines, pas les montants ni les cadences.

## Posture du labo : paper-first

1. **Aucune exécution live pilotée par le labo.** L'exécuteur du dépôt reste
   le seul chemin autorisé, et il est aujourd'hui en mode paper (politique
   inchangée : position max 50 $, exposition max 200 $, perte/jour max 70 $).
2. Un bot/outil tiers, s'il est évalué un jour, ne sert qu'à **observer**
   (données, alertes, latence mesurée) — jamais à signer une transaction.
3. Règle d'or : on ne branche un outil d'exécution que si (a) 30 jours de
   paper sont positifs, (b) la red team écrite est passée, (c) le Risk Engine
   reste le seul garde-fou (aucun bypass).
4. Pas de copy-trading : Cented le dit lui-même, c'est inimitable (vitesse +
   effet « ses yeux bougent le marché »). Le labo ne copie personne.

## Grille d'évaluation d'un outil (J7 Tracker et autres)

L'exploration de J7 Tracker est menée séparément (agent parent) ; cette grille
sert à juger ce qu'on y trouvera — et tout autre outil — sans enthousiasme
naïf.

| Critère | Question à trancher | Seuil labo |
|---|---|---|
| Latence | Délai données → affichage, mesuré, pas promis | comparable ou meilleur que nos collecteurs |
| Chaînes | Lesquelles, vraiment branchées | Solana d'abord ; le reste = bonus |
| Données | Historique exportable ? Granularité ? | export CSV/API requis pour backtester (n ≥ 30) |
| API / export | Peut-on sortir les données sans la UI ? | oui, sinon c'est une vitrine pas un outil |
| Frais | Abonnement + frais cachés | 0 $ tant que le paper n'est pas positif 30 j |
| Contrôles de risque | Limites de taille, kill-switch, journal d'ordres | kill-switch + journal horodaté obligatoires |
| Auditabilité | Chaque action est-elle rejouable après coup ? | sans journal exportable : non |

## Décision du 28 sept. 2026

**NO ACTION sur tout outil payant ou exécutant.** La passe du jour reste :
données gratuites (PumpPortal, DexScreener), backtests locaux, paper.
Réévaluer quand : (a) le paper 30 jours est vert, (b) un besoin précis
(ex. latence d'alerte mesurée insuffisante) est documenté par écrit.
