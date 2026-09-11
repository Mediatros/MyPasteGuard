---
name: config-and-flags
description: All PasteGuard configuration axes — config.yaml (mode, providers, masking allowlist/denylist, pii_detection, secrets_detection, scan_roles, logging, dashboard), environment variables, Zod defaults and guards, and the checklist for adding an option. Load as soon as a question touches config.yaml, a default, an environment variable, a flag, or "why is this behavior enabled/disabled".
---

# Configuration and Flags — PasteGuard

Source of truth for loading: `src/config.ts` (`loadConfig`), Zod validation, tests in `src/config.test.ts`. [read: from src/config.ts]

## When NOT to use this skill

- To start the environment → skill `build-and-env`.
- For the endpoint contract and the masking flow → skill `architecture-contract`.
- For fine-grained detection semantics (GLiNER floors, merge) → skill `domain-reference`.

## Loading

`loadConfig` tries, in order: `./config.yaml`, `./config.yml`, `./config.example.yaml`. Explicit error if the path is a directory (#3). Recursive `${VAR}` and `${VAR:-default}` substitution BEFORE Zod validation. Singleton via `getConfig()`. [read: from src/config.ts]

The local `config.yaml` differs from `config.example.yaml` only by the commented-out `local:` block; it is excluded from git (`.git/info/exclude`, see `build-and-env`). [verified: executed diff 2026-07-07]

## Configuration axes

| Axis | Keys and defaults | Notes |
|---|---|---|
| `mode` | `mask` \| `route` | Zod default = `route`, but config.example.yaml sets `mask`. `route` REQUIRES a `local:` block (Zod refine). |
| `server` | port 3000, host 0.0.0.0, `request_timeout` 600 s (0 = off) | |
| `providers` | `openai` (required), `anthropic`, `codex`: `base_url` + optional `api_key` fallback | The proxy forwards the client's auth; the config key is only a fallback. |
| `local` | type `ollama` \| `openai`, base_url, model | Used only in route mode. |
| `masking` | `show_markers` false, `marker_text` "[protected]", `allowlist`, `denylist` | Markers also applied to restored secrets (#122). |
| `pii_detection` | `enabled` true, `detector_url` (required, e.g. `${DETECTOR_URL:-http://localhost:5002}`), `detector_timeout` 30 s (0 = off, #137), `phone_regions` [] (= international `+`-only formats, #111), `score_threshold` 0.7, `entities` | Default entities: PERSON, LOCATION, EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, IBAN_CODE, IP_ADDRESS, VAT_CODE. |
| `secrets_detection` | `enabled` true, `action` mask \| block \| route_local, 10 types all active by default (#106), `max_scan_chars` 200000 (0 = all), `log_detected_types` true | Types: OPENSSH_PRIVATE_KEY, PEM_PRIVATE_KEY, API_KEY_SK, API_KEY_AWS, API_KEY_GITHUB, JWT_TOKEN, BEARER_TOKEN, ENV_PASSWORD, ENV_SECRET, CONNECTION_STRING. |
| `scan_roles` (PII and secrets separately) | default `[user, tool, function, mcp]`; known roles: + system, developer, assistant; empty list → falls back to the default | Introduced by #115 to stop masking context injected by the harness (system-reminder, environment_context). See the history of this doctrine in `failure-archaeology` (entry I). |
| `logging` | driver `sqlite` (default, `./data/pasteguard.db`) \| `postgres` (requires `postgres_url`, #127), `retention_days` 30 (0 = unlimited, cleanup at boot then daily), `log_masked_content` true | |
| `dashboard` | `enabled` true, optional basic auth | |

[read: from src/config.ts and config.example.yaml]

## Guards and incompatibilities

- `secrets_detection.action: route_local` is incompatible with `mode: mask`: double guard, Zod refine + startup validation with `process.exit(1)`. [read: from src/config.ts, src/index.ts]
- Default allowlist HARDCODED (`DEFAULT_ALLOWLIST`, prepended to any user allowlist): the phrase "You are Claude Code, Anthropic's official CLI for Claude." is never masked. [read: from src/config.ts]
- Allowlist regex: anchored `^(?:pattern)$` on the detected entity; a pattern matching the empty string is rejected at validation. Denylist: pattern + type (+ regex), score forced to 1. Renamed from `whitelist` in #104. [read: from src/config.ts, src/pii/detect.ts]

## Environment variables outside config.yaml

| Variable | Role | Default |
|---|---|---|
| `PASTEGUARD_STARTUP_TIMEOUT` | wait for the detector at boot | 180 s |
| `DETECTOR_URL` / `DETECTOR_TIMEOUT` | substituted in config.example.yaml | :5002 / 30 s |
| `PASTEGUARD_PORT` / `PASTEGUARD_DETECTOR_PORT` | docker-compose ports | 3000 / 5002 |
| `DETECTOR_MODEL`, `DETECTOR_MODEL_PATH`, `DETECTOR_MAX_TOKENS` (384), `DETECTOR_FLOOR_PERSON\|LOCATION\|ADDRESS` | detector-side (Python) | see `domain-reference` |

[read: from src/index.ts, docker/Dockerfile, detector/detector/gliner_layer.py]

## Checklist: adding a config option

1. Zod schema + default in `src/config.ts` (respect existing refines).
2. Test case in `src/config.test.ts` (default, explicit value, invalid value).
3. Document in `config.example.yaml` (comment + default value).
4. If the option is public: update `docs/configuration/*.mdx` (AGENTS.md rule, see `change-control`).
5. `bun test && bun run typecheck && bun run check` (see `validation-and-qa`).

## Provenance and maintenance

Written on 2026-07-07 via a full repository audit. Re-checks:
- `diff config.yaml config.example.yaml` (local drift)
- `grep -n "DEFAULT_ALLOWLIST\|scan_roles\|detector_timeout" src/config.ts` (guards)
- `git log --oneline -3 -- src/config.ts` (recent changes)
