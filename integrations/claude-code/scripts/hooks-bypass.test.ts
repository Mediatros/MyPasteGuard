/**
 * Integration test for the auth-mode bypass (shouldRunHooks) wired into the
 * three masking hooks: when a session's traffic already goes through the
 * PasteGuard proxy with an API key (hooksActive === false), each hook must
 * exit 0 with EMPTY stdout, before any masking/restoration/network/store
 * work, so tool input/output and the prompt pass through unchanged. This
 * must hold even with no PasteGuard server running: the bypass happens
 * before the first network call.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKE0123456789";

const POST_TOOL_USE_SCRIPT = join(import.meta.dir, "post-tool-use.ts");
const PRE_TOOL_USE_SCRIPT = join(import.meta.dir, "pre-tool-use.ts");
const USER_PROMPT_SUBMIT_SCRIPT = join(import.meta.dir, "user-prompt-submit.ts");

const POST_TOOL_USE_PAYLOAD = {
  session_id: "test-session-post",
  tool_name: "Read",
  tool_response: {
    type: "text",
    file: {
      content: "Contact: Jean Dupont, jean.dupont@example.com",
      filePath: "/tmp/x.txt",
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    },
  },
};

const PRE_TOOL_USE_PAYLOAD = {
  session_id: "test-session-pre",
  tool_name: "Bash",
  tool_input: { command: "echo [[PERSON_1]]" },
};

const USER_PROMPT_SUBMIT_PAYLOAD = {
  session_id: "test-session-prompt",
  prompt: "mail jean.dupont@example.com",
};

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runScript(
  scriptPath: string,
  payload: unknown,
  env: Record<string, string>,
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", scriptPath],
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

interface BypassEnvDirs {
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

/** Proxied API key: shouldRunHooks() must resolve to false without any network call. */
async function bypassEnv(): Promise<BypassEnvDirs> {
  const configDir = await mkdtemp(join(tmpdir(), "pg-hooks-config-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pg-hooks-session-"));
  const env = baseEnv();
  env.ANTHROPIC_API_KEY = FAKE_KEY;
  env.ANTHROPIC_BASE_URL = "http://localhost:3333/anthropic";
  env.PASTEGUARD_URL = "http://localhost:3333";
  env.CLAUDE_CONFIG_DIR = configDir;
  env.PASTEGUARD_SESSION_DIR = sessionDir;
  return {
    env,
    cleanup: async () => {
      await rm(configDir, { recursive: true, force: true });
      await rm(sessionDir, { recursive: true, force: true });
    },
  };
}

describe("hooks bypass in proxied API key mode", () => {
  test("post-tool-use.ts: exit 0, empty stdout, no PasteGuard server needed", async () => {
    const { env, cleanup } = await bypassEnv();
    try {
      const result = await runScript(POST_TOOL_USE_SCRIPT, POST_TOOL_USE_PAYLOAD, env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await cleanup();
    }
  });

  test("pre-tool-use.ts: exit 0, empty stdout, no PasteGuard server needed", async () => {
    const { env, cleanup } = await bypassEnv();
    try {
      const result = await runScript(PRE_TOOL_USE_SCRIPT, PRE_TOOL_USE_PAYLOAD, env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await cleanup();
    }
  });

  test("user-prompt-submit.ts: exit 0, empty stdout, no PasteGuard server needed", async () => {
    const { env, cleanup } = await bypassEnv();
    try {
      const result = await runScript(USER_PROMPT_SUBMIT_SCRIPT, USER_PROMPT_SUBMIT_PAYLOAD, env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await cleanup();
    }
  });

  test("control: without the proxy, an unreachable PasteGuard fails closed (stdout not empty)", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "pg-hooks-config-"));
    const sessionDir = await mkdtemp(join(tmpdir(), "pg-hooks-session-"));
    try {
      const env = baseEnv();
      env.ANTHROPIC_API_KEY = FAKE_KEY;
      delete env.ANTHROPIC_BASE_URL;
      env.PASTEGUARD_URL = "http://127.0.0.1:9";
      env.CLAUDE_CONFIG_DIR = configDir;
      env.PASTEGUARD_SESSION_DIR = sessionDir;

      const result = await runScript(POST_TOOL_USE_SCRIPT, POST_TOOL_USE_PAYLOAD, env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toBe("");
    } finally {
      await rm(configDir, { recursive: true, force: true });
      await rm(sessionDir, { recursive: true, force: true });
    }
  }, 15_000);
});
