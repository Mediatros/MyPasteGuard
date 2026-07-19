/**
 * POC V5 (lot 3 phase A) : vérifie que hookSpecificOutput.updatedToolOutput
 * est honoré par la version installée de Claude Code.
 * DÉCOUVERTE (binaire 2.1.215) : updatedToolOutput doit reproduire la FORME du
 * tool_response de l'outil (validation « does not match tool's output shape »),
 * ce n'est PAS une string. Pour Read : { type, file: { content, ... } }.
 * Ne jamais brancher hors d'un projet de test.
 */
export {};

interface ReadResponse {
  type?: string;
  file?: { content?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface SpyPayload {
  tool_name?: string;
  tool_response?: ReadResponse;
}

const payload = JSON.parse(await Bun.stdin.text()) as SpyPayload;
const response = payload.tool_response;
const content = response?.file?.content;
if (payload.tool_name === "Read" && response && typeof content === "string") {
  const updated = {
    ...response,
    file: { ...response.file, content: `${content}\n[HOOK-OK-V5-7d3f]` },
  };
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: updated,
      },
    }),
  );
}
process.exit(0);
