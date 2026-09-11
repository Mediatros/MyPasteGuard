import { homedir } from "node:os";
import { join } from "node:path";
import { pasteguardUrl } from "./mask-client";

const THIRD_PARTY_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export interface AuthInputs {
  env: Record<string, string | undefined>;
  claudeConfig: {
    oauthAccount?: unknown;
    customApiKeyResponses?: { approved?: string[]; rejected?: string[] };
  } | null;
}

export type AuthMode = "subscription" | "api-key" | "third-party" | "unknown";

export interface AuthModeResult {
  mode: AuthMode;
  proxied: boolean;
  hooksActive: boolean;
  notes: string[];
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** Same-host normalization: localhost, 127.0.0.1 and ::1 are treated as one origin. */
function normalizeHost(host: string): string {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "localhost";
  return host;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    return (
      urlA.protocol === urlB.protocol &&
      normalizeHost(urlA.hostname) === normalizeHost(urlB.hostname) &&
      urlA.port === urlB.port
    );
  } catch {
    return false;
  }
}

function isProxied(env: Record<string, string | undefined>, pasteguardUrlValue: string): boolean {
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return false;
  return sameOrigin(base, pasteguardUrlValue);
}

export function detectAuthMode(inputs: AuthInputs, pasteguardUrlValue: string): AuthModeResult {
  const { env, claudeConfig } = inputs;
  const proxied = isProxied(env, pasteguardUrlValue);
  const notes: string[] = [];

  let mode: AuthMode;
  if (THIRD_PARTY_FLAGS.some((flag) => isTruthyFlag(env[flag]))) {
    mode = "third-party";
  } else if (env.ANTHROPIC_AUTH_TOKEN) {
    mode = "api-key";
  } else if (env.ANTHROPIC_API_KEY) {
    const suffix = env.ANTHROPIC_API_KEY.slice(-20);
    if (claudeConfig?.customApiKeyResponses?.rejected?.includes(suffix)) {
      mode = "subscription";
      notes.push("Non-interactive runs (`claude -p`) would still use the environment API key.");
    } else {
      mode = "api-key";
    }
  } else if (claudeConfig?.oauthAccount) {
    mode = "subscription";
  } else {
    mode = "unknown";
  }

  // Hooks stay active in every combination except an API key going through the
  // proxy: the proxy already masks all traffic there, so hooks would double-mask
  // our own [[TYPE_n]] placeholders. Every other case keeps hooks on (safe default).
  const hooksActive = !(proxied && mode === "api-key");

  if (mode === "subscription" && proxied) {
    notes.push(
      "ANTHROPIC_BASE_URL points to PasteGuard, but subscription credentials cannot go through a proxy: unset it. Hooks stay active.",
    );
  } else if (mode === "api-key" && !proxied) {
    const url = new URL(pasteguardUrlValue);
    notes.push(`Recommended: set ANTHROPIC_BASE_URL=${url.origin}/anthropic to also mask prompts.`);
  } else if (mode === "third-party") {
    notes.push("The PasteGuard proxy does not support Bedrock/Vertex/Foundry; hooks stay active.");
  } else if (mode === "unknown") {
    notes.push("Authentication method not detected; hooks stay active.");
  }

  return { mode, proxied, hooksActive, notes };
}

function claudeConfigPath(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR ?? homedir();
  return join(dir, ".claude.json");
}

export async function readAuthInputs(
  env: Record<string, string | undefined> = process.env,
): Promise<AuthInputs> {
  let claudeConfig: AuthInputs["claudeConfig"] = null;
  try {
    const raw: unknown = await Bun.file(claudeConfigPath(env)).json();
    if (typeof raw === "object" && raw !== null) {
      const { oauthAccount, customApiKeyResponses } = raw as {
        oauthAccount?: unknown;
        customApiKeyResponses?: { approved?: string[]; rejected?: string[] };
      };
      claudeConfig = { oauthAccount, customApiKeyResponses };
    }
  } catch {
    claudeConfig = null;
  }
  return { env, claudeConfig };
}

/**
 * Fail-safe wrapper for the masking hooks: any detection error must keep
 * hooks active (a false positive costs double-masking, a false negative costs a leak).
 */
export async function shouldRunHooks(): Promise<boolean> {
  try {
    return detectAuthMode(await readAuthInputs(), pasteguardUrl()).hooksActive;
  } catch {
    return true;
  }
}

export function describeAuthMode(result: AuthModeResult): string {
  let summary: string;
  switch (result.mode) {
    case "subscription":
      summary = "PasteGuard: subscription (OAuth) detected, hooks active.";
      break;
    case "api-key":
      summary = result.proxied
        ? "PasteGuard: API key through the PasteGuard proxy, hooks paused (the proxy masks all traffic)."
        : "PasteGuard: API key without proxy, hooks active.";
      break;
    case "third-party":
      summary = "PasteGuard: third-party backend (Bedrock/Vertex/Foundry) detected, hooks active.";
      break;
    default:
      summary = "PasteGuard: authentication method unknown, hooks active.";
  }
  return [summary, ...result.notes].join(" ");
}
