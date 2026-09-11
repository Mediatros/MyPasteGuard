/**
 * CLI for humans: prints the detected auth mode and whether hooks are active.
 * Usage: bun run integrations/claude-code/scripts/doctor.ts
 */

import { describeAuthMode, detectAuthMode, readAuthInputs } from "../lib/auth-mode";
import { pasteguardUrl } from "../lib/mask-client";

async function main(): Promise<void> {
  const inputs = await readAuthInputs();
  const result = detectAuthMode(inputs, pasteguardUrl());
  console.log(JSON.stringify(result, null, 2));
  console.log(describeAuthMode(result));
}

await main();
