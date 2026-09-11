import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class LockTimeoutError extends Error {
  constructor(lockDir: string) {
    super(`Lock acquisition timed out: ${lockDir}`);
    this.name = "LockTimeoutError";
  }
}

export interface LockOptions {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
}

export type ReleaseLock = () => Promise<void>;

interface LockOwner {
  pid: number;
  acquiredAt: string;
}

async function tryBreakStaleLock(lockDir: string, staleMs: number): Promise<void> {
  let acquiredAtMs: number | null = null;
  try {
    const raw = await readFile(join(lockDir, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as LockOwner;
    acquiredAtMs = Date.parse(owner.acquiredAt);
  } catch {
    // owner.json missing or unreadable: lock is being acquired or already broken.
    // Only break it if staleness can be proven via owner.json.
    return;
  }
  if (acquiredAtMs !== null && !Number.isNaN(acquiredAtMs) && Date.now() - acquiredAtMs > staleMs) {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function acquireLock(lockDir: string, opts?: LockOptions): Promise<ReleaseLock> {
  const retryMs = opts?.retryMs ?? 25;
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const staleMs = opts?.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      const owner: LockOwner = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      };
      await writeFile(join(lockDir, "owner.json"), JSON.stringify(owner), "utf8");
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await tryBreakStaleLock(lockDir, staleMs);
      if (Date.now() >= deadline) throw new LockTimeoutError(lockDir);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
