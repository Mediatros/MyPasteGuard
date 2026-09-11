/**
 * POC V5 (batch 3 phase A): checks that hookSpecificOutput.updatedToolOutput
 * is honored by the installed version of Claude Code.
 * FINDING (binary 2.1.215): updatedToolOutput must reproduce the SHAPE of
 * the tool's tool_response (validation "does not match tool's output
 * shape"), it is NOT a string. For Read: { type, file: { content, ... } }.
 * Never wire this outside a test project.
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
