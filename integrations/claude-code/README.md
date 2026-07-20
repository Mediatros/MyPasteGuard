# Intégration Claude Code (hooks de masquage PII/secrets)

Protection de Claude Code en usage abonnement : des hooks masquent les PII/secrets avant leur
entrée dans le contexte (donc avant tout départ vers l'API) et les restaurent localement
(fichiers écrits, affichage). Claude Code garde son authentification OAuth native ; le moteur
PasteGuard tourne en local et n'est joint qu'en HTTP sur localhost.

Les décisions d'architecture (D1-D11) et l'avancement par lots sont décrits dans les skills du
dépôt (`.claude/skills/hooks-mvp-campaign`, `architecture-contract`) ; les plans détaillés et
l'état de campagne sont des documents de travail internes, non committés.

## Prérequis

- Détecteur PII : `docker compose --profile dev up detector -d` (port 5002).
- Moteur : `bun run start`. Les hooks joignent le moteur via l'env `PASTEGUARD_URL`
  (défaut `http://localhost:3333`) : l'aligner sur le `port` de votre `config.yaml`.

## Contrat `/api/mask` (prouvé au lot 1, 2026-07-19)

- Requête : `{ text, startFrom?, detect? }` — `text` non vide (400 sinon), `startFrom` reprend
  les counters de session.
- Réponse : `{ masked, context, counters, entities }`.
- Le moteur NE déduplique PAS entre les appels (une même valeur reçoit un nouveau placeholder
  à chaque appel) : la dédup est faite ici, côté client (`mask-client.ts`, deux passes).
- Latences mesurées à cache froid (détecteur Docker CPU) : ~0,6 s/Ko ; 100 Ko dépasse le
  `detector_timeout` de 30 s → 503.

## Format des placeholders

`[[TYPE_n]]`, regex de restauration : `\[\[[A-Z][A-Z0-9_]*_\d+\]\]`.

Types PII : `PERSON`, `LOCATION`, `EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`, `IBAN_CODE`,
`IP_ADDRESS`, `VAT_CODE`.

Types secrets : `OPENSSH_PRIVATE_KEY`, `PEM_PRIVATE_KEY`, `API_KEY_SK`, `API_KEY_AWS`,
`API_KEY_GITHUB`, `JWT_TOKEN`, `BEARER_TOKEN`, `ENV_PASSWORD`, `ENV_SECRET`,
`CONNECTION_STRING`.

Attention : c'est `EMAIL_ADDRESS` (pas `EMAIL`) ; les clés de `startFrom` doivent utiliser ces
types exacts.

## Bibliothèque partagée (`lib/`)

- `types.ts` : `SessionState` (`version`, `counters`, `mapping`).
- `lock.ts` : verrou par `mkdir` atomique (pas de `flock(1)` sur macOS), `owner.json`
  (pid + timestamp), cassage des verrous périmés (> 30 s), `LockTimeoutError`.
- `store.ts` : état de session dans `~/.pasteguard/claude-sessions/<session_id>.json`
  (dossier 700, fichier 600, écriture atomique tmp+rename), `withSessionLock` (relit toujours
  l'état frais sous verrou), `linkSession` (chaînage resume/compact, préparation V7),
  env `PASTEGUARD_SESSION_DIR` pour surcharger l'emplacement.
- `mask-client.ts` : `maskText` — pré-remplacement des valeurs connues (passe a, valeurs
  longues d'abord), appel `/api/mask` avec `startFrom`, fusion et dédup des variantes
  (passe b). Toute la section critique sous verrou (D4/D5). Erreurs → `MaskUnavailableError`
  (politique d'échec décidée par chaque hook, D6).
- `restore.ts` : restauration locale sans réseau (D3), placeholder inconnu laissé intact.
- `tool-output.ts` : transformation des `tool_response` en préservant leur forme exacte
  (contrainte `updatedToolOutput`, prouvée au lot 3).
- `tool-input.ts` : restauration des entrées d'outils LOCAUX (lot 4) — table champs/outil,
  variante échappée `\[\[X_n\]\]` pour les regex shell, garde shell-safe (R7) sur Bash.

## Hooks (`scripts/`)

- `post-tool-use.ts` (PostToolUse, matcher `*`) : masque les sorties d'outils via `/api/mask`.
  Fail-closed D6 : moteur indisponible → sortie retenue. Plafond PII 30 000 chars.
- `pre-tool-use.ts` (PreToolUse, matcher `Write|Edit|MultiEdit|NotebookEdit|Bash`) : restaure
  les placeholders dans les entrées des outils locaux via `updatedInput` SANS
  `permissionDecision` (mode validé en V2 sur claude 2.1.215 : honoré, flux de permission
  préservé). Placeholder non résolu ou valeur non shell-safe pour Bash → deny.
- `user-prompt-submit.ts` (UserPromptSubmit, sans matcher) : détecte les PII/secrets tapés
  directement dans le prompt et avertit ou bloque avant l'envoi. Piloté par `PASTEGUARD_PROMPT_MODE`
  (défaut `off`, non câblé) : `off` ne fait rien (aucun appel réseau) ; `warn` avertit via
  `systemMessage` (types + nombre, jamais les valeurs) et laisse le prompt partir EN CLAIR quand
  même (`UserPromptSubmit` ne permet pas de réécrire le prompt) ; `block` renvoie
  `{"decision":"block","reason":"..."}` listant les types détectés. Renversement de D6 :
  ce hook n'est PAS fail-closed, toute panne du moteur ou timeout (2 s réseau) → exit 0 sans
  blocage ni avertissement, pour ne jamais rendre la session inutilisable. Échappatoire :
  préfixer le prompt de `!pg-off` pour forcer l'envoi sans détection. N'écrit jamais dans le
  session store (détection pure via `/api/mask` sans `startFrom`, sans passer par `maskText`).
- `spy.ts` / `spy-suffix.ts` / `pre-poc.ts` : instrumentation de POC, jamais hors projet de test.

### Branchement dans un projet (test uniquement à ce stade, décision D9)

Dans le `.claude/settings.json` du projet à protéger (jamais dans `~/.claude/settings.json`) :

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "timeout": 60,
            "command": "bun run /chemin/vers/pasteguard/integrations/claude-code/scripts/post-tool-use.ts"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "timeout": 30,
            "command": "bun run /chemin/vers/pasteguard/integrations/claude-code/scripts/pre-tool-use.ts"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "timeout": 10,
            "command": "PASTEGUARD_PROMPT_MODE=warn bun run /chemin/vers/pasteguard/integrations/claude-code/scripts/user-prompt-submit.ts"
          }
        ]
      }
    ]
  }
}
```

`PASTEGUARD_PROMPT_MODE` vaut `off` par défaut (hook inactif) si la variable n'est pas définie ;
la fixer à `warn` ou `block` selon la posture voulue.

Ajouter aussi au `CLAUDE.md` du projet protégé la consigne modèle : placeholders opaques à
recopier tels quels ; si un Edit échoue sur un `old_string` contenant `[[...]]`, utiliser
`sed` avec le placeholder (restauré à l'exécution) ; interdiction de relire un fichier via
`od`, `xxd`, `hexdump`, `base64` ou tout autre encodage.

### Limites prouvées (claude 2.1.215)

- La validation d'`old_string` d'un Edit se fait contre le DISQUE, AVANT PreToolUse : un Edit
  dont `old_string` contient un placeholder échoue sans que le hook soit appelé. Parade :
  consigne dans le `CLAUDE.md` du projet protégé (utiliser `sed` avec le placeholder, qui est
  restauré à l'exécution ; interdire les relectures par `od`/`xxd`/`base64` qui contournent le
  masquage).
- Les sorties de hooks sont journalisées en clair dans le transcript local
  (`attachment` de type `hook_success`, champ `content` vide donc rien d'injecté au contexte) :
  exposition disque local uniquement, à confirmer côté réseau au lot 7 (mitmproxy).
- Un modèle confronté à un Edit qui échoue peut tenter de relire le fichier sous une forme que
  le détecteur ne reconnaît pas (`od -c` observé en réel : sortie espacée caractère par
  caractère, donc fuite en clair). La consigne `CLAUDE.md` l'interdit ; risque résiduel
  documenté, un modèle peut improviser d'autres encodages.

## Validation

```bash
bun test integrations/
bunx tsc --noEmit --project tsconfig.integrations.json
bunx biome check integrations
```
