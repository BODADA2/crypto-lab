# GUT ENGINE — moteur de priorisation (Master R&D, 2026-09-28)

**GUT ≠ TRUTH. GUT = RESEARCH PRIORITY.** Le gut décide OÙ regarder. Seules les expériences décident ce qui est vrai.

## Règles
- Une intuition non validée = `GUT_HYPOTHESIS`, jamais un fait, jamais un signal.
- Le gut ne peut : créer une preuve, remplacer une statistique, modifier le holdout, justifier un trade, devenir un signal automatique.
- GUT_SCORE ne prédit PAS le rendement — il mesure « cette observation mérite-t-elle plus d'attention ? »

## Composantes du GUT_SCORE (0-3 chacune)
NOVELTY / SURPRISE / INCONSISTENCY / REPEAT_PATTERN / REGIME_CHANGE / DATA_CONFIDENCE / ECONOMIC_RELEVANCE / RESEARCH_VALUE

## Format GUT_HYPOTHESIS (obligatoire)
- OBSERVATION : ce qui a été vu (données, chiffres)
- WHY_IT_FEELS_UNUSUAL : pourquoi ça surprend vs l'historique
- POSSIBLE_EXPLANATIONS : H1/H2/H3 (multi-hypothèses, jamais la première seule)
- DATA_CHECKS : vérifications data avant toute modélisation
- TEST : expérience concrète qui trancherait
- EXPECTED_DIRECTION : direction attendue si le mécanisme est réel
- KILL_CRITERION : ce qui tuerait l'intuition

## Boucle réflexe
OBSERVE → NOTICE → QUESTION → COMPARE → REMEMBER → SUSPECT → FORMULATE → TEST → ATTACK → LEARN → ADAPT → RETEST

## Réflexes obligatoires
- INCOHÉRENCE (« ça ne colle pas ») → INCONSISTENCY_HYPOTHESIS, pas de continuation mécanique
- SURPRISE → WHY_IS_THIS_DIFFERENT ? (corruption / régime / acteur / protocole / anomalie temporaire / nouveau comportement / changement structurel)
- DÉJÀ-VU → chercher cas similaires ; SIMILARITÉ ≠ MÊME OUTCOME
- CONTEXTE → percentile/rang vs cohorte/jour/régime, jamais seuil absolu seul
- SUSPICION → résultat impressionnant = WHERE IS THE TRAP ? (leakage, survie, sélection, lookahead, timestamps, doublons, délai découverte, contamination labels, outlier, régime)
