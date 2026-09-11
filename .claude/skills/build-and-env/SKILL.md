---
name: build-and-env
description: Recreate and run the PasteGuard environment from scratch — install Bun, start the Docker PII detector, run the server in dev or prod, understand Biome/tsconfig/Dockerfile/Conductor. Load for any "how to install", "how to run", "which npm/bun script" question, for the detector's first startup, or before touching the Dockerfile or docker-compose. (A server that refuses to start = symptom → skill debugging-playbook.)
---

# Build and environment — PasteGuard

Repository: `/Users/jb/Documents/MyProjects/pasteguard`. Runtime: Bun (1.2.17 installed locally, CI on `latest`) [verified: executed 2026-07-07].

## When NOT to use this skill

- For the meaning of `config.yaml` options → skill `config-and-flags`.
- For pre-delivery validation commands (tests, CI) → skill `validation-and-qa`.
- For the internal workings of masking → skill `architecture-contract`.

## Getting started from scratch

```bash
cd /Users/jb/Documents/MyProjects/pasteguard
bun install
cp config.example.yaml config.yaml    # only if config.yaml is absent
docker compose --profile dev up detector -d   # PII detector on :5002
bun run dev                            # Hono server on :3000, hot reload
```

Sequence taken from CONTRIBUTING.md [read: from CONTRIBUTING.md]. First detector startup: the container downloads the GLiNER model, allow several minutes [read: from plans/01-environnement.md (local working notes, not committed)]. The server waits for the detector at boot and does `exit 1` if unreachable after `PASTEGUARD_STARTUP_TIMEOUT` (default 180s) [read: from src/index.ts].

## Available scripts (package.json)

| Command | Effect |
|---|---|
| `bun run dev` | server with hot reload (`bun run --hot src/index.ts`) |
| `bun run start` | production server |
| `bun run build` | build to `dist/` (`--external lightningcss`) |
| `bun test` | test suite (see `validation-and-qa`) |
| `bun run typecheck` / `typecheck:benchmarks` | `tsc --noEmit` |
| `bun run check` / `lint` / `format` | Biome on `src` + `benchmarks/pii-accuracy/*.ts` |
| `bun run benchmark:accuracy` | PII accuracy benchmark (detector required) |

[read: from package.json]

## Docker execution modes

- **Prod all-in-one**: `docker compose up -d` → image `ghcr.io/sgasser/pasteguard:latest` (proxy + detector under supervisord in a single container). Mounts `./config.yaml` (ro) and `./data`.
- **Dev**: `docker compose --profile dev up detector -d` (service `detector`, port `${PASTEGUARD_DETECTOR_PORT:-5002}`) + local proxy `bun run dev` with `DETECTOR_URL=http://localhost:5002`. The `detector` service builds the `detector` target of the SAME `docker/Dockerfile`: a single detector definition. [read: from docker-compose.yml]

Dashboard: http://localhost:3000 (the root `/` redirects to the dashboard or `/health`); request logs in SQLite `./data/pasteguard.db` [read: from config.example.yaml, commit 917b38e].

## Dockerfile pitfalls (do not "simplify")

Two choices in `docker/Dockerfile` have a history; undoing them reintroduces bugs:

1. The Bun binary is COPIED from `oven/bun:1-slim` ("baseline" x64 build, SSE4.2 only), not installed via script: fix for the SIGILL crash on CPUs without AVX2 (#70). [read: from docker/Dockerfile]
2. The image creates a real UID 1000 user with a home directory (`useradd --create-home`): torch resolves its cache via `getpwuid()` at import time and fails with a bare numeric USER; UID 1000 also aligns volumes with a typical Linux host (#77). [read: from docker/Dockerfile]

The GLiNER model is baked into the image (`HF_HOME=/opt/models`, 3 fetch attempts, then `HF_HUB_OFFLINE=1`); torch is installed CPU-only via the dedicated PyTorch index to avoid ~6GB of CUDA. [read: from docker/Dockerfile]

## Lint and style

- Biome covers ONLY `src/**/*.ts` and `benchmarks/pii-accuracy/*.ts` (`biome.json` `files.includes`). Any code outside these paths (e.g. a future `integrations/`) escapes lint until the config is extended (planned for batch 2 of the hooks campaign, decision D11). [read: from biome.json, plans/PLAN.md (local working notes, not committed)]
- Style: 2-space indent, lineWidth 100, double quotes, semicolons always, trailingCommas all; `noForEach` and `noNonNullAssertion` rules disabled. [read: from biome.json]
- tsconfig: strict, moduleResolution bundler, types `["bun"]`, Hono JSX (`jsxImportSource: hono/jsx`) — the dashboard is Hono JSX, NOT React. [read: from tsconfig.json]

## Local git exclusions

Several working files are excluded via `.git/info/exclude` and exist ONLY on this machine (list and commit rules: skill `change-control`). Never assume a CI run or a fresh clone sees them. Re-check: `cat .git/info/exclude`.

## Conductor workspaces

`.conductor/settings.toml`: setup = `bun install` + seed config.yaml if absent + port rewritten to `${PASTEGUARD_PORT:-3000}`; run = port `CONDUCTOR_PORT`, detector on port+1, `DETECTOR_URL` exported, compose project `pasteguard-<port>`; archive = compose down. [read: from .conductor/settings.toml]

## Provenance and maintenance

Written on 2026-07-07 following a full repository audit. Re-checks:
- `bun --version` (runtime version)
- `cat .git/info/exclude` (local exclusions)
- `grep -A3 '"scripts"' package.json` (scripts)
- `grep -n includes biome.json` (lint scope)
