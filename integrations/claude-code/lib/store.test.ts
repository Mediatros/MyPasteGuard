import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkSession, loadState, saveState, withSessionLock } from "./store";
import { freshState } from "./types";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pg-store-"));
}

describe("loadState / saveState", () => {
  test("fresh state when file is absent", async () => {
    const dir = await tempDir();
    const state = await loadState("absent", dir);
    expect(state).toEqual({ version: 1, counters: {}, mapping: {} });
  });

  test("round trip: save then load", async () => {
    const dir = await tempDir();
    const state = freshState();
    state.counters.EMAIL_ADDRESS = 2;
    state.mapping["[[EMAIL_ADDRESS_1]]"] = "jean@exemple.fr";
    await saveState("s1", state, dir);
    expect(await loadState("s1", dir)).toEqual(state);
  });

  test("corrupted JSON → fresh state + .corrupt-* file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "s2.json"), "{pas du json");
    const state = await loadState("s2", dir);
    expect(state).toEqual(freshState());
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith("s2.json.corrupt-"))).toBe(true);
    expect(files.includes("s2.json")).toBe(false);
  });

  test("invalid shape (unknown version) → fresh state", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "s3.json"), JSON.stringify({ version: 2 }));
    expect(await loadState("s3", dir)).toEqual(freshState());
  });

  test("atomic write: no leftover temporary file", async () => {
    const dir = await tempDir();
    await saveState("s4", freshState(), dir);
    const files = await readdir(dir);
    expect(files).toEqual(["s4.json"]);
  });

  test("permissions: file mode 600", async () => {
    const dir = await tempDir();
    await saveState("s5", freshState(), dir);
    const mode = (await stat(join(dir, "s5.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("withSessionLock", () => {
  test("mutations saved, value returned", async () => {
    const dir = await tempDir();
    const result = await withSessionLock(
      "s6",
      (state) => {
        state.counters.PERSON = 1;
        return "ok";
      },
      { dir },
    );
    expect(result).toBe("ok");
    expect((await loadState("s6", dir)).counters.PERSON).toBe(1);
  });

  test("concurrent critical sections serialized (no lost updates)", async () => {
    const dir = await tempDir();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withSessionLock(
          "s7",
          async (state) => {
            const current = state.counters.N ?? 0;
            await new Promise((resolve) => setTimeout(resolve, 5));
            state.counters.N = current + 1;
          },
          { dir },
        ),
      ),
    );
    expect((await loadState("s7", dir)).counters.N).toBe(10);
  });
});

describe("linkSession", () => {
  test("copies state to a new session, without overwriting existing state", async () => {
    const dir = await tempDir();
    const state = freshState();
    state.mapping["[[PERSON_1]]"] = "Jean Dupont";
    await saveState("old", state, dir);

    expect(await linkSession("old", "new", dir)).toBe(true);
    expect((await loadState("new", dir)).mapping["[[PERSON_1]]"]).toBe("Jean Dupont");

    // The target now exists: no overwrite.
    expect(await linkSession("old", "new", dir)).toBe(false);
    // Missing source: clean failure.
    expect(await linkSession("missing", "new2", dir)).toBe(false);
  });

  test("the linked file's content remains valid JSON", async () => {
    const dir = await tempDir();
    await saveState("a", freshState(), dir);
    await linkSession("a", "b", dir);
    const raw = await readFile(join(dir, "b.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
