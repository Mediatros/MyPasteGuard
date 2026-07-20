/**
 * Hook UserPromptSubmit : détecte les PII/secrets tapés directement dans le
 * prompt et avertit (mode warn) ou bloque (mode block) avant l'envoi.
 * Piloté par la variable d'env `PASTEGUARD_PROMPT_MODE` (défaut "off").
 *
 * RENVERSEMENT DE POLITIQUE (à l'inverse de D6, cf. post-tool-use.ts) : ce
 * hook n'est PAS fail-closed. Une panne du moteur (down, timeout, payload
 * imprévu) ne doit JAMAIS rendre la session inutilisable en empêchant
 * l'utilisateur de parler à Claude Code : toute erreur → exit 0 SANS
 * blocage ET SANS avertissement. Ce canal reste "best effort" par nature :
 * l'utilisateur maîtrise ce qu'il tape, contrairement aux sorties d'outils.
 *
 * Ce hook ne réécrit JAMAIS le prompt : `UserPromptSubmit` ne le permet pas
 * (doc officielle ; pas de champ `updatedPrompt`). En mode warn, le prompt
 * part donc EN CLAIR quoi qu'il arrive ; l'avertissement est pédagogique.
 *
 * Aucune écriture dans le session store : le prompt n'est jamais masqué ici
 * (bloqué = jamais parti, autorisé = parti en clair), donc `/api/mask` est
 * appelé directement (fetch nu), SANS passer par `maskText` de
 * `lib/mask-client.ts` qui charge/écrit l'état de session sous verrou — un
 * mapping créé pour ce texte polluerait les compteurs pour rien.
 *
 * Jamais de valeur détectée affichée : seuls les TYPES et leur nombre
 * apparaissent dans l'avertissement ou la raison de blocage.
 *
 * stdout = UNIQUEMENT le JSON de réponse du hook (règle R12). Diagnostics
 * sur stderr.
 */

export type PromptMode = "off" | "warn" | "block";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_URL = "http://localhost:3333";
const NETWORK_TIMEOUT_MS = 2_000;

/** Préfixe d'échappatoire : force l'envoi du prompt sans détection (reste dans le texte, inoffensif). */
const BYPASS_PREFIX = "!pg-off";

interface HookPayload {
  session_id?: string;
  prompt?: string;
}

interface MaskApiEntity {
  type: string;
  placeholder: string;
}

interface MaskApiResponse {
  entities?: MaskApiEntity[];
}

export interface EntitySummary {
  types: string[];
  total: number;
}

export interface AnalyseOptions {
  url?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export type HookOutcome =
  | { kind: "none" }
  | { kind: "warn"; systemMessage: string }
  | { kind: "block"; reason: string };

/** Lit PASTEGUARD_PROMPT_MODE ; toute valeur inconnue retombe sur "off" (défaut sûr). */
export function readPromptMode(env: Record<string, string | undefined> = process.env): PromptMode {
  const raw = env.PASTEGUARD_PROMPT_MODE;
  if (raw === "warn" || raw === "block") return raw;
  return "off";
}

/** Résumé des entités détectées : types uniques (ordre de première apparition) + total. */
export function summarizeEntities(entities: MaskApiEntity[]): EntitySummary {
  const types: string[] = [];
  for (const entity of entities) {
    if (!types.includes(entity.type)) types.push(entity.type);
  }
  return { types, total: entities.length };
}

/** Avertissement (mode warn) : jamais de valeur, uniquement types + nombre. */
export function buildWarningMessage(summary: EntitySummary): string {
  const plural = summary.total > 1 ? "s" : "";
  return (
    `PasteGuard : votre prompt contient ${summary.total} entité${plural} sensible${plural} ` +
    `(${summary.types.join(", ")}). Le texte que vous tapez part EN CLAIR, il n'est pas masqué.`
  );
}

/** Raison de blocage (mode block) : jamais de valeur, types + porte de sortie. */
export function buildBlockReason(summary: EntitySummary): string {
  return (
    `PasteGuard : le prompt contient ${summary.types.join(", ")}. Reformuler sans la valeur, ` +
    "ou la mettre dans un fichier et référencer le fichier (son contenu sera masqué). " +
    `Pour forcer l'envoi malgré tout : préfixer le prompt de ${BYPASS_PREFIX}.`
  );
}

/**
 * Analyse le prompt selon le mode. Ne lève jamais : toute erreur réseau, de
 * statut HTTP ou de payload retombe sur `{ kind: "none" }` (renversement D6
 * documenté en tête de fichier).
 */
export async function analysePrompt(
  mode: PromptMode,
  prompt: string | undefined,
  opts: AnalyseOptions = {},
): Promise<HookOutcome> {
  if (mode === "off") return { kind: "none" };
  if (!prompt || prompt.trim().length === 0) return { kind: "none" };
  if (prompt.startsWith(BYPASS_PREFIX)) return { kind: "none" };

  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${opts.url ?? process.env.PASTEGUARD_URL ?? DEFAULT_URL}/api/mask`;

  let response: MaskApiResponse;
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: prompt }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? NETWORK_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: "none" };
    response = (await res.json()) as MaskApiResponse;
  } catch {
    return { kind: "none" };
  }

  if (!Array.isArray(response.entities) || response.entities.length === 0) {
    return { kind: "none" };
  }

  const summary = summarizeEntities(response.entities);
  if (mode === "block") return { kind: "block", reason: buildBlockReason(summary) };
  return { kind: "warn", systemMessage: buildWarningMessage(summary) };
}

async function main(): Promise<void> {
  try {
    const mode = readPromptMode();
    if (mode === "off") process.exit(0);

    const payload = JSON.parse(await Bun.stdin.text()) as HookPayload;
    const outcome = await analysePrompt(mode, payload.prompt);

    if (outcome.kind === "none") process.exit(0);
    if (outcome.kind === "warn") {
      console.log(JSON.stringify({ systemMessage: outcome.systemMessage }));
      process.exit(0);
    }
    console.log(JSON.stringify({ decision: "block", reason: outcome.reason }));
    process.exit(0);
  } catch (err) {
    // Renversement D6 : stdin invalide, moteur down, timeout, payload
    // imprévu → exit 0 SANS blocage et SANS avertissement.
    if (err instanceof Error) console.error(err.message);
    process.exit(0);
  }
}

if (import.meta.main) {
  await main();
}
