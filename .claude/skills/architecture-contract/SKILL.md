---
name: architecture-contract
description: Les décisions de conception porteuses de PasteGuard et les invariants à ne jamais casser — flux de masquage complet, format de placeholder [[TYPE_n]], ordre secrets avant PII, offsets UTF-16, scans détecteur séquentiels, contrats POST /api/mask et /analyze, périmètre fork (src/ vs integrations/). À charger avant toute modification du flux de masquage, des extractors, des providers ou des routes, pour comprendre « comment ça marche », ou quand un choix paraît bizarre et qu'on est tenté de le « corriger ».
---

# Contrat d'architecture — PasteGuard

## Quand NE PAS utiliser cette skill

- Pour la sémantique de détection (GLiNER, fusion, denylist) → skill `domain-reference`.
- Pour l'histoire des bugs derrière ces invariants → skill `failure-archaeology`.
- Pour la campagne hooks Claude Code → skill `hooks-mvp-campaign`.

## Vue d'ensemble

`src/index.ts` : middlewares (X-Request-ID, cors, logger) puis montage de `/` (health, info), `/openai`, `/anthropic`, `/codex`, `/api`, `/dashboard`. Au boot : validation config, attente du détecteur (exit 1 si absent), scheduler de nettoyage des logs, arrêt propre SIGTERM/SIGINT. [read: from src/index.ts]

Endpoints primaires : `POST /openai/v1/chat/completions`, `POST /anthropic/v1/messages`, `POST /codex/responses`, `GET /health`, `GET /info`. [read: from AGENTS.md]

Flux de masquage d'une requête provider :
```
route → extractor provider (src/masking/extractors/) : spans de texte + rôle
      → PIIDetector.analyzeRequest (filtre scan_roles, HTTP /analyze par span, merge denylist/allowlist)
      → masquage [[TYPE_n]] via PlaceholderContext (counters + mapping)
      → forward provider (src/providers/<x>/client)
      → restauration : non-stream = unmaskResponse de l'extractor ;
                       stream = StreamRestorer + stream-transformer du provider
```
[read: from src/pii/detect.ts, src/masking/*, src/providers/*]

## Invariants (chacun a coûté un bug ; histoire complète dans `failure-archaeology`)

1. **Placeholders `[[TYPE_n]]` à doubles crochets, source unique `src/masking/placeholders.ts`.** L'ancien format `<TYPE_N>` était encodé en entités HTML par certains clients et devenait indémasquable (#36/#38). Le format n'est PAS configurable : l'option `redact_placeholder` a été supprimée car le streaming le hardcodait. [read: from commit d239944]
2. **Secrets masqués AVANT la PII**, dans `/api/mask` comme dans les routes provider. Sinon la détection PII masque le `pass@host` d'une chaîne de connexion comme un email et le pattern CONNECTION_STRING ne matche plus. [read: from src/routes/api.ts, commit 08ddb1d]
3. **Scans détecteur SÉQUENTIELS** : `analyzeRequest` boucle en for/await, jamais en `Promise.all`. L'inférence torch du détecteur est sérialisée par un verrou : paralléliser côté proxy empile les requêtes jusqu'au timeout (#135). Timeout par requête via `AbortSignal.timeout` (`detector_timeout`). [read: from src/pii/detect.ts, git show 3fe543a]
4. **Offsets en unités de code UTF-16.** Le détecteur Python convertit ses offsets (`_utf16_mapper`) parce que le JS découpe en UTF-16 : un emoji avant un span désalignerait le masque. Tout nouveau consommateur d'offsets doit respecter cette unité. [read: from detector/detector/app.py]
5. **Résolution de conflits d'entités en deux phases** (`src/masking/conflict-resolver.ts`, style Presidio Anonymizer) : merge des chevauchements de même type, puis élimination inter-types (contenu ou score inférieur perd). Correctif de la corruption de texte #33. [read: from commit dbb221a]
6. **Le serveur ne démarre pas sans détecteur** : le modèle est chargé avant de servir côté Python (lifespan FastAPI), donc `/health` détecteur == prêt ; PasteGuard poll ce `/health` au boot. [read: from detector/detector/app.py, src/index.ts]

## Contrats d'API internes

### `POST /api/mask` (moteur local, utilisé par la campagne hooks)

Requête : `{text: string non vide (trimmé), startFrom?: Record<type, number>, detect?: ("pii"|"secrets")[]}`
Réponse 200 : `{masked, context (placeholder→valeur), counters, entities: [{type, placeholder}]}`
Erreurs : 400 validation (dont texte vide), 503 détection indisponible.
**Chaque appel repart d'un mapping VIDE ; seuls les counters se propagent via `startFrom`.** Une même valeur vue dans deux appels reçoit deux placeholders différents : la déduplication inter-appels est à la charge du CLIENT (décision D5 de la campagne, voir `hooks-mvp-campaign`). [read: from src/routes/api.ts, plans/PLAN.md]

### `POST /analyze` (détecteur Python)

`{text, phone_regions?, entities?, score_threshold}` → `[{entity_type, start, end, score}]`, offsets UTF-16 (invariant 4). [read: from detector/detector/app.py]

## Périmètre fork (règle de territoire)

- `src/` = code amont (sgasser/pasteguard) : y travailler uniquement pour des correctifs PR-ables upstream, en suivant les patterns route/provider/extractor existants (AGENTS.md).
- Le travail propre au fork (hooks Claude Code) vit dans `integrations/claude-code/` (à créer au lot 2) : scripts autonomes, AUCUN import depuis `src/`, communication avec le moteur uniquement en HTTP (`/api/mask`, `/health`). Décisions D1-D3. [read: from plans/PLAN.md]
- Ne pas modifier le moteur pour la campagne hooks (décision actée, PROGRESS.md).

## Dashboard et logging

Dashboard JSX Hono (`src/views/dashboard/page.tsx`) ; logs par requête via kysely (SQLite ou Postgres) ; source trackée par header `x-pasteguard-source` (extension navigateur comptée à part, #107) ; aperçu limité aux rôles scannés (#115). [read: from src/routes/api.ts, src/logging/*]

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Re-vérifications :
- `grep -n "for.*await\|Promise.all" src/pii/detect.ts` (invariant 3)
- `grep -rn "\[\[" src/masking/placeholders.ts` (invariant 1)
- `grep -n "utf16\|_utf16" detector/detector/app.py` (invariant 4)
- `curl -s localhost:3000/api/mask -H 'content-type: application/json' -d '{"text":"test jean.dupont@example.com"}'` (contrat, services démarrés)
