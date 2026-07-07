---
name: failure-archaeology
description: Chronique des investigations, impasses et bugs majeurs de PasteGuard et du fork — l'impasse proxy OAuth Claude Code (401 x-api-key placeholder), l'ère Presidio, les placeholders HTML-cassés, le prompt caching cassé, les crashs AVX2, les scans concurrents. À charger quand un débogage piétine, avant de proposer une approche possiblement déjà tentée, ou quand on se demande « pourquoi ce code est comme ça » ou « a-t-on déjà essayé X ». (Pour trier un symptôme actif, commencer par debugging-playbook.)
---

# Archéologie des échecs — PasteGuard et fork

Format : symptôme → cause racine → preuve → statut. Les invariants qui en découlent vivent dans `architecture-contract` ; le triage rapide dans `debugging-playbook`.

## Quand NE PAS utiliser cette skill

- Pour trier un symptôme actif → `debugging-playbook` d'abord (il renvoie ici pour l'histoire).
- Pour l'état ACTUEL de la campagne hooks → `hooks-mvp-campaign`.

## K. L'impasse proxy OAuth (l'échec le plus coûteux du fork) — 2026-07

- **Symptôme** : `401 invalid x-api-key` dès que `ANTHROPIC_BASE_URL` pointe ailleurs que api.anthropic.com.
- **Cause racine** : le binaire `claude` (2.1.201) n'attache le token OAuth d'abonnement qu'en parlant DIRECTEMENT à api.anthropic.com ; sinon il envoie `x-api-key: sk-ant-api03-placeholder` (placeholder en dur). Le token existe (trousseau macOS « Claude Code-credentials ») mais l'injecter dans un proxy = violation des CGU Anthropic (blocage OAuth tiers depuis fév. 2026, issue anthropics/claude-code#28091) + risque de suspension de compte.
- **Preuve** : test E2E réel documenté dans PROGRESS.md ; toute l'approche 1 y est consignée.
- **Statut** : approche proxy ABANDONNÉE DÉFINITIVEMENT pour l'usage abonnement. Ne jamais re-proposer ni « déboguer » ce 401. Pivot → hooks (`hooks-mvp-campaign`).
- **À préserver** : les correctifs de l'arbre de travail non committé restent valables pour une PR upstream (usage clé API, issue upstream #139) : en-têtes transparents (client.ts), schémas Zod tolérants (types.ts : rôle libre car Claude Code envoie `system`, blocs inconnus, tool_result sans contenu, input_schema optionnel), démasquage récursif des tool_use non-stream (extractors/anthropic.ts), démasquage streaming des input_json_delta avec buffering par index de bloc (stream-transformer.ts). [read: from PROGRESS.md, diff de branche]
- **Impasses annexes écartées en chemin** : iTerm2/wrapper terminal (ne voient que le TTY, le trafic API n'y transite jamais) ; « Claude Privacy Tool » qui prétend réécrire le prompt via UserPromptSubmit — contredit la doc officielle (UserPromptSubmit ne peut que bloquer ou ajouter du contexte, re-vérifié 2026-07-05).

## Historique amont (144 commits, aucun revert) [verified: executed git log]

**A. Corruption de texte, entités chevauchantes (#33)** : Presidio renvoyait « Eric » et « Eric's » en même temps → remplacement par offsets corrompu → résolveur deux phases (`conflict-resolver.ts`, commits c8cc3cf, dbb221a, 2315371). Corrigé.

**B. Placeholders HTML-encodés (#36 → #38, d239944)** : `<TYPE_N>` encodé en entités HTML par des clients → indémasquable → format `[[TYPE_N]]` ; le `redact_placeholder` configurable supprimé (le streaming hardcodait `[[`). Corrigé, invariant 1.

**C. Crash SIGILL sans AVX2 (#70 → #71, cfe18e0)** : le script d'install Bun livrait un binaire AVX2 → crash sur CPU modestes → binaire copié depuis `oven/bun:1-slim` (baseline SSE4.2). Corrigé, commentaire pérenne dans le Dockerfile.

**D. Prompt caching Anthropic cassé (#74, 9e8006a)** : les schémas Zod strippaient `cache_control` → `.passthrough()` généralisé. Corrigé. **Thème récurrent : la validation stricte casse la transparence du proxy** — même thème dans l'issue #139 et le travail de branche actuel.

**E. L'ère Presidio (#62, #69, #100)** : timeouts de démarrage multi-langues, recognizers manquants, image contraignante → remplacement complet par le détecteur maison GLiNER + déterministe (08ddb1d, v0.5.0), benchmark d'exactitude ajouté juste avant (#99) pour piloter la migration. Clos ; le détecteur maison garde le contrat d'offsets « Presidio drop-in ».

**F. Contenu masqué non loggé si secrets détectés (#91, c982e62)** : le logging ignorait `log_masked_content` dès qu'un secret apparaissait → helper pur `shouldLogMaskedContent` centralisé. Corrigé.

**G. Streaming : lignes SSE coupées (#84, #112)** : le transformer supposait chunks = lignes → restauration cassée → réécriture du buffering. Corrigé côté OpenAI ; le même chantier est retraité côté Anthropic dans le travail de branche non committé.

**H. Scans détecteur concurrents (#135, puis #137)** : `Promise.all` sur les spans alors que l'inférence torch est sérialisée par `_infer_lock` → empilement → timeouts → boucle séquentielle + `detector_timeout` configurable. Corrigé. **Enseignement : le détecteur = UNE inférence à la fois ; toute parallélisation côté proxy est une fausse bonne idée.**

**I. Doctrine scan des rôles : aller-retour (#25 puis #115)** : #25 corrigeait « on ne scanne que certains rôles » en scannant TOUT ; #115 a inversé : ne scanner par défaut que les rôles contrôlés par l'utilisateur (user, tool, function, mcp) pour ne pas masquer le contexte injecté par le harnais. Pas un revert, un raffinement : connaître les deux moitiés avant de « corriger » dans un sens ou l'autre.

**J. Conductor : config.yaml pollué (#109, #110)** : seed automatique écrasait la config → seed conditionnel, arrêt du seed en workspace. Corrigé.

**L. Fuite de mocks entre tests de routes (#85, ed7fb19)** : le mock du détecteur fuyait entre fichiers → isolation corrigée ; a aussi imposé de sortir `shouldLogMaskedContent` en module dédié (cf. F).

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Re-vérifications :
- `git log --oneline -10` (nouveaux chapitres à ajouter)
- L'entrée K se re-vérifie dans PROGRESS.md (local-only) ; si PROGRESS.md contredit cette skill, PROGRESS.md gagne.
