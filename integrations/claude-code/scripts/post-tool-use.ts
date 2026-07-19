/**
 * Hook PostToolUse : masque les PII/secrets des sorties d'outils AVANT leur
 * entrée dans le contexte (lot 3 phase B). Politique D6 : fail-closed, jamais
 * laisser passer une sortie brute en cas d'échec du masquage.
 * stdout = UNIQUEMENT le JSON de réponse du hook (règle R12).
 */
import { maskText } from "../lib/mask-client";
import { totalTextLength, transformToolResponse } from "../lib/tool-output";

/** Au-delà de ce volume, GLiNER est trop lent (~0,6 s/Ko, mesure lot 1) : secrets seuls. */
const PII_SCAN_CAP_CHARS = 30_000;

const RETENTION_MESSAGE =
  "[PasteGuard indisponible : la sortie de l'outil a été retenue par sécurité. " +
  "Démarrer PasteGuard (bun run start) puis relancer l'outil.]";

const BIG_OUTPUT_NOTE =
  "[PasteGuard : sortie volumineuse, masquage PII désactivé sur cette sortie, secrets masqués]\n";

interface HookPayload {
  session_id?: string;
  tool_name?: string;
  tool_response?: unknown;
}

/** Outils sans contenu sensible exploitable : ne pas payer le coût du masquage. */
const SKIP_TOOLS = new Set(["TodoWrite", "AskUserQuestion", "ToolSearch", "ExitPlanMode"]);

function emit(updatedToolOutput: unknown, systemMessage?: string): void {
  const output: Record<string, unknown> = {
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput },
    suppressOutput: true,
  };
  if (systemMessage) output.systemMessage = systemMessage;
  console.log(JSON.stringify(output));
}

async function failClosed(toolName: string, toolResponse: unknown): Promise<void> {
  // Substitution de TOUS les champs texte par le message de rétention, en
  // préservant la forme (contrainte updatedToolOutput).
  const { response } = await transformToolResponse(
    toolName,
    toolResponse,
    async () => RETENTION_MESSAGE,
  );
  emit(response, "PasteGuard indisponible : sorties d'outils retenues (fail-closed).");
}

let payload: HookPayload = {};
try {
  payload = JSON.parse(await Bun.stdin.text()) as HookPayload;
  const sessionId = payload.session_id;
  const toolName = payload.tool_name;
  const toolResponse = payload.tool_response;

  if (!sessionId || !toolName || toolResponse === undefined || toolResponse === null) {
    process.exit(0);
  }
  if (SKIP_TOOLS.has(toolName)) process.exit(0);

  const totalLength = await totalTextLength(toolName, toolResponse);
  if (totalLength === 0) process.exit(0);

  const secretsOnly = totalLength > PII_SCAN_CAP_CHARS;
  const detect = secretsOnly ? (["secrets"] as const) : undefined;

  let changed = false;
  let firstField = true;
  const { response } = await transformToolResponse(toolName, toolResponse, async (text) => {
    const result = await maskText(sessionId, text, detect ? { detect: [...detect] } : undefined);
    changed = changed || result.changed;
    if (firstField && secretsOnly) {
      firstField = false;
      return BIG_OUTPUT_NOTE + result.masked;
    }
    firstField = false;
    return result.masked;
  });

  if (!changed && !secretsOnly) process.exit(0);
  emit(response);
  process.exit(0);
} catch (err) {
  // D6 : toute erreur (PasteGuard down, verrou, payload imprévu) → rétention.
  try {
    await failClosed(payload.tool_name ?? "", payload.tool_response ?? RETENTION_MESSAGE);
  } catch {
    emit(RETENTION_MESSAGE, "PasteGuard : échec du masquage ET de la substitution.");
  }
  if (err instanceof Error) console.error(err.message);
  process.exit(0);
}
