import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthInputs,
  describeAuthMode,
  detectAuthMode,
  readAuthInputs,
  shouldRunHooks,
} from "./auth-mode";

const PASTEGUARD_URL = "http://localhost:3333";
const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKE0123456789";

function inputs(overrides: Partial<AuthInputs> = {}): AuthInputs {
  return { env: {}, claudeConfig: null, ...overrides };
}

describe("detectAuthMode: mode detection", () => {
  test("third-party flag wins over everything else", () => {
    const result = detectAuthMode(
      inputs({
        env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: FAKE_KEY },
      }),
      PASTEGUARD_URL,
    );
    expect(result.mode).toBe("third-party");
  });

  test("ANTHROPIC_AUTH_TOKEN present -> api-key", () => {
    const result = detectAuthMode(
      inputs({ env: { ANTHROPIC_AUTH_TOKEN: FAKE_KEY } }),
      PASTEGUARD_URL,
    );
    expect(result.mode).toBe("api-key");
  });

  test("ANTHROPIC_API_KEY not previously rejected -> api-key", () => {
    const result = detectAuthMode(inputs({ env: { ANTHROPIC_API_KEY: FAKE_KEY } }), PASTEGUARD_URL);
    expect(result.mode).toBe("api-key");
  });

  test("ANTHROPIC_API_KEY rejected in interactive mode -> subscription + note", () => {
    const suffix = FAKE_KEY.slice(-20);
    const result = detectAuthMode(
      inputs({
        env: { ANTHROPIC_API_KEY: FAKE_KEY },
        claudeConfig: { customApiKeyResponses: { rejected: [suffix] } },
      }),
      PASTEGUARD_URL,
    );
    expect(result.mode).toBe("subscription");
    expect(result.notes.some((n) => n.includes("-p"))).toBe(true);
  });

  test("oauthAccount present, no env key -> subscription", () => {
    const result = detectAuthMode(inputs({ claudeConfig: { oauthAccount: {} } }), PASTEGUARD_URL);
    expect(result.mode).toBe("subscription");
  });

  test("nothing set -> unknown", () => {
    const result = detectAuthMode(inputs(), PASTEGUARD_URL);
    expect(result.mode).toBe("unknown");
  });
});

describe("detectAuthMode: proxied", () => {
  test("localhost vs 127.0.0.1 with same port -> same origin", () => {
    const result = detectAuthMode(
      inputs({
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3333/anthropic" },
      }),
      "http://localhost:3333",
    );
    expect(result.proxied).toBe(true);
  });

  test("different port -> not proxied", () => {
    const result = detectAuthMode(
      inputs({
        env: { ANTHROPIC_BASE_URL: "http://localhost:4444/anthropic" },
      }),
      PASTEGUARD_URL,
    );
    expect(result.proxied).toBe(false);
  });

  test("api.anthropic.com -> not proxied", () => {
    const result = detectAuthMode(
      inputs({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }),
      PASTEGUARD_URL,
    );
    expect(result.proxied).toBe(false);
  });

  test("invalid URL -> not proxied", () => {
    const result = detectAuthMode(
      inputs({ env: { ANTHROPIC_BASE_URL: "not a url" } }),
      PASTEGUARD_URL,
    );
    expect(result.proxied).toBe(false);
  });
});

describe("detectAuthMode: hooksActive", () => {
  test("api-key + proxied -> hooks paused", () => {
    const result = detectAuthMode(
      inputs({
        env: {
          ANTHROPIC_API_KEY: FAKE_KEY,
          ANTHROPIC_BASE_URL: "http://localhost:3333",
        },
      }),
      PASTEGUARD_URL,
    );
    expect(result.hooksActive).toBe(false);
  });

  test("subscription + proxied -> hooks stay active", () => {
    const result = detectAuthMode(
      inputs({
        env: { ANTHROPIC_BASE_URL: "http://localhost:3333" },
        claudeConfig: { oauthAccount: {} },
      }),
      PASTEGUARD_URL,
    );
    expect(result.hooksActive).toBe(true);
  });

  test("api-key + not proxied -> hooks active", () => {
    const result = detectAuthMode(inputs({ env: { ANTHROPIC_API_KEY: FAKE_KEY } }), PASTEGUARD_URL);
    expect(result.hooksActive).toBe(true);
  });

  test("third-party -> hooks active", () => {
    const result = detectAuthMode(
      inputs({ env: { CLAUDE_CODE_USE_VERTEX: "true" } }),
      PASTEGUARD_URL,
    );
    expect(result.hooksActive).toBe(true);
  });

  test("unknown -> hooks active", () => {
    const result = detectAuthMode(inputs(), PASTEGUARD_URL);
    expect(result.hooksActive).toBe(true);
  });
});

describe("detectAuthMode: notes never contain the key", () => {
  test("across every branch", () => {
    const cases: AuthInputs[] = [
      inputs({ env: { ANTHROPIC_API_KEY: FAKE_KEY } }),
      inputs({
        env: {
          ANTHROPIC_API_KEY: FAKE_KEY,
          ANTHROPIC_BASE_URL: "http://localhost:3333",
        },
      }),
      inputs({
        env: { ANTHROPIC_API_KEY: FAKE_KEY },
        claudeConfig: {
          customApiKeyResponses: { rejected: [FAKE_KEY.slice(-20)] },
        },
      }),
      inputs({
        claudeConfig: { oauthAccount: {} },
        env: { ANTHROPIC_BASE_URL: "http://localhost:3333" },
      }),
      inputs({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
      inputs(),
    ];
    for (const c of cases) {
      const result = detectAuthMode(c, PASTEGUARD_URL);
      const text = [describeAuthMode(result), ...result.notes].join(" ");
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(FAKE_KEY.slice(-20));
    }
  });
});

describe("describeAuthMode", () => {
  test("subscription line", () => {
    const result = detectAuthMode(inputs({ claudeConfig: { oauthAccount: {} } }), PASTEGUARD_URL);
    expect(describeAuthMode(result)).toContain("subscription (OAuth) detected, hooks active.");
  });

  test("api-key proxied line", () => {
    const result = detectAuthMode(
      inputs({
        env: {
          ANTHROPIC_API_KEY: FAKE_KEY,
          ANTHROPIC_BASE_URL: "http://localhost:3333",
        },
      }),
      PASTEGUARD_URL,
    );
    expect(describeAuthMode(result)).toContain("hooks paused");
  });

  test("api-key without proxy line", () => {
    const result = detectAuthMode(inputs({ env: { ANTHROPIC_API_KEY: FAKE_KEY } }), PASTEGUARD_URL);
    expect(describeAuthMode(result)).toContain("API key without proxy, hooks active.");
  });
});

describe("readAuthInputs", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("valid file with oauthAccount", async () => {
    dir = await mkdtemp(join(tmpdir(), "pg-auth-"));
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { id: "x" } }));
    const result = await readAuthInputs({ CLAUDE_CONFIG_DIR: dir });
    expect(result.claudeConfig?.oauthAccount).toEqual({ id: "x" });
  });

  test("invalid JSON -> null config", async () => {
    dir = await mkdtemp(join(tmpdir(), "pg-auth-"));
    await writeFile(join(dir, ".claude.json"), "{not json");
    const result = await readAuthInputs({ CLAUDE_CONFIG_DIR: dir });
    expect(result.claudeConfig).toBeNull();
  });

  test("missing file -> null config", async () => {
    dir = await mkdtemp(join(tmpdir(), "pg-auth-"));
    const result = await readAuthInputs({ CLAUDE_CONFIG_DIR: dir });
    expect(result.claudeConfig).toBeNull();
  });
});

describe("shouldRunHooks", () => {
  const originalEnv = { ...process.env };
  let dir: string;

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("proxied API key -> false", async () => {
    dir = await mkdtemp(join(tmpdir(), "pg-auth-"));
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env.ANTHROPIC_BASE_URL = "http://localhost:3333/anthropic";
    process.env.PASTEGUARD_URL = "http://localhost:3333";
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(await shouldRunHooks()).toBe(false);
  });

  test("subscription (oauthAccount in config) -> true", async () => {
    dir = await mkdtemp(join(tmpdir(), "pg-auth-"));
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { id: "x" } }));
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    process.env.PASTEGUARD_URL = "http://localhost:3333";
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(await shouldRunHooks()).toBe(true);
  });

  test("API key not proxied -> true", async () => {
    dir = await mkdtemp(join(tmpdir(), "pg-auth-"));
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    process.env.PASTEGUARD_URL = "http://localhost:3333";
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(await shouldRunHooks()).toBe(true);
  });

  test("detection error -> true (fail-safe)", async () => {
    dir = await mkdtemp(join(tmpdir(), "pg-auth-"));
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    process.env.PASTEGUARD_URL = "not a url";
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(await shouldRunHooks()).toBe(true);
  });
});
