import { afterEach, describe, expect, test } from "bun:test";
import { callAnthropic } from "./client";
import type { AnthropicRequest } from "./types";

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string;
}

function mockFetch(): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({
      url: request.url,
      headers: new Headers(request.headers),
      body: await request.clone().text(),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-3-haiku-20240307",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const baseConfig = { base_url: "https://api.anthropic.com" };

const baseRequest: AnthropicRequest = {
  model: "claude-3-haiku-20240307",
  max_tokens: 100,
  messages: [{ role: "user", content: "Hello" }],
};

describe("callAnthropic header forwarding", () => {
  test("forwards client identity headers unchanged", async () => {
    const calls = mockFetch();

    await callAnthropic(baseRequest, baseConfig, {
      "user-agent": "claude-cli/2.0.0 (external, cli)",
      "x-stainless-lang": "js",
      "x-stainless-runtime": "node",
      "x-app": "cli",
      "anthropic-beta": "oauth-2025-04-20,prompt-caching-2024-07-31",
      authorization: "Bearer sk-ant-oat01-token",
    });

    expect(calls).toHaveLength(1);
    const headers = calls[0].headers;
    expect(headers.get("user-agent")).toBe("claude-cli/2.0.0 (external, cli)");
    expect(headers.get("x-stainless-lang")).toBe("js");
    expect(headers.get("x-stainless-runtime")).toBe("node");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20,prompt-caching-2024-07-31");
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-token");
  });

  test("drops hop-by-hop and recomputed headers", async () => {
    const calls = mockFetch();

    await callAnthropic(baseRequest, baseConfig, {
      host: "localhost:3000",
      "content-length": "9999",
      connection: "keep-alive",
      "accept-encoding": "br",
      "user-agent": "claude-cli/2.0.0",
    });

    const headers = calls[0].headers;
    expect(headers.get("host")).not.toBe("localhost:3000");
    expect(headers.get("connection")).not.toBe("keep-alive");
    // content-length must match the re-serialized body, not the client value
    expect(headers.get("content-length")).not.toBe("9999");
    expect(headers.get("user-agent")).toBe("claude-cli/2.0.0");
  });

  test("preserves client anthropic-version, defaults when absent", async () => {
    const calls = mockFetch();

    await callAnthropic(baseRequest, baseConfig, { "anthropic-version": "2024-10-22" });
    await callAnthropic(baseRequest, baseConfig, {});

    expect(calls[0].headers.get("anthropic-version")).toBe("2024-10-22");
    expect(calls[1].headers.get("anthropic-version")).toBe("2023-06-01");
  });

  test("client x-api-key takes priority over config api_key", async () => {
    const calls = mockFetch();

    await callAnthropic(
      baseRequest,
      { ...baseConfig, api_key: "config-key" },
      { "x-api-key": "client-key" },
    );

    expect(calls[0].headers.get("x-api-key")).toBe("client-key");
  });

  test("client authorization prevents config api_key fallback", async () => {
    const calls = mockFetch();

    await callAnthropic(
      baseRequest,
      { ...baseConfig, api_key: "config-key" },
      { authorization: "Bearer client-token" },
    );

    expect(calls[0].headers.get("authorization")).toBe("Bearer client-token");
    expect(calls[0].headers.get("x-api-key")).toBeNull();
  });

  test("falls back to config api_key when client sends no auth", async () => {
    const calls = mockFetch();

    await callAnthropic(baseRequest, { ...baseConfig, api_key: "config-key" }, {});

    expect(calls[0].headers.get("x-api-key")).toBe("config-key");
  });

  test("always sets content-type to application/json", async () => {
    const calls = mockFetch();

    await callAnthropic(baseRequest, baseConfig, {
      "content-type": "application/json; charset=utf-8",
    });

    expect(calls[0].headers.get("content-type")).toBe("application/json");
  });
});
