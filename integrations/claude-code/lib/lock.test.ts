import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockTimeoutError } from "./lock";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pg-lock-"));
}

describe("acquireLock", () => {
  test("two concurrent acquisitions serialize", async () => {
    const lockDir = join(await tempDir(), "s.lock");
    const order: string[] = [];

    const release1 = await acquireLock(lockDir);
    const second = acquireLock(lockDir).then(async (release2) => {
      order.push("second acquired");
      await release2();
    });
    order.push("first held");
    await new Promise((resolve) => setTimeout(resolve, 100));
    order.push("first releasing");
    await release1();
    await second;

    expect(order).toEqual(["first held", "first releasing", "second acquired"]);
  });

  test("stale lock (owner.json too old) broken and reacquired", async () => {
    const lockDir = join(await tempDir(), "s.lock");
    await mkdir(lockDir);
    const stale = {
      pid: 99999,
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await writeFile(join(lockDir, "owner.json"), JSON.stringify(stale));

    const release = await acquireLock(lockDir, {
      staleMs: 30_000,
      timeoutMs: 2_000,
    });
    expect(typeof release).toBe("function");
    await release();
  });

  test("acquisition timeout → LockTimeoutError", async () => {
    const lockDir = join(await tempDir(), "s.lock");
    const release = await acquireLock(lockDir);
    await expect(acquireLock(lockDir, { timeoutMs: 150, staleMs: 60_000 })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    await release();
  });
});
