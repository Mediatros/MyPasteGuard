#!/usr/bin/env bun
/**
 * Harnais E2E lot 7 (plans/07-e2e.md, plans/11-deploiement.md §7) : lance des
 * scénarios `claude -p` headless dans `pasteguard-test/`, puis vérifie qu'AUCUNE
 * valeur des fixtures n'apparaît, littéralement, dans le transcript JSONL complet
 * de la session. Critère binaire par valeur : zéro occurrence.
 *
 * Ne remplace PAS le protocole mitmproxy (S11/S12, manuel, voir README.md) : ce
 * harnais observe le transcript LOCAL, pas le fil réseau réel.
 *
 * Usage :
 *   bun run integrations/claude-code/e2e/run.ts [--only S1,S3] [--dry-run]
 *
 * Sortie : tableau scénario / VERT-ROUGE / preuve sur stdout, rapport JSON dans
 * e2e/resultats/<horodatage>.json. Code de sortie non nul si un scénario est ROUGE
 * (ou si le harnais lui-même échoue à conclure sur un scénario).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionsDir } from "../lib/store";
import type { SessionState } from "../lib/types";

const TEST_PROJECT_DIR =
  process.env.PASTEGUARD_E2E_PROJECT_DIR ?? "/Users/jb/Documents/MyProjects/LOCAL/pasteguard-test";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const DEFAULT_MODEL = "haiku";
const DEFAULT_TIMEOUT_MS = 120_000;
const E2E_DIR = import.meta.dir;
const VALUES_FILE = join(E2E_DIR, "valeurs-sensibles.txt");
const RESULTS_DIR = join(E2E_DIR, "resultats");

/**
 * Purge d'environnement EXACTE (PROGRESS.md, recette de test headless) : sans
 * elle, la clé API d'une éventuelle session parente écrase l'OAuth abonnement
 * et l'appel échoue en 401.
 */
const ENV_TO_UNSET = [
  "ANTHROPIC_API_KEY",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID",
];

function projectSlug(absPath: string): string {
  return `-${absPath.split("/").filter(Boolean).join("-")}`;
}

const TRANSCRIPTS_DIR = join(homedir(), ".claude", "projects", projectSlug(TEST_PROJECT_DIR));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  ok: boolean;
  label: string;
  detail: string;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  sessionIdFromJson: string | null;
}

interface FileSnapshot {
  existed: boolean;
  content?: string;
}

interface ScenarioContext {
  cli: CliResult;
  transcriptPath: string | null;
  transcriptRaw: string | null;
  sessionId: string | null;
}

interface Scenario {
  id: string;
  description: string;
  prompt: string;
  allowedTools: string;
  maxTurns: number;
  model?: string;
  timeoutMs?: number;
  /** Chemins relatifs à pasteguard-test/ que le scénario peut créer/modifier : sauvegardés puis restaurés. */
  filesToRestore?: string[];
  /** Vérifications spécifiques en plus du grep générique zéro-fuite (plans/07, plans/11 §7.2). */
  extraChecks?: (ctx: ScenarioContext) => Promise<CheckResult[]>;
}

interface ScenarioReport {
  id: string;
  description: string;
  status: "VERT" | "ROUGE";
  durationMs: number;
  sessionId: string | null;
  transcriptPath: string | null;
  checks: CheckResult[];
  cliExitCode: number | null;
  cliTimedOut: boolean;
  stderrExcerpt: string;
}

// ---------------------------------------------------------------------------
// Utilitaires génériques
// ---------------------------------------------------------------------------

async function loadSensitiveValues(): Promise<string[]> {
  if (!existsSync(VALUES_FILE)) {
    throw new Error(
      `Fichier de valeurs sensibles manquant : ${VALUES_FILE}. ` +
        "Lancer d'abord `bun run integrations/claude-code/e2e/build-valeurs-sensibles.ts`.",
    );
  }
  const raw = await readFile(VALUES_FILE, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 6 && !line.startsWith("#"));
}

interface PromptGuardViolation {
  scenarioId: string;
  value: string;
}

/**
 * Garde structurelle (pas cosmétique) : un prompt de scénario ne doit JAMAIS
 * nommer littéralement une valeur sensible des fixtures. Sinon le modèle voit
 * la valeur en clair dans son propre prompt (elle part donc, de toute façon,
 * dès le premier tour) ET ne peut pas la corréler avec le placeholder qu'il
 * voit dans les fichiers masqués (limite UX structurelle, fait 17 de
 * PROGRESS.md) : le scénario échoue fonctionnellement (l'outil visé n'est
 * jamais appelé) en plus de fausser le check zéro-fuite. Désigner l'entité
 * STRUCTURELLEMENT (« le premier client », « la deuxième adresse email »...).
 */
function checkPromptsAgainstSensitiveValues(
  scenarios: Scenario[],
  values: string[],
): PromptGuardViolation[] {
  const violations: PromptGuardViolation[] = [];
  for (const scenario of scenarios) {
    for (const value of values) {
      if (scenario.prompt.includes(value)) violations.push({ scenarioId: scenario.id, value });
    }
  }
  return violations;
}

function wasToolUsed(transcriptRaw: string | null, toolName: string): boolean {
  if (!transcriptRaw) return false;
  for (const line of transcriptRaw.split("\n")) {
    if (line.length === 0 || !line.includes(`"name":"${toolName}"`)) continue;
    try {
      const obj = JSON.parse(line) as { message?: { content?: unknown } };
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "tool_use" &&
          (block as Record<string, unknown>).name === toolName
        ) {
          return true;
        }
      }
    } catch {
      // Ligne JSONL non parseable isolément : ignorer, ce n'est pas le check qui échoue pour ça.
    }
  }
  return false;
}

async function snapshotFile(relPath: string): Promise<FileSnapshot> {
  const abs = join(TEST_PROJECT_DIR, relPath);
  try {
    const content = await readFile(abs, "utf8");
    return { existed: true, content };
  } catch {
    return { existed: false };
  }
}

async function restoreFile(relPath: string, snapshot: FileSnapshot): Promise<void> {
  const abs = join(TEST_PROJECT_DIR, relPath);
  if (snapshot.existed && snapshot.content !== undefined) {
    await writeFile(abs, snapshot.content, "utf8");
  } else {
    await rm(abs, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Exécution CLI et repérage du transcript
// ---------------------------------------------------------------------------

function buildArgs(scenario: Scenario): string[] {
  return [
    "-p",
    scenario.prompt,
    "--output-format",
    "json",
    "--allowedTools",
    scenario.allowedTools,
    "--max-turns",
    String(scenario.maxTurns),
    "--model",
    scenario.model ?? DEFAULT_MODEL,
  ];
}

/** Reproduit la commande `env -u X -u Y ... claude ...` pour affichage (--dry-run) et logs. */
function formatCommandForDisplay(scenario: Scenario): string {
  const unsets = ENV_TO_UNSET.map((k) => `-u ${k}`).join(" ");
  const args = buildArgs(scenario)
    .map((a) => (a.includes(" ") || a.includes('"') ? JSON.stringify(a) : a))
    .join(" ");
  return `(cd ${TEST_PROJECT_DIR} && env ${unsets} ${CLAUDE_BIN} ${args})`;
}

async function runClaude(scenario: Scenario): Promise<CliResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of ENV_TO_UNSET) delete env[key];

  const proc = Bun.spawn({
    cmd: [CLAUDE_BIN, ...buildArgs(scenario)],
    cwd: TEST_PROJECT_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const started = Date.now();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const durationMs = Date.now() - started;

  let sessionIdFromJson: string | null = null;
  try {
    const parsed = JSON.parse(stdout) as { session_id?: unknown };
    if (typeof parsed.session_id === "string") sessionIdFromJson = parsed.session_id;
  } catch {
    // --output-format json peut échouer à produire du JSON pur (erreur avant sortie propre,
    // timeout tué en plein flux...) : repli sur le fichier .jsonl le plus récent ci-dessous.
  }

  return { exitCode, stdout, stderr, durationMs, timedOut, sessionIdFromJson };
}

/**
 * Identifie le transcript de la session : priorité au `session_id` renvoyé par
 * `--output-format json` (fiable), repli sur le fichier `.jsonl` le plus
 * récemment modifié dans le répertoire de projet, créé après le lancement.
 */
async function resolveTranscriptPath(cli: CliResult, launchedAt: number): Promise<string | null> {
  if (cli.sessionIdFromJson) {
    const p = join(TRANSCRIPTS_DIR, `${cli.sessionIdFromJson}.jsonl`);
    if (existsSync(p)) return p;
  }
  try {
    const entries = await readdir(TRANSCRIPTS_DIR, { withFileTypes: true });
    let best: { path: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const p = join(TRANSCRIPTS_DIR, entry.name);
      const s = await stat(p);
      // Marge de 2s : horloge du process vs mtime du fichier.
      if (s.mtimeMs >= launchedAt - 2000 && (!best || s.mtimeMs > best.mtimeMs)) {
        best = { path: p, mtimeMs: s.mtimeMs };
      }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Check générique : zéro-fuite dans le transcript JSONL complet
// ---------------------------------------------------------------------------

interface LeakOccurrence {
  value: string;
  count: number;
  promptHits: number;
  contentHits: number;
  attachmentHits: number;
  otherHits: number;
}

function truncateValue(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/**
 * Grep littéral (pas regex) de chaque valeur sensible dans CHAQUE ligne du
 * transcript. Classification par occurrence, PRIORITÉ à la catégorie prompt :
 *
 * - « prompt utilisateur » : la valeur apparaît dans le prompt même du
 *   scénario (`scenario.prompt`). Couvre à la fois les entrées qui portent le
 *   prompt tel quel (`user`, `queue-operation`, `last-prompt` observées en
 *   réel) et toute citation littérale de cette valeur par l'assistant : si la
 *   valeur était déjà en clair dès le tour 0 (le prompt tapé), CE N'EST PAS
 *   une nouvelle fuite de masquage — c'est la limitation structurelle n°1 du
 *   projet (fait 17, PROGRESS.md : le prompt tapé part toujours en clair).
 *   Ne fait PAS échouer le scénario ; compté et rapporté à part. La garde
 *   `checkPromptsAgainstSensitiveValues` empêche déjà qu'un scénario de ce
 *   harnais tombe dans ce cas — cette catégorie protège contre un prompt
 *   futur qui nommerait une entité par erreur.
 * - « attachment » (fait 16) : stdout de hook consigné en clair localement,
 *   pas un envoi réseau.
 * - « CONTENU message » (`user`/`assistant`, hors prompt) : potentiellement
 *   parti vers l'API — fait échouer le scénario.
 * - « ailleurs » : à examiner au cas par cas — fait échouer le scénario.
 */
function checkZeroLeak(transcriptRaw: string, values: string[], prompt: string): CheckResult {
  const lines = transcriptRaw.split("\n").filter((l) => l.length > 0);
  const occurrences: LeakOccurrence[] = [];

  for (const value of values) {
    const fromPrompt = prompt.includes(value);
    let count = 0;
    let promptHits = 0;
    let contentHits = 0;
    let attachmentHits = 0;
    let otherHits = 0;
    for (const line of lines) {
      if (!line.includes(value)) continue;
      const n = line.split(value).length - 1;
      count += n;
      if (fromPrompt) {
        promptHits += n;
        continue;
      }
      let type: string | undefined;
      try {
        type = (JSON.parse(line) as { type?: string }).type;
      } catch {
        type = undefined;
      }
      if (type === "attachment") attachmentHits += n;
      else if (type === "user" || type === "assistant") contentHits += n;
      else otherHits += n;
    }
    if (count > 0)
      occurrences.push({
        value,
        count,
        promptHits,
        contentHits,
        attachmentHits,
        otherHits,
      });
  }

  const failing = occurrences.filter((o) => o.contentHits + o.attachmentHits + o.otherHits > 0);
  const promptOnly = occurrences.filter(
    (o) => o.contentHits + o.attachmentHits + o.otherHits === 0 && o.promptHits > 0,
  );

  if (failing.length === 0) {
    const note =
      promptOnly.length > 0
        ? ` — limitation structurelle connue (prompt) sur ${promptOnly.length} valeur(s) : ${promptOnly
            .map((o) => `"${truncateValue(o.value)}"`)
            .join(", ")}`
        : "";
    return {
      ok: true,
      label: "zéro-fuite transcript",
      detail: `0 occurrence hors prompt sur ${values.length} valeurs testées${note}`,
    };
  }

  const detail = failing
    .map((o) => {
      const parts: string[] = [];
      if (o.contentHits > 0) parts.push(`${o.contentHits}× en CONTENU message (fuite potentielle)`);
      if (o.attachmentHits > 0)
        parts.push(`${o.attachmentHits}× en attachment hook local (fait 16, pas réseau)`);
      if (o.otherHits > 0) parts.push(`${o.otherHits}× ailleurs (à examiner)`);
      if (o.promptHits > 0) parts.push(`${o.promptHits}× dans le prompt (hors critère)`);
      return `"${truncateValue(o.value)}" ×${o.count} (${parts.join(", ")})`;
    })
    .join(" ; ");

  return { ok: false, label: "zéro-fuite transcript", detail };
}

// ---------------------------------------------------------------------------
// Checks spécifiques par scénario (session store)
// ---------------------------------------------------------------------------

async function loadSessionState(sessionId: string): Promise<SessionState | null> {
  const p = join(sessionsDir(), `${sessionId}.json`);
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

/** S6 : aucune valeur ne doit être mappée sous deux placeholders différents (dédup D5). */
async function checkMappingInjective(sessionId: string): Promise<CheckResult> {
  const state = await loadSessionState(sessionId);
  if (!state) {
    return {
      ok: false,
      label: "cohérence store (dédup)",
      detail: `store introuvable pour la session ${sessionId} (${join(sessionsDir(), `${sessionId}.json`)})`,
    };
  }
  const byValue = new Map<string, string[]>();
  for (const [placeholder, value] of Object.entries(state.mapping)) {
    const list = byValue.get(value) ?? [];
    list.push(placeholder);
    byValue.set(value, list);
  }
  const collisions = [...byValue.entries()].filter(([, placeholders]) => placeholders.length > 1);
  if (collisions.length === 0) {
    return {
      ok: true,
      label: "cohérence store (dédup)",
      detail: `${Object.keys(state.mapping).length} entrée(s) mapping, toutes injectives`,
    };
  }
  const detail = collisions
    .map(([value, placeholders]) => `"${value.slice(0, 30)}" → ${placeholders.join(", ")}`)
    .join(" ; ");
  return {
    ok: false,
    label: "cohérence store (dédup)",
    detail: `collision(s) : ${detail}`,
  };
}

/** Le store ne doit pas avoir été mis de côté comme corrompu pendant/après le scénario (S14, verrou concurrent). */
async function checkStoreNotCorrupted(sessionId: string): Promise<CheckResult> {
  const dir = sessionsDir();
  try {
    const entries = await readdir(dir);
    const corrupt = entries.filter((f) => f.startsWith(`${sessionId}.json.corrupt-`));
    if (corrupt.length === 0) {
      return {
        ok: true,
        label: "intégrité store",
        detail: "aucun fichier .corrupt-* pour cette session",
      };
    }
    return {
      ok: false,
      label: "intégrité store",
      detail: `fichier(s) corrompu(s) détecté(s) : ${corrupt.join(", ")}`,
    };
  } catch (err) {
    return {
      ok: false,
      label: "intégrité store",
      detail: `répertoire store illisible : ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Table de scénarios (S1-S6, S14 — plans/07-e2e.md, plans/11-deploiement.md §7.2)
// ---------------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  {
    id: "S1",
    description: "Read fixtures/clients.txt et résumé des clients",
    prompt:
      "Lis fixtures/clients.txt et résume qui sont les clients (uniquement leurs noms, pas d'autre détail).",
    allowedTools: "Read",
    maxTurns: 4,
    extraChecks: async (ctx) => [
      {
        ok: wasToolUsed(ctx.transcriptRaw, "Read"),
        label: "outil Read utilisé",
        detail: wasToolUsed(ctx.transcriptRaw, "Read") ? "confirmé" : "aucun tool_use Read trouvé",
      },
    ],
  },
  {
    id: "S2",
    description: "cat fixtures/env.fake via Bash (secrets)",
    prompt: 'Utilise Bash pour exécuter "cat fixtures/env.fake" et montre-moi le contenu.',
    allowedTools: "Bash",
    maxTurns: 4,
    extraChecks: async (ctx) => [
      {
        ok: wasToolUsed(ctx.transcriptRaw, "Bash"),
        label: "outil Bash utilisé",
        detail: wasToolUsed(ctx.transcriptRaw, "Bash") ? "confirmé" : "aucun tool_use Bash trouvé",
      },
    ],
  },
  {
    id: "S3",
    description: "Edit : remplacer l'email du premier client (fixtures/clients.txt)",
    prompt:
      "Dans fixtures/clients.txt, remplace uniquement l'adresse email du premier client " +
      "listé par contact@example.org, sans toucher au reste du fichier.",
    allowedTools: "Read,Edit,Bash",
    maxTurns: 6,
    filesToRestore: ["fixtures/clients.txt"],
    extraChecks: async () => {
      const p = join(TEST_PROJECT_DIR, "fixtures/clients.txt");
      let content = "";
      try {
        content = await readFile(p, "utf8");
      } catch {
        // fichier illisible : le check ci-dessous échouera avec content vide
      }
      const ok = content.includes("contact@example.org");
      return [
        {
          ok,
          label: "disque : vraie valeur écrite",
          detail: ok
            ? "fixtures/clients.txt contient bien contact@example.org"
            : "contact@example.org absent de fixtures/clients.txt après le scénario",
        },
      ];
    },
  },
  {
    id: "S4",
    description: "Write : créer note.md avec le téléphone du premier client",
    prompt:
      "Crée un fichier note.md à la racine du projet contenant uniquement le numéro de téléphone " +
      "du premier client listé dans fixtures/clients.txt, une seule ligne, rien d'autre.",
    allowedTools: "Read,Write",
    maxTurns: 5,
    filesToRestore: ["note.md"],
    extraChecks: async () => {
      const p = join(TEST_PROJECT_DIR, "note.md");
      let content = "";
      try {
        content = await readFile(p, "utf8");
      } catch {
        // fichier absent : le check ci-dessous échouera avec content vide
      }
      const ok = content.includes("06 12 34 56 78");
      return [
        {
          ok,
          label: "disque : vraie valeur écrite",
          detail: ok
            ? "note.md contient bien le vrai numéro de téléphone"
            : "le vrai numéro de téléphone est absent de note.md après le scénario",
        },
      ];
    },
  },
  {
    id: "S5",
    description:
      "Bash grep : rechercher l'email du premier contact dans fixtures/ (démasquage Bash)",
    prompt:
      "Lis fixtures/clients.txt, repère l'adresse email du premier contact listé, puis utilise " +
      "grep -F en Bash pour la rechercher littéralement dans tout le dossier fixtures/ et montre le résultat.",
    allowedTools: "Read,Bash",
    maxTurns: 6,
    extraChecks: async (ctx) => [
      {
        ok: wasToolUsed(ctx.transcriptRaw, "Read") && wasToolUsed(ctx.transcriptRaw, "Bash"),
        label: "outils Read + Bash utilisés",
        detail: `Read=${wasToolUsed(ctx.transcriptRaw, "Read")} Bash=${wasToolUsed(ctx.transcriptRaw, "Bash")}`,
      },
    ],
  },
  {
    id: "S6",
    description:
      "Cohérence inter-outils : deux lectures de clients.txt, même valeur → même placeholder",
    prompt:
      "Lis fixtures/clients.txt avec l'outil Read. Puis relis-le une seconde fois avec un NOUVEL appel " +
      "à l'outil Read (ne réutilise pas le résultat précédent, relance vraiment l'outil). Confirme juste " +
      "que les deux lectures sont identiques, sans autre commentaire.",
    allowedTools: "Read",
    maxTurns: 5,
    extraChecks: async (ctx) => {
      const toolCheck: CheckResult = {
        ok: wasToolUsed(ctx.transcriptRaw, "Read"),
        label: "outil Read utilisé",
        detail: wasToolUsed(ctx.transcriptRaw, "Read") ? "confirmé" : "aucun tool_use Read trouvé",
      };
      if (!ctx.sessionId) {
        return [
          toolCheck,
          {
            ok: false,
            label: "cohérence store (dédup)",
            detail: "session_id inconnu, check impossible",
          },
        ];
      }
      return [toolCheck, await checkMappingInjective(ctx.sessionId)];
    },
  },
  {
    id: "S14",
    description:
      "5 appels d'outils en parallèle dans le même tour (R4 : pas de collision de placeholder)",
    prompt:
      "Lance en PARALLÈLE, dans le même message (5 appels d'outils séparés, pas de tours successifs) : " +
      '(1) Read fixtures/clients.txt, (2) Bash "cat fixtures/env.fake", ' +
      '(3) Bash "cat fixtures/clients.txt", (4) Read fixtures/env.fake, ' +
      '(5) Bash "wc -l fixtures/clients.txt fixtures/env.fake". ' +
      "Résume ensuite en une phrase que les 5 résultats sont arrivés.",
    allowedTools: "Read,Bash",
    maxTurns: 4,
    timeoutMs: 150_000,
    extraChecks: async (ctx) => {
      if (!ctx.sessionId) {
        return [
          {
            ok: false,
            label: "intégrité store",
            detail: "session_id inconnu, check impossible",
          },
          {
            ok: false,
            label: "cohérence store (dédup)",
            detail: "session_id inconnu, check impossible",
          },
        ];
      }
      return [
        await checkStoreNotCorrupted(ctx.sessionId),
        await checkMappingInjective(ctx.sessionId),
      ];
    },
  },
];

// ---------------------------------------------------------------------------
// Exécution d'un scénario
// ---------------------------------------------------------------------------

async function runScenario(scenario: Scenario, values: string[]): Promise<ScenarioReport> {
  const snapshots = new Map<string, FileSnapshot>();
  for (const rel of scenario.filesToRestore ?? []) {
    snapshots.set(rel, await snapshotFile(rel));
  }

  try {
    const launchedAt = Date.now();
    const cli = await runClaude(scenario);
    const transcriptPath = await resolveTranscriptPath(cli, launchedAt);
    const transcriptRaw = transcriptPath ? await readFile(transcriptPath, "utf8") : null;
    const sessionId = cli.sessionIdFromJson ?? extractSessionIdFromPath(transcriptPath);

    const checks: CheckResult[] = [];

    if (cli.timedOut) {
      checks.push({
        ok: false,
        label: "exécution CLI",
        detail: `timeout dépassé (${scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`,
      });
    }
    if (!transcriptPath || !transcriptRaw) {
      checks.push({
        ok: false,
        label: "transcript localisé",
        detail: `aucun transcript trouvé dans ${TRANSCRIPTS_DIR} (session_id CLI: ${cli.sessionIdFromJson ?? "absent"})`,
      });
    } else {
      checks.push(checkZeroLeak(transcriptRaw, values, scenario.prompt));
    }

    const ctx: ScenarioContext = {
      cli,
      transcriptPath,
      transcriptRaw,
      sessionId,
    };
    if (scenario.extraChecks) {
      checks.push(...(await scenario.extraChecks(ctx)));
    }

    const status: ScenarioReport["status"] = checks.every((c) => c.ok) ? "VERT" : "ROUGE";

    return {
      id: scenario.id,
      description: scenario.description,
      status,
      durationMs: cli.durationMs,
      sessionId,
      transcriptPath,
      checks,
      cliExitCode: cli.exitCode,
      cliTimedOut: cli.timedOut,
      stderrExcerpt: cli.stderr.slice(0, 500),
    };
  } catch (err) {
    // Le harnais ne doit jamais planter entièrement sur l'échec d'un scénario.
    return {
      id: scenario.id,
      description: scenario.description,
      status: "ROUGE",
      durationMs: 0,
      sessionId: null,
      transcriptPath: null,
      checks: [
        {
          ok: false,
          label: "erreur harnais",
          detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
      ],
      cliExitCode: null,
      cliTimedOut: false,
      stderrExcerpt: "",
    };
  } finally {
    for (const [rel, snapshot] of snapshots) {
      await restoreFile(rel, snapshot).catch(() => {});
    }
  }
}

function extractSessionIdFromPath(transcriptPath: string | null): string | null {
  if (!transcriptPath) return null;
  const base = transcriptPath.split("/").pop() ?? "";
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : null;
}

// ---------------------------------------------------------------------------
// CLI (parsing, dry-run, rapport, main)
// ---------------------------------------------------------------------------

interface CliOptions {
  only: Set<string> | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let only: Set<string> | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") {
      const val = argv[++i] ?? "";
      only = new Set(
        val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg?.startsWith("--only=")) {
      only = new Set(
        arg
          .slice("--only=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }
  return { only, dryRun };
}

function printTable(reports: ScenarioReport[]): void {
  const idWidth = Math.max(...reports.map((r) => r.id.length), 4);
  const statusWidth = 6;
  console.log("");
  console.log(`${"ID".padEnd(idWidth)}  ${"STATUT".padEnd(statusWidth)}  DESCRIPTION`);
  console.log("-".repeat(idWidth + statusWidth + 60));
  for (const r of reports) {
    console.log(`${r.id.padEnd(idWidth)}  ${r.status.padEnd(statusWidth)}  ${r.description}`);
  }
  console.log("");
  for (const r of reports) {
    console.log(`## ${r.id} — ${r.status} (${r.durationMs}ms, session ${r.sessionId ?? "?"})`);
    for (const c of r.checks) {
      console.log(`   [${c.ok ? "ok" : "KO"}] ${c.label} : ${c.detail}`);
    }
    if (r.stderrExcerpt) console.log(`   stderr: ${r.stderrExcerpt.replace(/\n/g, " ")}`);
    console.log("");
  }
}

async function writeReport(reports: ScenarioReport[]): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(RESULTS_DIR, `${stamp}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    testProjectDir: TEST_PROJECT_DIR,
    valuesFile: VALUES_FILE,
    scenarios: reports,
  };
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

async function main(): Promise<void> {
  const { only, dryRun } = parseArgs(process.argv.slice(2));
  const scenarios = only ? SCENARIOS.filter((s) => only.has(s.id)) : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`Aucun scénario ne correspond à --only (${[...(only ?? [])].join(",")}).`);
    process.exit(1);
  }

  // Chargées AVANT tout (y compris --dry-run) : la garde ci-dessous en dépend
  // et doit bloquer le démarrage, pas seulement l'exécution réelle.
  let values: string[];
  try {
    values = await loadSensitiveValues();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const violations = checkPromptsAgainstSensitiveValues(scenarios, values);
  if (violations.length > 0) {
    console.error(
      "GARDE : un ou plusieurs prompts de scénario nomment littéralement une valeur sensible " +
        "des fixtures. C'est structurellement interdit (fait 17, PROGRESS.md : le modèle ne voit " +
        "qu'un placeholder dans les fichiers masqués et ne peut pas le corréler avec une valeur " +
        "nommée dans le prompt — le scénario échoue fonctionnellement en plus de fausser le check " +
        "zéro-fuite). Désigner l'entité STRUCTURELLEMENT (« le premier client », « la deuxième " +
        "adresse email »...).",
    );
    for (const v of violations) {
      console.error(`  - ${v.scenarioId} : le prompt contient "${v.value}"`);
    }
    process.exit(1);
  }

  if (dryRun) {
    console.log("Mode --dry-run : aucune session claude ne sera lancée.\n");
    for (const s of scenarios) {
      console.log(`${s.id} — ${s.description}`);
      console.log(`  ${formatCommandForDisplay(s)}`);
      if (s.filesToRestore?.length) {
        console.log(`  fichiers sauvegardés/restaurés : ${s.filesToRestore.join(", ")}`);
      }
      console.log("");
    }
    return;
  }

  if (!existsSync(TEST_PROJECT_DIR)) {
    console.error(`Répertoire de projet de test introuvable : ${TEST_PROJECT_DIR}`);
    process.exit(1);
  }

  console.log(`${values.length} valeurs sensibles chargées depuis ${VALUES_FILE}.`);
  console.log(`${scenarios.length} scénario(s) à exécuter dans ${TEST_PROJECT_DIR}.\n`);

  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    console.log(`→ ${scenario.id} : ${scenario.description}`);
    const report = await runScenario(scenario, values);
    reports.push(report);
    console.log(`  ${report.status}`);
  }

  printTable(reports);
  const reportPath = await writeReport(reports);
  console.log(`Rapport JSON écrit dans ${reportPath}`);

  const anyRed = reports.some((r) => r.status === "ROUGE");
  process.exitCode = anyRed ? 1 : 0;
}

await main();
