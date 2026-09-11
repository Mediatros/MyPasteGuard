/**
 * Spy hook (batch 3 phase A): logs the FULL stdin payload of every hook
 * event to ~/.pasteguard/spy.jsonl then exits 0 without modifying anything.
 * Used to resolve V1 (real shape of tool_response per tool) and to prepare
 * V5/V6/V7. Never wire this outside a test project.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  const raw = await Bun.stdin.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { unparseable: raw };
  }
  const dir = join(homedir(), ".pasteguard");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    argv: process.argv.slice(2),
    payload,
  });
  await appendFile(join(dir, "spy.jsonl"), `${line}\n`, { mode: 0o600 });
} catch {
  // A spy never breaks the session: total silence.
}
process.exit(0);
