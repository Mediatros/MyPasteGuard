/**
 * Hook PreToolUse : restaure les vraies valeurs dans les entrées des outils
 * à effet LOCAL avant exécution (lot 4). Mode validé en V2 (claude 2.1.215) :
 * `updatedInput` SANS permissionDecision — honoré, flux de permission préservé.
 * Politique D6 : placeholder non résolu ou erreur de store → deny, jamais
 * laisser s'exécuter une entrée corrompue.
 * Limite prouvée (V2) : un Edit dont old_string ne matche pas le disque échoue
 * AVANT ce hook ; ce cas est traité par consigne côté projet protégé (Bash sed).
 * stdout = UNIQUEMENT le JSON de réponse du hook (règle R12).
 */
import { withSessionLock } from "../lib/store";
import { inputHasPlaceholders, restoreToolInput } from "../lib/tool-input";

interface HookPayload {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}

function emitDeny(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
      suppressOutput: true,
    }),
  );
}

let payload: HookPayload = {};
try {
  payload = JSON.parse(await Bun.stdin.text()) as HookPayload;
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput } = payload;
  if (!toolName || toolInput === undefined || toolInput === null) process.exit(0);

  // Cas ultra-majoritaire : aucun placeholder dans les champs candidats.
  if (!inputHasPlaceholders(toolName, toolInput)) process.exit(0);

  if (!sessionId) {
    emitDeny(
      "PasteGuard : placeholders présents mais session_id absent du payload, restauration impossible.",
    );
    process.exit(0);
  }

  // Verrou court : lecture cohérente de l'état pendant que d'autres hooks écrivent.
  const result = await withSessionLock(sessionId, (state) =>
    restoreToolInput(state, toolName, toolInput),
  );

  if (result.action === "deny") {
    emitDeny(result.reason);
  } else if (result.action === "update") {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: result.updatedInput,
        },
        suppressOutput: true,
      }),
    );
  }
  process.exit(0);
} catch (err) {
  // D6 : erreur de verrou, de store ou payload imprévu → refuser l'exécution.
  emitDeny(
    "PasteGuard : échec de la restauration des placeholders (état de session inaccessible). " +
      "Vérifier la session PasteGuard puis réessayer.",
  );
  if (err instanceof Error) console.error(err.message);
  process.exit(0);
}
