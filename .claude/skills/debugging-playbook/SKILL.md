---
name: debugging-playbook
description: Symptom → action triage table for real PasteGuard failures — spurious Prettier errors, detector 503/timeout, 400 on /api/mask, tests leaking their mocks, server refusing to start, port already in use, mysterious 401 with Claude Code. Load as soon as unexpected behavior, an error, or a test failure appears, BEFORE improvising a fix.
---

# Debugging Playbook — PasteGuard

Reflex: identify the symptom in the table, run the discriminating experiment, only then fix. Most of these traps have already cost time (full stories in `failure-archaeology`).

## When NOT to use this skill

- The behavior is "weird but intentional" (secrets→PII order, sequential scans...) → skill `architecture-contract` first.
- An entity is misdetected but there is no error → skill `domain-reference`.
- Failure in the hooks campaign (session store, Claude Code hooks) → skill `hooks-mvp-campaign`.

## Triage table

| Symptom | Likely cause | Discriminating experiment | Action |
|---|---|---|---|
| Prettier/ESLint errors shown after an edit | GLOBAL machine formatting hook, not the project | `bun run check`: if green, the project is clean | Ignore the noise; run `bun run format` before validating [read: from PROGRESS.md] |
| `503` on `/api/mask` or the provider routes | Detector down or not ready yet | `docker compose ps` then `docker compose logs detector --tail 20` | Start/wait for the detector; first boot = model download, several minutes [read: from plans/01-environnement.md (local working notes, not committed)] |
| Server does `exit 1` immediately at boot | Detector unreachable (waits on `PASTEGUARD_STARTUP_TIMEOUT`, 180 s) or invalid config (`route_local` + mask mode) | Read the boot message; `curl -s localhost:5002/health` | Start the detector or fix config.yaml (guards: `config-and-flags`) |
| `400` on `/api/mask` | `text` empty or blank (trimmed server-side) | Replay the curl with non-empty text | Handle the empty-text case CLIENT-SIDE without calling the API [read: from plans/01-environnement.md] |
| Detector timeouts on large payloads or multiple calls | Serialized torch inference (`_infer_lock`): concurrency piles up | Measure a single call vs several simultaneous ones | NEVER parallelize scans (invariant 3 of `architecture-contract`); adjust `detector_timeout` (#137) |
| A route test fails depending on file execution order | PII detector mock leaking between files (already happened, #85) | Run the file alone: `bun test src/routes/<x>.test.ts` | Isolate the mock in the file; model fix: `ed7fb19` |
| Restoration broken in streaming (placeholder cut off, invalid JSON) | SSE chunk cut mid-line or mid-placeholder | Reproduce with a stream-transformer test splitting chunks in the middle | Follow the stream-transformers' buffering patterns (#84, #112); do not assume chunks = lines |
| Port 3000 already in use | Another instance or another service | `lsof -i :3000` | Change `server.port` and propagate it everywhere (see plans/01, documented pitfall) |
| `401 invalid x-api-key` when using Claude Code through a proxy | The claude binary does NOT attach OAuth outside api.anthropic.com | NONE: known and definitive dead end | STOP, do not debug. Read `failure-archaeology` (approach 1) |

## Local golden rule

A signal that looks like a known failure can have a different cause: check the discriminating experiment before applying the action, especially before any restart or config change.

## Provenance and maintenance

Written on 2026-07-07 via a full repository audit. Re-checks:
- `docker compose ps` and `curl -s localhost:5002/health` (detector state)
- `git log --oneline -3` (new fixes to add to the table)
