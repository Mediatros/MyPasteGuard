---
name: build-and-env
description: Recréer et faire tourner l'environnement PasteGuard de zéro — installer Bun, démarrer le détecteur PII Docker, lancer le serveur en dev ou prod, comprendre Biome/tsconfig/Dockerfile/Conductor. À charger pour toute question « comment installer », « comment lancer », « quel script npm/bun », pour le premier démarrage du détecteur, ou avant de toucher au Dockerfile ou à docker-compose. (Un serveur qui refuse de démarrer = symptôme → skill debugging-playbook.)
---

# Build et environnement — PasteGuard

Dépôt : `/Users/jb/Documents/MyProjects/pasteguard`. Runtime : Bun (1.2.17 installé localement, CI en `latest`) [verified: executed 2026-07-07].

## Quand NE PAS utiliser cette skill

- Pour la signification des options de `config.yaml` → skill `config-and-flags`.
- Pour les commandes de validation avant livraison (tests, CI) → skill `validation-and-qa`.
- Pour le fonctionnement interne du masquage → skill `architecture-contract`.

## Mise en route de zéro

```bash
cd /Users/jb/Documents/MyProjects/pasteguard
bun install
cp config.example.yaml config.yaml    # seulement si config.yaml absent
docker compose --profile dev up detector -d   # détecteur PII sur :5002
bun run dev                            # serveur Hono sur :3000, hot reload
```

Séquence issue de CONTRIBUTING.md [read: from CONTRIBUTING.md]. Premier démarrage du détecteur : le conteneur télécharge le modèle GLiNER, prévoir plusieurs minutes [read: from plans/01-environnement.md]. Le serveur attend le détecteur au boot et fait `exit 1` s'il est injoignable après `PASTEGUARD_STARTUP_TIMEOUT` (défaut 180 s) [read: from src/index.ts].

## Scripts disponibles (package.json)

| Commande | Effet |
|---|---|
| `bun run dev` | serveur avec hot reload (`bun run --hot src/index.ts`) |
| `bun run start` | serveur production |
| `bun run build` | build vers `dist/` (`--external lightningcss`) |
| `bun test` | suite de tests (voir `validation-and-qa`) |
| `bun run typecheck` / `typecheck:benchmarks` | `tsc --noEmit` |
| `bun run check` / `lint` / `format` | Biome sur `src` + `benchmarks/pii-accuracy/*.ts` |
| `bun run benchmark:accuracy` | benchmark de précision PII (détecteur requis) |

[read: from package.json]

## Modes d'exécution Docker

- **Prod all-in-one** : `docker compose up -d` → image `ghcr.io/sgasser/pasteguard:latest` (proxy + détecteur sous supervisord dans un seul conteneur). Monte `./config.yaml` (ro) et `./data`.
- **Dev** : `docker compose --profile dev up detector -d` (service `detector`, port `${PASTEGUARD_DETECTOR_PORT:-5002}`) + proxy local `bun run dev` avec `DETECTOR_URL=http://localhost:5002`. Le service `detector` build la cible `detector` du MÊME `docker/Dockerfile` : une seule définition du détecteur. [read: from docker-compose.yml]

Dashboard : http://localhost:3000 (la racine `/` redirige vers le dashboard ou `/health`) ; logs de requêtes en SQLite `./data/pasteguard.db` [read: from config.example.yaml, commit 917b38e].

## Pièges du Dockerfile (ne pas « simplifier »)

Deux choix du `docker/Dockerfile` ont une histoire ; les défaire réintroduit des bugs :

1. Le binaire Bun est COPIÉ depuis `oven/bun:1-slim` (build « baseline » x64, SSE4.2 seulement), pas installé par script : correctif du crash SIGILL sur CPU sans AVX2 (#70). [read: from docker/Dockerfile]
2. L'image crée un vrai utilisateur UID 1000 avec home (`useradd --create-home`) : torch résout son cache via `getpwuid()` à l'import et échoue avec un USER numérique nu ; UID 1000 aligne aussi les volumes avec l'hôte Linux typique (#77). [read: from docker/Dockerfile]

Le modèle GLiNER est baké dans l'image (`HF_HOME=/opt/models`, 3 tentatives de fetch, puis `HF_HUB_OFFLINE=1`) ; torch est installé CPU-only via l'index PyTorch dédié pour éviter ~6 Go de CUDA. [read: from docker/Dockerfile]

## Lint et style

- Biome ne couvre QUE `src/**/*.ts` et `benchmarks/pii-accuracy/*.ts` (`biome.json` `files.includes`). Tout code hors de ces chemins (ex. futur `integrations/`) échappe au lint tant que la config n'est pas étendue (prévu au lot 2 de la campagne hooks, décision D11). [read: from biome.json, plans/PLAN.md]
- Style : indent 2 espaces, lineWidth 100, doubles quotes, semicolons always, trailingCommas all ; règles `noForEach` et `noNonNullAssertion` désactivées. [read: from biome.json]
- tsconfig : strict, moduleResolution bundler, types `["bun"]`, JSX Hono (`jsxImportSource: hono/jsx`) — le dashboard est du JSX Hono, PAS du React. [read: from tsconfig.json]

## Exclusions git locales

Plusieurs fichiers de travail sont exclus via `.git/info/exclude` et n'existent QUE sur cette machine (liste et règles de commit : skill `change-control`). Ne jamais supposer qu'un CI ou un clone frais les voit. Re-vérification : `cat .git/info/exclude`.

## Workspaces Conductor

`.conductor/settings.toml` : setup = `bun install` + seed de config.yaml si absent + port réécrit en `${PASTEGUARD_PORT:-3000}` ; run = port `CONDUCTOR_PORT`, détecteur sur port+1, `DETECTOR_URL` exporté, projet compose `pasteguard-<port>` ; archive = compose down. [read: from .conductor/settings.toml]

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Re-vérifications :
- `bun --version` (version runtime)
- `cat .git/info/exclude` (exclusions locales)
- `grep -A3 '"scripts"' package.json` (scripts)
- `grep -n includes biome.json` (périmètre lint)
