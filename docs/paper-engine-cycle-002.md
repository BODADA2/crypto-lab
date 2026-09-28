# Rapport de cycle — 002

DATE : 2026-09-28
RÉGIME DU MARCHÉ : SIDEWAYS
Note régime : régime chaîne "calme" le 2026-09-28 (Régime solana le 2026-09-28 : calme — 4 046 créations (percentile 25 / base 4 j), 121 migrations (3.0 %), 6773.0 SOL initiaux, mcap médiane 28.3 SOL.) (adaptation : paramètres de base)

TOKENS ANALYSÉS : 1206
NOUVEAUX TOKENS : 1206
TOKENS ÉLIMINÉS : 1206
RAISONS D'ÉLIMINATION :
- LIQUIDITÉ  : 731 tokens
- score ou couverture < seuils : 473 tokens
- MARCHÉ  : 2 tokens

PAPER TRADES : 0
GAINS : 0
PERTES : 0
NO TRADE : 1206 (dont 30 persistées au journal — plafond anti-bruit)
POSITIONS OUVERTES EN FIN DE CYCLE : 0

PERFORMANCE (cumulée sur tout l'historique du moteur) :
Nombre de trades : 0
Win rate : n/a
Average win : n/a
Average loss : n/a
Profit factor : n/a
Expectancy : n/a
Max drawdown : 0.00 %
Average R : n/a
Median R : n/a

ERREURS DÉTECTÉES :
1. aucune erreur bloquante ce cycle

AJUSTEMENTS :
1. aucun (preuve insuffisante — anti-sur-apprentissage)

HYPOTHÈSES À TESTER :
1. bloc d'apprentissage incomplet (0/20 clôtures) — aucune conclusion
2. H-DATA-1 : couverture maximale observée 49 % < 60 % — aucun token ne peut être évalué avec la collecte actuelle (pas de social, holders null, autorités UNKNOWN). Le moteur restera en NO_TRADE jusqu'à l'ajout de sources ; ne pas baisser le seuil sans preuve n≥30.

OPPORTUNITÉS ACTUELLES :
- aucune opportunité ouverte en fin de cycle (positions simulées clôturées en walk-forward)

SECTIONS INAPPLICABLES (données absentes — INCONNU, rien d'inventé) :
- analyse de contrat on-chain (bytecode, taxes) : aucune donnée collectée — autorités toujours UNKNOWN
- wallets deployer/insiders : data/history ne contient pas le wallet du dev — H-BLOCK inopérant sur ces données

---
Rappel : ceci est du PAPER TRADING simulé sur données historiques. Aucune transaction réelle.
Le score interne est un classement relatif, jamais une garantie de rendement.
