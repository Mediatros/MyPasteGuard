import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireLock, type LockOptions } from "./lock";
import { freshState, type SessionState } from "./types";

export function sessionsDir(): string {
  return process.env.PASTEGUARD_SESSION_DIR ?? join(homedir(), ".pasteguard", "claude-sessions");
}

function sessionFile(sessionId: string, dir?: string): string {
  return join(dir ?? sessionsDir(), `${sessionId}.json`);
}

function isValidState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as SessionState;
  return (
    state.version === 1 &&
    typeof state.counters === "object" &&
    state.counters !== null &&
    typeof state.mapping === "object" &&
    state.mapping !== null
  );
}

export async function loadState(sessionId: string, dir?: string): Promise<SessionState> {
  const file = sessionFile(sessionId, dir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return freshState();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidState(parsed)) throw new Error("invalid session state shape");
    return parsed;
  } catch {
    // Fichier corrompu : le mettre de côté pour diagnostic et repartir vierge.
    await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    return freshState();
  }
}

export async function saveState(
  sessionId: string,
  state: SessionState,
  dir?: string,
): Promise<void> {
  const base = dir ?? sessionsDir();
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700).catch(() => {});
  const file = sessionFile(sessionId, dir);
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(state), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, file);
}

export async function withSessionLock<T>(
  sessionId: string,
  fn: (state: SessionState) => T | Promise<T>,
  opts?: { dir?: string; lock?: LockOptions },
): Promise<T> {
  const base = opts?.dir ?? sessionsDir();
  await mkdir(base, { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${sessionFile(sessionId, opts?.dir)}.lock`, opts?.lock);
  try {
    // Toujours relire sous verrou : un autre hook a pu écrire entre-temps.
    const state = await loadState(sessionId, opts?.dir);
    const result = await fn(state);
    await saveState(sessionId, state, opts?.dir);
    return result;
  } finally {
    await release();
  }
}

/**
 * Chaînage de session (préparation R6/V7) : si la nouvelle session n'a pas encore
 * d'état et que l'ancienne en a un, recopier le mapping pour que les placeholders
 * du transcript repris restent restaurables.
 */
export async function linkSession(fromId: string, toId: string, dir?: string): Promise<boolean> {
  const from = sessionFile(fromId, dir);
  const to = sessionFile(toId, dir);
  try {
    await copyFile(from, to, 1 /* COPYFILE_EXCL : ne pas écraser un état existant */);
    await chmod(to, 0o600).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
