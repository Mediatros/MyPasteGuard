import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AnthropicRequestSchema } from "../providers/anthropic/types";
import { anthropicRoutes } from "./anthropic";

const app = new Hono();
app.route("/anthropic", anthropicRoutes);

describe("POST /anthropic/v1/messages", () => {
  test("returns 400 for missing messages", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 100,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("returns 400 for empty messages array", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 100,
        messages: [],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  test("accepts non-standard roles (Claude Code sends system messages)", () => {
    const result = AnthropicRequestSchema.safeParse({
      model: "claude-3-haiku-20240307",
      max_tokens: 100,
      messages: [
        { role: "system", content: "Reminder" },
        { role: "user", content: "test" },
      ],
    });

    expect(result.success).toBe(true);
  });

  test("returns 400 for missing model", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for missing max_tokens", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "Hello" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });
});

describe("Zod schema preserves cache_control and unknown fields", () => {
  const base = {
    model: "claude-3-sonnet-20240229",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  };

  test("preserves cache_control on text content block", () => {
    const input = {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    };

    const result = AnthropicRequestSchema.parse(input);
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    const block = (result.messages[0].content as any[])[0];

    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves cache_control on system prompt block", () => {
    const input = {
      ...base,
      system: [
        {
          type: "text",
          text: "You are helpful.",
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    const result = AnthropicRequestSchema.parse(input);
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    const block = (result.system as any[])[0];

    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves cache_control on tool definition", () => {
    const input = {
      ...base,
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    const result = AnthropicRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result.tools![0] as any).cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("preserves cache_control on message", () => {
    const input = {
      ...base,
      messages: [
        {
          role: "user",
          content: "Hello",
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    const result = AnthropicRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result.messages[0] as any).cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("preserves unknown top-level fields", () => {
    const input = { ...base, custom_field: "preserved" };

    const result = AnthropicRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result as any).custom_field).toBe("preserved");
  });
});

describe("Zod schema tolerates unknown Anthropic structures", () => {
  const base = {
    model: "claude-3-sonnet-20240229",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  };

  test("accepts and preserves unknown content block types", () => {
    const input = {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Check this document" },
            {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "file content",
              },
              citations: { enabled: true },
            },
          ],
        },
      ],
    };

    const result = AnthropicRequestSchema.parse(input);
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown block preservation
    const blocks = result.messages[0].content as any[];

    expect(blocks[1].type).toBe("document");
    expect(blocks[1].source.data).toBe("file content");
    expect(blocks[1].citations).toEqual({ enabled: true });
  });

  test("accepts server_tool_use blocks in assistant messages", () => {
    const input = {
      ...base,
      messages: [
        { role: "user", content: "Search something" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "test" },
            },
          ],
        },
        { role: "user", content: "Thanks" },
      ],
    };

    expect(() => AnthropicRequestSchema.parse(input)).not.toThrow();
  });

  test("accepts tool_result without content", () => {
    const input = {
      ...base,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1" }],
        },
      ],
    };

    expect(() => AnthropicRequestSchema.parse(input)).not.toThrow();
  });

  test("accepts tool_choice none", () => {
    const input = { ...base, tool_choice: { type: "none" } };

    expect(() => AnthropicRequestSchema.parse(input)).not.toThrow();
  });

  test("accepts server tools without input_schema", () => {
    const input = {
      ...base,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    };

    expect(() => AnthropicRequestSchema.parse(input)).not.toThrow();
  });
});
