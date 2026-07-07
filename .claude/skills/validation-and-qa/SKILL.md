---
name: validation-and-qa
description: Ce qui compte comme preuve dans PasteGuard — commandes de test/typecheck/lint avec leurs états attendus exacts, jobs CI, benchmark de précision PII, comment ajouter des tests. À charger avant de déclarer un travail « terminé », après toute modification de code, ou quand la CI échoue.
---

# Validation et QA — PasteGuard

Règle de la maison : rien n'est « fait » sans commande exécutée et sortie observée. « Ça devrait marcher » n'est pas un état.

## Quand NE PAS utiliser cette skill

- Pour les règles de commit et les territoires → skill `change-control`.
- Pour diagnostiquer un test qui échoue bizarrement → skill `debugging-playbook`.

## Le triptyque obligatoire avant livraison

```bash
bun test && bun run typecheck && bun run check
```

États attendus (mesurés le 2026-07-07 sur la branche `fix/claude-code-transparency`, arbre modifié inclus) [verified: executed] :

| Commande | Attendu |
|---|---|
| `bun test` | **430 pass, 1 skip, 0 fail** — 431 tests, 31 fichiers, ~300 ms. Le seul skip est « Logger Postgres backend … against Postgres » (exige un Postgres réel). |
| `bun run typecheck` | exit 0, aucune sortie d'erreur |
| `bun run typecheck:benchmarks` | exit 0 |
| `bun run check` | « Checked 83 files … No fixes applied. » |

Si `bun test` affiche plus d'un skip ou le moindre fail : le travail n'est pas livrable. Si le hook de formatage global affiche des erreurs Prettier/ESLint, c'est du bruit — voir `debugging-playbook`.

## CI GitHub (`.github/workflows/ci.yml`, push et PR sur main)

| Job | Étapes |
|---|---|
| `test` | `bun install --frozen-lockfile` → typecheck → typecheck:benchmarks → check → bun test |
| `detector` | Python 3.11 venv → torch CPU → `ruff check .` → `ruff format . --check` → `pyright` → `pytest -q` (dans `detector/`) |
| `docker-build` | build de l'image all-in-one `docker/Dockerfile` |

[read: from .github/workflows/ci.yml]

Les tests Python du détecteur n'ont PAS été exécutés localement (pas de venv présent) ; seule la CI les garantit. Pour les lancer localement, reproduire les étapes du job `detector`. [inferred: unconfirmed localement]

Release : sur tag `v*`, build multi-arch (amd64+arm64) poussé vers ghcr.io `:latest` et `:<version>` (`release.yml`). `.github/secret_scanning.yml` exclut `src/**/*.test.ts` du secret scanning (faux secrets volontaires dans les tests, #31) — ne pas « corriger » cette exclusion. [read: from .github/workflows/release.yml, .github/secret_scanning.yml]

## Benchmark de précision PII

```bash
bun run benchmark:accuracy   # nécessite le détecteur démarré (voir build-and-env)
# filtres : --suite core|precision|eval|hard, --languages fr,en, --url <detector>, --verbose
```

- Corpus YAML en 9 langues (en, de, es, fr, it, nl, pl, pt, ro), `benchmarks/pii-accuracy/test-data/`.
- Suites `core` et `precision` sont GATING (échec = échec du run) ; `eval` et `hard` sont report-only (overridable par cas via `gate`).
- Le runner valide strictement le corpus : champ inconnu, langue/entité non supportée, ID dupliqué, texte attendu absent → échec.
- Modes de match : `exact`, `contains` (±2 caractères), `overlap` (cas volontairement lâches). Les cas encodent le comportement VOULU, pas ce que le détecteur actuel réussit.
[read: from benchmarks/pii-accuracy/README.md] [inferred: unconfirmed — non exécuté le 2026-07-07, détecteur arrêté]

⚠️ Le README du benchmark cite `http://localhost:3000/analyze` comme cible par défaut alors que le détecteur écoute sur 5002 ; vérifier la valeur réelle dans `benchmarks/pii-accuracy/run.ts` avant usage. [read: from benchmarks/pii-accuracy/README.md] [inferred: unconfirmed]

Tout changement de floor GLiNER ou de seuil DOIT être justifié par un run de benchmark avant/après, pas à l'œil (voir `domain-reference`).

## Ajouter des tests

- Tests colocalisés : `<module>.test.ts` à côté du module (31 fichiers existants comme modèles).
- Obligatoires pour : masking, forwarding, logging, config, endpoints publics (AGENTS.md, voir `change-control`).
- Piège d'isolation des mocks entre fichiers de tests de routes : voir `debugging-playbook`.
- Utilitaires partagés : `src/test-utils/detection-results.ts`.

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Re-vérifications :
- `bun test 2>&1 | tail -5` (compte de référence à re-dater si il évolue)
- `grep -n "url" benchmarks/pii-accuracy/run.ts | head -5` (lever l'incertitude sur la cible par défaut)
