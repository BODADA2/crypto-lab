# EXP-2026-09-28-flip-s1-flip10 — H-FLIP-10 : lead-lag entre marchés

**Données :** Binance perp SOLUSDT 1m + Binance **spot** SOLUSDT 1m (264 960 bougies chacun, 2026-03-28 → 2026-09-27 ; discovery < 2026-07-16T09:35:59Z ; holdout JAMAIS lu).
**Résultats machine :** `research/results/res-flip-s1-flip10.json`.
**Code :** `lab/flip/leadlag.ts` ; tests `tests/flip-s1.test.ts` (tie ±60 s, signes) verts.

## Volet HL↔Binance : NON TESTABLE — DATA ISSUE
`candleSnapshot` HL (5m) ne retourne que 4 865 bougies du **2026-09-11 → 2026-09-27** (période holdout) ; `startTime` ancien ignoré, ancien `endTime` vide. Impossible de mesurer un lead-lag HL↔Binance sur discovery. **Ce volet reste ouvert, pas réfuté.**

## Proxy perp↔spot 1m (question lead-lag en général)
- Méthode : creux/pic ±30 min autour de chaque cascade (n=113 discovery) sur chaque venue ; lag = t_spot − t_perp ; tie si |lag| ≤ 60 s.
- **n=113 mesurées, 0 null. Médiane lag = 0 s, IQR [0 ; 0]. perp→8, spot→3, tied=102 (90,3 %).**
- Décisives (n=11) : part perp 72,7 % ; **test des signes p=0,13** — pas de leader stable.
- Par type : E1 n=49 (4/1/44) ; E2 n=64 (4/2/58) — identique.
- « Vraie cascade » (dOI 1h ≤ P10 causal, n=36 : 3/2/31) vs « spot-like » (n=77 : 5/1/71) : aucune différence.

## Verdict : NULL (lead-lag systématique)
À résolution 1 min, **90 % des extrêmes sont synchrones** ; les 11 cas décisifs ne montrent pas de leader stable (signes p=0,13). Le falsifier (« pas de leader stable à n≥30 ») est satisfait. Le 8-vs-3 nominal n'est pas exploitable : à cette résolution et ce n, c'est du bruit.
- **OOS :** « holdout gelé » — NON MESURÉ.
- **LEAKAGE STATUS :** OK — fenêtres ±30 min causales autour de t_cascade ; spot ajouté uniquement pour ce test adversarial (timestamps spot en microsecondes normalisés en ms — bug trouvé et corrigé).
- **NEXT_ACTION :** si une source de bougies HL 5m profondes est trouvée, tester HL↔Binance ; sinon, le lead-lag inter-venues n'est pas une piste edge. Ne pas descendre en résolution sub-minute sans modèle de microstructure.

## Note microstructure
Seulement 36/113 cascades (32 %) ont un collapse OI concurrent : la majorité des « cascades » détectées sont des ventes spot-like, pas des liquidations — renforce le caveat proxy de H-FLIP-01.
