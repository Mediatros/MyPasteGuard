---
name: domain-reference
description: Sémantique de la détection PII/secrets de PasteGuard qu'un ingénieur ou un modèle non spécialiste ignore — les deux couches du détecteur (déterministe + GLiNER), floors de confiance par label, labels suppresseurs, fenêtrage des textes longs, cache, verrou d'inférence, fusion denylist/allowlist, registre des patterns secrets. À charger quand une entité est mal détectée, sur-détectée ou manquée, ou avant de régler des seuils.
---

# Référence de domaine — détection PII et secrets

## Quand NE PAS utiliser cette skill

- Pour changer un seuil dans config.yaml → skill `config-and-flags` (les clés y sont).
- Pour le flux global et les contrats d'API → skill `architecture-contract`.
- Pour mesurer la précision → benchmark décrit dans `validation-and-qa`.

## Les deux couches du détecteur (`detector/`)

1. **`deterministic.py`** : regex + checksums — emails, téléphones (lib `phonenumbers`), cartes bancaires, IBAN, IP, TVA UE (`python-stdnum`). Fiable, rapide, sans modèle.
2. **`gliner_layer.py`** : NER GLiNER multilingue (modèle `urchade/gliner_multi_pii-v1`) pour person / location / address.

Les deux sont fusionnées par `merge.py`. [read: from detector/detector/*]

## Comportements GLiNER à connaître avant de « régler » quoi que ce soit

- **Floors de confiance PAR LABEL**, calibrés contre le benchmark : person 0.95, location 0.80, address 0.80. Overridables par env (`DETECTOR_FLOOR_PERSON|LOCATION|ADDRESS`). Le `score_threshold` de la requête ne peut que RELEVER ces floors, jamais les abaisser. [read: from detector/detector/gliner_layer.py]
- **Labels suppresseurs** : `customer` et `role` sont prédits mais jamais émis. Si la lecture « rôle » est plus forte que la lecture « personne » sur le même span, l'entité est éliminée — c'est le mécanisme anti-faux-positifs (pas de denylist par langue). [read: from detector/detector/gliner_layer.py]
- **`address` est émis comme LOCATION.** [read: from detector/detector/gliner_layer.py]
- **Fenêtrage** : GLiNER tronque au-delà de ~384 word-tokens (`DETECTOR_MAX_TOKENS`). Le texte long est découpé en fenêtres chevauchantes (overlap 64), spans redécalés en offsets absolus, dédupliqués au score max. Cache LRU de 4096 fenêtres. [read: from detector/detector/gliner_layer.py]
- **`_infer_lock`** : l'inférence torch est sérialisée (non thread-safe). Capacité réelle du détecteur = UNE inférence à la fois ; c'est la raison de l'invariant « scans séquentiels » côté proxy (voir `architecture-contract`, invariant 3). [read: from detector/detector/gliner_layer.py]

## Fusion denylist / allowlist (côté proxy, `src/pii/detect.ts`)

- Matches denylist à score 1.
- Un match à L'INTÉRIEUR d'un placeholder déjà posé est ignoré (re-masquer l'intérieur corromprait le masque).
- Merge additif : un span denylist ÉTEND mais ne rétrécit jamais un span détecteur ; en cas de recouvrement, le type du détecteur gagne.
- Allowlist regex ancrée `^(?:pattern)$` sur le texte détecté. [read: from src/pii/detect.ts]

## Patterns secrets (`src/secrets/patterns/`)

Registre par familles : `api-keys.ts`, `env-vars.ts`, `private-keys.ts`, `tokens.ts` (#18). `API_KEY_SK` généralise l'ancien `API_KEY_OPENAI` (#61). Les placeholders secrets n'ont plus de préfixe `SECRET_MASKED_` (#60). Liste des 10 types actifs par défaut : voir `config-and-flags`. [read: from src/secrets/patterns/, historique git]

## Heuristiques d'investigation

| Constat | Piste |
|---|---|
| Nom propre non masqué | floor person 0.95 : score en dessous → relever via benchmark, pas au doigt mouillé |
| Titre/métier masqué comme PERSON | vérifier si le label suppresseur `role` aurait dû gagner ; cas pour le corpus benchmark |
| Entité manquée dans un texte très long | effet de fenêtre : vérifier la position vs ~384 tokens et l'overlap |
| Détection lente sur gros payloads | fenêtres nombreuses × inférence sérialisée ; voir `max_scan_chars` et `detector_timeout` dans `config-and-flags` |
| Valeur légitime toujours masquée | l'allowlist config est faite pour ça (`config-and-flags`) |

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Re-vérifications :
- `grep -n "FLOOR\|suppress\|_infer_lock\|lru" detector/detector/gliner_layer.py`
- `grep -n "score: 1\|denylist" src/pii/detect.ts`
- `ls src/secrets/patterns/` (familles de patterns)
