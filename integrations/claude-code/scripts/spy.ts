/**
 * Hook espion (lot 3 phase A) : logge le payload stdin COMPLET de chaque
 * événement hook dans ~/.pasteguard/spy.jsonl puis sort en 0 sans rien
 * modifier. Sert à lever V1 (forme réelle de tool_response par outil) et à
 * préparer V5/V6/V7. Ne jamais brancher hors d'un projet de test.
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
  // Un espion ne casse jamais la session : silence total.
}
process.exit(0);
