/**
 * SessionStart hook: tells the user which authentication mode was detected
 * (subscription/OAuth vs API key vs third-party backend) and whether the
 * masking hooks are active or paused for this session (an API key routed
 * through the PasteGuard proxy already gets everything masked, so the hooks
 * pause to avoid double-masking).
 *
 * Never fails the session: any error -> no stdout, exit 0, diagnostic on stderr.
 */

import type { AuthModeResult } from "../lib/auth-mode";
import { describeAuthMode, detectAuthMode, readAuthInputs } from "../lib/auth-mode";
import { pasteguardUrl } from "../lib/mask-client";

export function computeSessionStartOutput(result: AuthModeResult): string {
  return JSON.stringify({ systemMessage: describeAuthMode(result) });
}

async function main(): Promise<void> {
  // Stdin content is irrelevant to this hook; drain it so Claude Code doesn't block.
  await Bun.stdin.text();

  const inputs = await readAuthInputs();
  const result = detectAuthMode(inputs, pasteguardUrl());
  console.log(computeSessionStartOutput(result));
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof Error) console.error(err.message);
    process.exit(0);
  });
}
