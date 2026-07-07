---
name: config-and-flags
description: Tous les axes de configuration PasteGuard — config.yaml (mode, providers, masking allowlist/denylist, pii_detection, secrets_detection, scan_roles, logging, dashboard), variables d'environnement, défauts et gardes Zod, et la checklist pour ajouter une option. À charger dès qu'une question touche config.yaml, un défaut, une variable d'env, un flag, ou « pourquoi ce comportement est-il activé/désactivé ».
---

# Configuration et flags — PasteGuard

Source de vérité du chargement : `src/config.ts` (`loadConfig`), validation Zod, tests dans `src/config.test.ts`. [read: from src/config.ts]

## Quand NE PAS utiliser cette skill

- Pour démarrer l'environnement → skill `build-and-env`.
- Pour le contrat des endpoints et le flux de masquage → skill `architecture-contract`.
- Pour la sémantique fine de détection (floors GLiNER, fusion) → skill `domain-reference`.

## Chargement

`loadConfig` essaie dans l'ordre : `./config.yaml`, `./config.yml`, `./config.example.yaml`. Erreur explicite si le chemin est un répertoire (#3). Substitution `${VAR}` et `${VAR:-default}` récursive AVANT validation Zod. Singleton via `getConfig()`. [read: from src/config.ts]

Le `config.yaml` local ne diffère de `config.example.yaml` que par le bloc `local:` commenté ; il est exclu de git (`.git/info/exclude`, voir `build-and-env`). [verified: executed diff 2026-07-07]

## Axes de configuration

| Axe | Clés et défauts | Notes |
|---|---|---|
| `mode` | `mask` \| `route` | Défaut Zod = `route`, mais config.example.yaml fixe `mask`. `route` EXIGE un bloc `local:` (refine Zod). |
| `server` | port 3000, host 0.0.0.0, `request_timeout` 600 s (0 = off) | |
| `providers` | `openai` (requis), `anthropic`, `codex` : `base_url` + `api_key` fallback optionnel | Le proxy forwarde l'auth du client ; la clé config n'est qu'un fallback. |
| `local` | type `ollama` \| `openai`, base_url, model | Utilisé seulement en mode route. |
| `masking` | `show_markers` false, `marker_text` "[protected]", `allowlist`, `denylist` | Marqueurs appliqués aussi aux secrets restaurés (#122). |
| `pii_detection` | `enabled` true, `detector_url` (requis, ex. `${DETECTOR_URL:-http://localhost:5002}`), `detector_timeout` 30 s (0 = off, #137), `phone_regions` [] (= formats internationaux `+` uniquement, #111), `score_threshold` 0.7, `entities` | Entités par défaut : PERSON, LOCATION, EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, IBAN_CODE, IP_ADDRESS, VAT_CODE. |
| `secrets_detection` | `enabled` true, `action` mask \| block \| route_local, 10 types tous actifs par défaut (#106), `max_scan_chars` 200000 (0 = tout), `log_detected_types` true | Types : OPENSSH_PRIVATE_KEY, PEM_PRIVATE_KEY, API_KEY_SK, API_KEY_AWS, API_KEY_GITHUB, JWT_TOKEN, BEARER_TOKEN, ENV_PASSWORD, ENV_SECRET, CONNECTION_STRING. |
| `scan_roles` (PII et secrets séparément) | défaut `[user, tool, function, mcp]` ; rôles connus : + system, developer, assistant ; liste vide → retombe sur le défaut | Introduit par #115 pour ne plus masquer le contexte injecté par le harnais (system-reminder, environment_context). Voir l'historique de cette doctrine dans `failure-archaeology` (entrée I). |
| `logging` | driver `sqlite` (défaut, `./data/pasteguard.db`) \| `postgres` (exige `postgres_url`, #127), `retention_days` 30 (0 = infini, nettoyage au boot puis quotidien), `log_masked_content` true | |
| `dashboard` | `enabled` true, basic auth optionnelle | |

[read: from src/config.ts et config.example.yaml]

## Gardes et incompatibilités

- `secrets_detection.action: route_local` est incompatible avec `mode: mask` : double garde, refine Zod + validation au démarrage avec `process.exit(1)`. [read: from src/config.ts, src/index.ts]
- Allowlist par défaut CODÉE EN DUR (`DEFAULT_ALLOWLIST`, préfixée à toute allowlist utilisateur) : la phrase « You are Claude Code, Anthropic's official CLI for Claude. » n'est jamais masquée. [read: from src/config.ts]
- Allowlist regex : ancrée `^(?:pattern)$` sur l'entité détectée ; motif matchant la chaîne vide rejeté à la validation. Denylist : pattern + type (+ regex), score forcé à 1. Renommée depuis `whitelist` en #104. [read: from src/config.ts, src/pii/detect.ts]

## Variables d'environnement hors config.yaml

| Variable | Rôle | Défaut |
|---|---|---|
| `PASTEGUARD_STARTUP_TIMEOUT` | attente du détecteur au boot | 180 s |
| `DETECTOR_URL` / `DETECTOR_TIMEOUT` | substituées dans config.example.yaml | :5002 / 30 s |
| `PASTEGUARD_PORT` / `PASTEGUARD_DETECTOR_PORT` | ports docker-compose | 3000 / 5002 |
| `DETECTOR_MODEL`, `DETECTOR_MODEL_PATH`, `DETECTOR_MAX_TOKENS` (384), `DETECTOR_FLOOR_PERSON\|LOCATION\|ADDRESS` | côté détecteur Python | voir `domain-reference` |

[read: from src/index.ts, docker/Dockerfile, detector/detector/gliner_layer.py]

## Checklist : ajouter une option de config

1. Schéma Zod + défaut dans `src/config.ts` (respecter les refine existants).
2. Cas de test dans `src/config.test.ts` (défaut, valeur explicite, valeur invalide).
3. Documenter dans `config.example.yaml` (commentaire + valeur par défaut).
4. Si l'option est publique : mettre à jour `docs/configuration/*.mdx` (règle AGENTS.md, voir `change-control`).
5. `bun test && bun run typecheck && bun run check` (voir `validation-and-qa`).

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Re-vérifications :
- `diff config.yaml config.example.yaml` (dérive locale)
- `grep -n "DEFAULT_ALLOWLIST\|scan_roles\|detector_timeout" src/config.ts` (gardes)
- `git log --oneline -3 -- src/config.ts` (évolutions récentes)
