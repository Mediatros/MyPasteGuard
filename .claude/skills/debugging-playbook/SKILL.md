---
name: debugging-playbook
description: Table de triage symptôme → action pour les pannes réelles de PasteGuard — erreurs Prettier parasites, 503/timeout du détecteur, 400 sur /api/mask, tests qui fuient leurs mocks, serveur qui refuse de démarrer, port occupé, 401 mystérieux avec Claude Code. À charger dès qu'un comportement inattendu, une erreur ou un échec de test apparaît, AVANT d'improviser un correctif.
---

# Playbook de débogage — PasteGuard

Réflexe : identifier le symptôme dans la table, exécuter l'expérience discriminante, seulement ensuite corriger. La plupart de ces pièges ont déjà coûté du temps (histoires complètes dans `failure-archaeology`).

## Quand NE PAS utiliser cette skill

- Le comportement est « bizarre mais voulu » (ordre secrets→PII, scans séquentiels…) → skill `architecture-contract` d'abord.
- Une entité est mal détectée mais sans erreur → skill `domain-reference`.
- Panne dans la campagne hooks (session store, hooks Claude Code) → skill `hooks-mvp-campaign`.

## Table de triage

| Symptôme | Cause probable | Expérience discriminante | Action |
|---|---|---|---|
| Erreurs Prettier/ESLint affichées après une édition | Hook de formatage GLOBAL de la machine, pas le projet | `bun run check` : s'il est vert, le projet est propre | Ignorer le bruit ; lancer `bun run format` avant de valider [read: from PROGRESS.md] |
| `503` sur `/api/mask` ou les routes provider | Détecteur down ou pas encore prêt | `docker compose ps` puis `docker compose logs detector --tail 20` | Démarrer/attendre le détecteur ; premier boot = téléchargement modèle, plusieurs minutes [read: from plans/01-environnement.md] |
| Serveur qui fait `exit 1` immédiatement au boot | Détecteur injoignable (attente `PASTEGUARD_STARTUP_TIMEOUT`, 180 s) ou config invalide (`route_local` + mode mask) | Lire le message de boot ; `curl -s localhost:5002/health` | Démarrer le détecteur ou corriger config.yaml (gardes : `config-and-flags`) |
| `400` sur `/api/mask` | `text` vide ou blanc (trimmé côté serveur) | Rejouer le curl avec un texte non vide | Gérer le cas texte vide CÔTÉ CLIENT sans appeler l'API [read: from plans/01-environnement.md] |
| Timeouts du détecteur sur gros payloads ou appels multiples | Inférence torch sérialisée (`_infer_lock`) : la concurrence s'empile | Mesurer un appel isolé vs plusieurs simultanés | Ne JAMAIS paralléliser les scans (invariant 3 d'`architecture-contract`) ; ajuster `detector_timeout` (#137) |
| Un test de route échoue selon l'ordre d'exécution des fichiers | Fuite de mock du détecteur PII entre fichiers (déjà vécu, #85) | Lancer le fichier seul : `bun test src/routes/<x>.test.ts` | Isoler le mock dans le fichier ; modèle : correctif `ed7fb19` |
| Restauration cassée en streaming (placeholder coupé, JSON invalide) | Chunk SSE coupé en pleine ligne ou en plein placeholder | Reproduire avec un test de stream-transformer découpant les chunks au milieu | Suivre les patterns de buffering des stream-transformers (#84, #112) ; ne pas supposer chunks = lignes |
| Port 3000 déjà pris | Autre instance ou autre service | `lsof -i :3000` | Changer `server.port` et reporter partout (voir plans/01, piège documenté) |
| `401 invalid x-api-key` en utilisant Claude Code à travers un proxy | Le binaire claude n'attache PAS l'OAuth hors api.anthropic.com | AUCUNE : impasse connue et définitive | STOP — ne pas déboguer. Lire `failure-archaeology` (approche 1) |

## Règle d'or locale

Un signal qui ressemble à une panne connue peut avoir une autre cause : vérifier l'expérience discriminante avant d'appliquer l'action, surtout avant tout redémarrage ou modification de config.

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Re-vérifications :
- `docker compose ps` et `curl -s localhost:5002/health` (état détecteur)
- `git log --oneline -3` (nouveaux correctifs à intégrer à la table)
