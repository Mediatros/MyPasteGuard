# Ce que PasteGuard ne protège pas

Ce document liste ce qui n'est PAS protégé par l'intégration Claude Code de PasteGuard. Il est à lire et à accepter AVANT de confier une vraie donnée sensible (nom réel, email réel, secret réel) à un projet placé sous cette protection.

PasteGuard masque les PII et secrets détectés avant qu'ils n'entrent dans le contexte envoyé à l'API, et les restaure localement (écran, fichiers). Ce document ne décrit pas ce qui fonctionne : il décrit les trous, connus et mesurés, de ce dispositif.

## Note de méthode : comment lire les étiquettes

Chaque affirmation ci-dessous porte une étiquette :

- **MESURÉ** : observé directement, par un test ou une inspection décrite (date et méthode indiquées). C'est un fait, pas une estimation.
- **ÉTABLI** : déduit de la lecture du code source de l'intégration ou de la documentation officielle du harnais Claude Code, non contredit par les tests disponibles, mais qui n'a pas fait l'objet d'une mesure indépendante.
- **NON VÉRIFIÉ** : jamais testé. Le comportement réel est inconnu. Ne pas le lire comme rassurant ni comme alarmant : c'est une zone d'ombre, pas un verdict.

Aucune ligne de ce document ne doit être lue comme une garantie qui n'aurait pas été prouvée.

## 1. Ce qui part en clair sur le réseau (niveau grave)

C'est la catégorie la plus importante : tout ce qui suit peut quitter la machine et atteindre `api.anthropic.com` sans passer par le masquage.

### 1.1 Le prompt tapé par l'utilisateur

**ÉTABLI.** Ce que l'utilisateur tape directement dans la fenêtre de conversation part toujours en clair. Ce n'est pas une limite du masquage : c'est une limite de l'API des hooks Claude Code. Le hook `UserPromptSubmit` peut bloquer l'envoi ou avertir, il ne peut PAS réécrire le contenu du prompt.

Un hook d'avertissement existe (`scripts/user-prompt-submit.ts`, piloté par `PASTEGUARD_PROMPT_MODE`). En mode `warn`, il signale les types de PII/secrets détectés dans le prompt et laisse partir le message quand même. En mode `off` (défaut à l'installation), il ne fait rien. Aucun mode n'empêche réellement l'envoi sans faire échouer la session à chaque faux positif (mode `block`, non retenu par défaut).

Conséquence pratique : ne jamais taper de PII ou de secret réel directement dans le prompt. Désigner les entités structurellement (« le premier client de la liste », « l'IP en tête de fichier »), jamais par leur valeur.

### 1.2 Les messages d'erreur d'outils

**MESURÉ** (POC, voir PROGRESS.md fait 5) : quand un outil échoue (fichier introuvable en Read, code de sortie non nul en Bash), le hook `PostToolUse` ne se déclenche PAS. Le message d'erreur entre dans le contexte sans être passé au masquage. Si ce message d'erreur reproduit une valeur sensible (chemin contenant un nom, extrait de commande ayant échoué avec une valeur en clair), elle part telle quelle.

### 1.3 Les ratés de détection

Le moteur de masquage repose sur un modèle statistique (GLiNER) pour les PII, complété par des règles déterministes à checksum pour certains types (IBAN, TVA, cartes). Aucun des deux n'est infaillible.

- **MESURÉ le 2026-07-20** : le score de confiance du type `PERSON` s'érode par cumul de facteurs (nombre de personnes citées dans le document, hétérogénéité des formats de fiche, présence d'autres entités), pas par un seul critère isolé. Sur un même nom : 0,997 en ligne isolée, 0,974 en format hétérogène, 0,941 dans un document réel complet (2 personnes, formats mixtes, lignes IP/TVA/IBAN). Le seuil plancher (`floor`) du type `PERSON` a été abaissé de 0,95 à 0,90 le 2026-07-20 pour rattraper ce cas de figure. Benchmark après ce changement : 0 échec de gating, rappel `PERSON` à 100 %, un nouveau faux positif observé (un intitulé de rôle en allemand détecté à tort comme un nom de personne, sans conséquence de fuite).
- Malgré ce calibrage, la détection reste un modèle statistique : elle peut manquer un nom, notamment un nom composé ou dans un format de document jamais vu au calibrage. Il n'existe aucun moyen d'obtenir une garantie de rappel à 100 % avec un détecteur statistique.
- **ÉTABLI (lecture du code, `detector/detector/deterministic.py`)** : le type `VAT_CODE` valide un checksum (clé FR + Luhn du SIREN) avant de considérer une chaîne comme un numéro de TVA. Un numéro de TVA fabriqué au checksum invalide (par exemple une fixture de démonstration inventée séquentiellement) N'EST PAS détecté et part en clair. C'est un choix intentionnel pour limiter les faux positifs sur des références commerciales ressemblant à un numéro de TVA. Un vrai numéro de TVA, valide par construction, est détecté normalement.
- Le grep de contrôle après session (section 6 ci-dessous) est la seule mesure fiable de ce qui a effectivement échappé à la détection sur un document réel donné. Aucune promesse de détection exhaustive n'est faite ici.

### 1.4 Le contournement par encodage

**MESURÉ** (incident observé en POC, voir PROGRESS.md fait 13) : face à un échec d'Edit, un modèle (Claude Haiku, dans ce test) a spontanément relu un fichier via `od -c`. La sortie, formatée caractère par caractère avec des espaces, a échappé à la détection : un email est passé en clair dans le contexte.

Une consigne d'interdiction (`od`, `xxd`, `hexdump`, `base64` et tout autre encodage de contournement) a été ajoutée au `CLAUDE.md` du projet protégé. **Ce n'est pas une garantie technique**, c'est une instruction textuelle adressée au modèle : rien n'empêche mécaniquement un modèle d'improviser un autre encodage échappant au détecteur (une boucle caractère par caractère, une rotation de chaîne, une commande inhabituelle). L'ampleur réelle de ce risque au-delà du cas observé n'est pas mesurée.

### 1.5 Le contexte de démarrage envoyé par le harnais Claude Code

**MESURÉ le 2026-07-20**, méthode : interception passive mitmproxy du trafic vers `api.anthropic.com`, sur 4 scénarios (lecture de fichier PII, lecture de secrets via Bash, modification par Edit, recherche par grep Bash), session **headless** (`claude -p`) dans le projet de test `pasteguard-test/`. 119 requêtes capturées, 4 297 399 octets de corps sortants au total.

Partent en clair, quoi qu'il arrive, indépendamment du masquage PasteGuard :

- les chemins absolus du système de fichiers (`/Users/jb/...`) ;
- le contenu complet du `CLAUDE.md` du projet ;
- la liste des skills disponibles ;
- le nom du modèle utilisé ;
- le chemin du projet.

Ne partent PAS en clair (contrairement à ce qui était anticipé avant mesure) :

- l'adresse email du compte Anthropic ;
- le nom d'utilisateur git.

**NON VÉRIFIÉ** : le comportement en session **interactive**, dans un vrai projet. La mesure ci-dessus porte uniquement sur une session headless. En session interactive, le harnais est connu pour envoyer davantage de contexte de démarrage (statut git, contenu d'`AGENTS.md`, historique de conversation, etc. selon la documentation Claude Code) : rien ne garantit que cet inventaire soit complet pour ce mode d'usage, qui est le mode d'usage réel visé par ce projet. Cet inventaire devra être refait en session interactive avant tout usage sur données réelles.

Conséquence pratique immédiate : **ne jamais mettre de PII ou de secret réel dans le `CLAUDE.md` ou l'`AGENTS.md` d'un projet protégé.** Ces fichiers partent en clair, systématiquement.

### 1.6 Risque non mesuré : mort silencieuse des hooks (bug upstream #16047)

**NON VÉRIFIÉ.** Une issue ouverte sur le dépôt `anthropics/claude-code` (#16047) signale que les hooks peuvent cesser de se déclencher après environ 2 h 30 de session continue. Si ce bug se produit, `PostToolUse` ne masque plus rien : les sorties d'outils entrent en clair dans le contexte, SANS erreur visible, SANS message d'avertissement. C'est une violation silencieuse du principe fail-closed, causée par le harnais lui-même et hors de portée de PasteGuard.

Ce comportement n'a pas été re-testé sur la version actuelle du binaire `claude` (2.1.215) au moment de la rédaction de ce document. Aucun marqueur d'intégrité (un signe systématique dans les sorties masquées, dont l'absence alerterait l'utilisateur) n'est implémenté à ce jour.

Consigne conservatoire, en l'absence de vérification : **redémarrer la session régulièrement (toutes les 2 heures environ) sur un projet contenant des données sensibles.**

## 2. Ce qui reste en clair sur le disque local (exposition locale uniquement)

Cette catégorie regroupe ce qui n'est PAS envoyé sur le réseau, mais qui existe en clair sur le disque de la machine. Le domaine de confiance est celui de la machine elle-même : si la machine est compromise, ces éléments sont lisibles.

### 2.1 Le magasin de session (`~/.pasteguard/claude-sessions/`)

Ce répertoire contient les **vraies valeurs** en clair, dans le mapping placeholder → valeur de chaque session. Il est nécessaire au fonctionnement même du dispositif (c'est lui qui permet de restaurer l'écran et les fichiers).

Protection : permissions Unix uniquement (répertoire 700, fichiers 600). Aucun chiffrement au repos.

**MESURÉ le 2026-07-20** : ce répertoire n'est repris par aucune sauvegarde cloud identifiée sur cette machine. Vérifié : Syncthing ne synchronise aucun autre répertoire que celui explicitement configuré (`~/.pasteguard/` n'y figure pas), aucune destination Time Machine n'est configurée sur cette machine, le répertoire n'est ni dans iCloud Drive ni dans Dropbox. Ce constat est valable sur cette machine à cette date ; il n'est pas garanti sur une autre machine ni après un changement de configuration de sauvegarde.

### 2.2 Le transcript local de session (`~/.claude/projects/.../<session_id>.jsonl`)

**MESURÉ le 2026-07-20**, même capture mitmproxy que la section 1.5 : les sorties de hooks (`PreToolUse` notamment) sont journalisées EN CLAIR par Claude Code dans le transcript local, sous forme d'entrées `attachment` de type `hook_success`, y compris quand le stdout du hook contient une valeur réelle restaurée (par exemple une commande `sed` restaurée avec la vraie valeur pour contourner l'échec d'Edit décrit en 3.2).

Ce fait était identifié avant mesure comme un risque potentiel de fuite réseau (le contenu du transcript pourrait en théorie être réinjecté au tour suivant). La mesure du 2026-07-20 confirme que ce risque ne s'est PAS matérialisé sur les 119 requêtes observées : aucune chaîne `hook_success` ni `updatedInput` n'apparaît dans un corps de requête sortant. **L'exposition du fait « transcript en clair » est donc strictement locale (disque), confirmée par la mesure réseau, pas seulement supposée.**

Cela reste une exposition disque réelle : quiconque a accès en lecture au dossier `~/.claude/projects/` (même utilisateur, autre processus, sauvegarde non exclue) peut lire les vraies valeurs restaurées dans ces entrées `attachment`.

### 2.3 L'écran

L'affichage démasqué (lot 5, `MessageDisplay`) montre les vraies valeurs à l'écran, par construction, c'est le but recherché. Ceci n'est pas une fuite mais un rappel : toute personne regardant l'écran pendant une session voit les vraies valeurs, pas les placeholders.

## 3. Ce qui est dégradé fonctionnellement (non fuité, mais cassé)

Cette catégorie ne fuite rien. Elle décrit ce que le modèle ne peut plus faire correctement parce qu'il raisonne sur des placeholders (`[[TYPE_n]]`) plutôt que sur les vraies valeurs.

### 3.1 Corrélation avec le prompt

**MESURÉ** (PROGRESS.md fait 17) : si l'utilisateur nomme une entité en clair dans son prompt (« l'email de Jean Dupont »), mais que Claude ne voit dans les fichiers que `[[PERSON_1]]`, il ne peut PAS faire le lien. Comportement observé : Claude demande une précision plutôt que de deviner, ce qui est un comportement sûr mais qui interrompt le flux de travail. Il faut désigner les entités **structurellement** (« la première personne listée », « le contact en tête de fichier »), jamais par leur nom.

Tout raisonnement qui exige la vraie valeur est dégradé de la même façon : tri alphabétique sur des noms masqués, validation de format (un placeholder ne « ressemble » pas à un email), rapprochement entre deux documents qui utiliseraient des libellés différents pour la même entité.

### 3.2 Edit dont `old_string` contient un placeholder

**MESURÉ** (PROGRESS.md fait 12) : la validation du `old_string` d'un Edit se fait contre le contenu réel du fichier sur disque, AVANT que le hook `PreToolUse` ne soit appelé. Un Edit dont `old_string` contient un placeholder échoue donc TOUJOURS (« String to replace not found »), le hook n'étant jamais sollicité. C'est structurellement impossible à corriger côté hook.

Parade en place : une consigne dans le `CLAUDE.md` du projet protégé demande au modèle de retomber sur une commande `sed` (dont l'entrée Bash sera, elle, correctement restaurée par le hook `PreToolUse`) en cas d'échec d'Edit pour cette raison. Prouvé fonctionnel en bout en bout, mais c'est un contournement, pas une solution native.

### 3.3 Rejet des valeurs non compatibles avec un shell (Bash)

Le démasquage des entrées Bash refuse de substituer une valeur si elle n'est pas composée de caractères considérés sûrs en ligne de commande (alphanumériques et `@.-_+:/`). C'est une garde de sécurité volontaire (éviter qu'une valeur contenant `;`, des guillemets ou un caractère d'injection ne casse ou ne détourne la commande). Conséquence : une commande légitime portant sur une valeur « à risque » (un secret contenant des espaces ou des caractères spéciaux, par exemple) est refusée plutôt qu'exécutée. Frein pratique dont l'ampleur en usage réel n'est pas encore mesurée.

### 3.4 Latence ajoutée

**MESURÉ** : chaque appel au moteur de masquage ajoute environ 0,6 seconde par kilo-octet de texte scanné, à froid (cache vide). Un fichier de 10 Ko ajoute environ 6 secondes, 30 Ko environ 18 secondes ; au-delà de 100 Ko, le détecteur dépasse son délai (30 s) et renvoie une erreur. Les scans répétés d'un même contenu sont mis en cache et redeviennent quasi instantanés.

## 4. Preuve mesurée le 2026-07-20 : méthode et résultats

Cette section détaille la mesure citée en section 1.5 et 2.2, pour que la méthode soit vérifiable.

**Méthode** : interception passive (aucune modification de contenu) du trafic HTTPS sortant vers `api.anthropic.com`, via un proxy mitmproxy local, avec le certificat racine mitmproxy installé comme autorité de confiance additionnelle pour la session `claude`. Quatre scénarios rejoués dans le projet de test `pasteguard-test/` :

1. lecture d'un fichier contenant des PII (Read) ;
2. lecture de secrets via Bash (`cat`) ;
3. modification d'un fichier par Edit ;
4. recherche d'une valeur par `grep` via Bash.

**Résultats** :

- 119 requêtes capturées, 4 297 399 octets de corps sortants cumulés.
- Zéro occurrence, dans l'ensemble de ces corps, des 21 valeurs sensibles de test (noms, emails, téléphones, IBAN, adresse IP, numéro de TVA valide, clé `sk-ant`, token `ghp_`, JWT, chaîne de connexion, mots de passe).
- Les placeholders `[[TYPE_n]]` correspondants sont bien présents à la place des valeurs réelles.
- Aucune des chaînes `hook_success` ou `updatedInput` (qui portent les vraies valeurs restaurées localement, voir section 2.2) n'apparaît dans les 119 requêtes.

**Limite explicite de cette mesure** : elle a été réalisée en session **headless**, dans un projet de test à fixtures synthétiques, sur 4 scénarios seulement (parmi les 16 scénarios prévus par le plan de validation). Elle ne couvre ni la session interactive, ni une session de plus de 2 h 30 (section 1.6), ni les tentatives de contournement par encodage au-delà du cas déjà observé (section 1.4), ni les outils MCP. Une mesure verte sur 4 scénarios headless est une condition nécessaire, pas suffisante, pour conclure à l'absence de fuite réseau sur un usage réel complet.

## 5. Procédure d'incident

| Incident | Détection | Action immédiate |
|---|---|---|
| Moteur PasteGuard arrêté en cours de session | Le message `[PasteGuard indisponible : la sortie de l'outil a été retenue par sécurité...]` s'affiche à la place du résultat de l'outil. | Redémarrer le service (`bun run start`), reprendre la session : le mapping de session survit à l'arrêt. |
| Détecteur PII arrêté | `curl localhost:3333/health` renvoie `detector: down` ; `/api/mask` renvoie une erreur 503. | `docker compose --profile dev up detector -d`, attendre l'état healthy (jusqu'à 1 minute si le modèle est en cache). |
| Hooks morts (bug upstream #16047, section 1.6) | **NON VÉRIFIÉ à ce jour** : aucun marqueur d'intégrité n'est implémenté pour signaler ce cas. La seule détection possible aujourd'hui est un grep de contrôle après coup (section 6). | Si un signe fait suspecter une absence de masquage (sorties visiblement non transformées) : arrêter la session immédiatement, redémarrer une nouvelle session, considérer les derniers tours comme non protégés et traiter les valeurs qu'ils contenaient comme potentiellement exposées. |
| Fuite constatée après coup (au grep de contrôle) | Occurrence d'une valeur sensible connue dans un transcript JSONL. | Consigner l'incident (quoi, quand, quel scénario) ; si la valeur est un secret actif (clé API, mot de passe), le révoquer immédiatement, indépendamment de toute analyse de cause. |
| Magasin de session corrompu | Erreur de restauration, ou placeholders qui ne se résolvent plus alors qu'ils étaient résolus avant. | **MESURÉ (lecture du code, `lib/store.ts`)** : le comportement actuel, en cas de fichier de session illisible, est de le renommer (`<fichier>.corrupt-<horodatage>`) et de repartir sur un état vierge. **Aucune sauvegarde automatique (`.bak`) n'est implémentée à ce jour** : le mapping en cours est perdu, pas restauré. Un placeholder devenu non résolu reste affiché tel quel (pas de fuite, mais plus de démasquage possible pour les valeurs déjà masquées dans cette session). Recommandation : terminer la session et en ouvrir une nouvelle plutôt que de continuer sur un état renuméroté. |

## 6. Comment vérifier soi-même

Ne pas se fier à ce document seul. Après chaque session sur un projet protégé, vérifier par un grep de contrôle.

**Où se trouvent les transcripts** : Claude Code écrit un fichier JSONL par session dans `~/.claude/projects/<slug-du-chemin-projet>/<session_id>.jsonl`, où `<slug-du-chemin-projet>` est le chemin absolu du projet avec chaque `/` remplacé par `-`. Exemple pour un projet situé à `/Users/jb/Documents/MonProjet` : `~/.claude/projects/-Users-jb-Documents-MonProjet/`.

**Commande de grep de contrôle** : constituer d'abord une liste de valeurs sensibles connues du projet (une valeur par ligne, dans un fichier non versionné), puis :

```bash
grep -F -f valeurs-sensibles.txt ~/.claude/projects/<slug-du-projet>/<session_id>.jsonl
```

`-F` recherche des chaînes littérales (pas des regex), ce qui évite les faux négatifs dus à des caractères spéciaux dans les valeurs (email, IBAN, etc.). **Aucune occurrence ne doit être trouvée.**

Si une occurrence apparaît, examiner le contexte immédiat de la ligne concernée avant de conclure à une fuite réseau : une entrée de type `user` correspondant au prompt tapé (section 1.1) ou une entrée `attachment` de type `hook_success` (section 2.2) sont des expositions déjà connues et documentées, locales, pas des fuites réseau nouvelles. Une occurrence dans une entrée `assistant` autre que la citation d'un placeholder, en revanche, mérite une investigation immédiate.

Ce grep sur le transcript local ne prouve PAS l'absence de fuite réseau à lui seul : seule une capture de trafic (comme celle décrite en section 4) le prouve. C'est néanmoins la vérification accessible à tout utilisateur, à faire systématiquement.

## 7. Avant de confier un projet à PasteGuard : checklist

1. **Relire le `CLAUDE.md` et l'`AGENTS.md` du projet.** Ils partent en clair vers l'API (section 1.5). Aucune PII, aucun secret ne doit y figurer.
2. **Écrire la liste des valeurs sensibles connues du projet** dans un fichier non versionné (exclu du dépôt git), pour pouvoir exécuter le grep de contrôle de la section 6 après chaque session.
3. **Vérifier que le moteur PasteGuard et le détecteur PII tournent** avant de commencer (`curl localhost:3333/health` doit répondre `detector: up`).
4. **Faire une première session de contrôle** : demander un Read d'un fichier contenant une donnée sensible connue, puis exécuter le grep de contrôle sur le transcript produit. Ne commencer un usage réel qu'une fois cette session verte.
5. **Désigner les entités structurellement dans les prompts**, jamais par leur nom ou leur valeur réelle (section 3.1), pour éviter à la fois une fuite dans le prompt et une confusion du modèle.

## 8. Accusé de lecture

Ce document a été lu et son contenu compris avant toute utilisation de PasteGuard sur des données sensibles réelles, en particulier les limitations des sections 1 (fuites réseau), 2 (exposition disque locale) et 3 (dégradation fonctionnelle), et les points explicitement marqués NON VÉRIFIÉ.

À dater et contresigner dans `PROGRESS.md` (section « Décisions actées ») avant la première session sur un projet contenant de vraies données sensibles :

`Lu et accepté le [date], par [nom].`
