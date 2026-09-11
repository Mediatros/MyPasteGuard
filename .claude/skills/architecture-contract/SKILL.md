---
name: architecture-contract
description: The load-bearing design decisions of PasteGuard and the invariants never to break — full masking flow, [[TYPE_n]] placeholder format, secrets-before-PII order, UTF-16 offsets, sequential detector scans, POST /api/mask and /analyze contracts, fork scope (src/ vs integrations/). Load before any change to the masking flow, extractors, providers, or routes, to understand "how it works", or when a choice looks odd and you're tempted to "fix" it.
---

# Architecture contract — PasteGuard

## When NOT to use this skill

- For detection semantics (GLiNER, merging, denylist) → skill `domain-reference`.
- For the history of bugs behind these invariants → skill `failure-archaeology`.
- For the Claude Code hooks campaign → skill `hooks-mvp-campaign`.

## Overview

`src/index.ts`: middlewares (X-Request-ID, cors, logger) then mounts `/` (health, info), `/openai`, `/anthropic`, `/codex`, `/api`, `/dashboard`. On boot: config validation, waiting for the detector (exit 1 if absent), log cleanup scheduler, graceful SIGTERM/SIGINT shutdown. [read: from src/index.ts]

Primary endpoints: `POST /openai/v1/chat/completions`, `POST /anthropic/v1/messages`, `POST /codex/responses`, `GET /health`, `GET /info`. [read: from AGENTS.md]

Masking flow for a provider request:
```
route → provider extractor (src/masking/extractors/): text spans + role
      → PIIDetector.analyzeRequest (scan_roles filter, HTTP /analyze per span, denylist/allowlist merge)
      → [[TYPE_n]] masking via PlaceholderContext (counters + mapping)
      → forward to provider (src/providers/<x>/client)
      → restoration: non-stream = extractor's unmaskResponse;
                     stream = StreamRestorer + provider stream-transformer
```
[read: from src/pii/detect.ts, src/masking/*, src/providers/*]

## Invariants (each one cost a bug; full history in `failure-archaeology`)

1. **Double-bracket `[[TYPE_n]]` placeholders, single source `src/masking/placeholders.ts`.** The old `<TYPE_N>` format was HTML-entity-encoded by some clients and became impossible to unmask (#36/#38). The format is NOT configurable: the `redact_placeholder` option was removed because streaming hardcoded it. [read: from commit d239944]
2. **Secrets are masked BEFORE PII**, both in `/api/mask` and in the provider routes. Otherwise PII detection masks the `pass@host` part of a connection string as an email and the CONNECTION_STRING pattern no longer matches. [read: from src/routes/api.ts, commit 08ddb1d]
3. **Detector scans are SEQUENTIAL**: `analyzeRequest` loops with for/await, never `Promise.all`. The detector's torch inference is serialized by a lock: parallelizing on the proxy side queues requests up to the timeout (#135). Per-request timeout via `AbortSignal.timeout` (`detector_timeout`). [read: from src/pii/detect.ts, git show 3fe543a]
4. **Offsets are in UTF-16 code units.** The Python detector converts its offsets (`_utf16_mapper`) because JS splits in UTF-16: an emoji before a span would misalign the mask. Any new offset consumer must respect this unit. [read: from detector/detector/app.py]
5. **Two-phase entity conflict resolution** (`src/masking/conflict-resolver.ts`, Presidio Anonymizer style): merge overlaps of the same type, then cross-type elimination (lower content or score loses). Fix for text-corruption bug #33. [read: from commit dbb221a]
6. **The server does not start without the detector**: the model is loaded before serving on the Python side (FastAPI lifespan), so detector `/health` == ready; PasteGuard polls this `/health` at boot. [read: from detector/detector/app.py, src/index.ts]

## Internal API contracts

### `POST /api/mask` (local engine, used by the hooks campaign)

Request: `{text: non-empty string (trimmed), startFrom?: Record<type, number>, detect?: ("pii"|"secrets")[]}`
Response 200: `{masked, context (placeholder→value), counters, entities: [{type, placeholder}]}`
Errors: 400 validation (including empty text), 503 detection unavailable.
**Each call starts from an EMPTY mapping; only the counters propagate via `startFrom`.** The same value seen across two calls gets two different placeholders: cross-call deduplication is the CLIENT's responsibility (campaign decision D5, see `hooks-mvp-campaign`). [read: from src/routes/api.ts, plans/PLAN.md (local working notes, not committed)]

### `POST /analyze` (Python detector)

`{text, phone_regions?, entities?, score_threshold}` → `[{entity_type, start, end, score}]`, UTF-16 offsets (invariant 4). [read: from detector/detector/app.py]

## Fork scope (territory rule)

- `src/` = upstream code (sgasser/pasteguard): work here only for upstream-PR-able fixes, following the existing route/provider/extractor patterns (AGENTS.md).
- Fork-specific work (Claude Code hooks) lives in `integrations/claude-code/` (to be created at batch 2): standalone scripts, NO imports from `src/`, communication with the engine only over HTTP (`/api/mask`, `/health`). Decisions D1-D3. [read: from plans/PLAN.md]
- Do not modify the engine for the hooks campaign (decision recorded, PROGRESS.md).

## Dashboard and logging

Hono JSX dashboard (`src/views/dashboard/page.tsx`); per-request logs via kysely (SQLite or Postgres); source tracked via the `x-pasteguard-source` header (browser extension counted separately, #107); preview limited to scanned roles (#115). [read: from src/routes/api.ts, src/logging/*]

## Provenance and maintenance

Written on 2026-07-07 following a full repository audit. Re-checks:
- `grep -n "for.*await\|Promise.all" src/pii/detect.ts` (invariant 3)
- `grep -rn "\[\[" src/masking/placeholders.ts` (invariant 1)
- `grep -n "utf16\|_utf16" detector/detector/app.py` (invariant 4)
- `curl -s localhost:3000/api/mask -H 'content-type: application/json' -d '{"text":"test jean.dupont@example.com"}'` (contract, services running)
