import { describe, expect, test } from "bun:test";
import {
  analysePrompt,
  buildBlockReason,
  buildWarningMessage,
  type FetchLike,
  readPromptMode,
  summarizeEntities,
} from "./user-prompt-submit";

interface FakeCall {
  url: string;
  body: unknown;
}

/** Fake /api/mask engine: returns the provided entities, records the calls. */
function fakeEngine(
  entities: { type: string; placeholder: string }[],
  calls?: FakeCall[],
): FetchLike {
  return async (url, init) => {
    calls?.push({ url: String(url), body: JSON.parse(init?.body as string) });
    return new Response(JSON.stringify({ masked: "", context: {}, counters: {}, entities }), {
      status: 200,
    });
  };
}

function rejectingFetch(): FetchLike {
  return async () => {
    throw new Error("fetch failed: connection refused");
  };
}

function noCallFetch(calls: FakeCall[]): FetchLike {
  return async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response("{}", { status: 200 });
  };
}

describe("readPromptMode", () => {
  test("defaults to off if variable is absent", () => {
    expect(readPromptMode({})).toBe("off");
  });

  test("unknown value falls back to off", () => {
    expect(readPromptMode({ PASTEGUARD_PROMPT_MODE: "whatever" })).toBe("off");
  });

  test("warn and block recognized", () => {
    expect(readPromptMode({ PASTEGUARD_PROMPT_MODE: "warn" })).toBe("warn");
    expect(readPromptMode({ PASTEGUARD_PROMPT_MODE: "block" })).toBe("block");
  });
});

describe("summarizeEntities / messages", () => {
  test("unique types, order of first appearance", () => {
    const summary = summarizeEntities([
      { type: "PERSON", placeholder: "[[PERSON_1]]" },
      { type: "EMAIL_ADDRESS", placeholder: "[[EMAIL_ADDRESS_1]]" },
      { type: "PERSON", placeholder: "[[PERSON_2]]" },
    ]);
    expect(summary).toEqual({ types: ["PERSON", "EMAIL_ADDRESS"], total: 3 });
  });

  test("the warning message contains only types + count, never a value", () => {
    const msg = buildWarningMessage({
      types: ["PERSON", "EMAIL_ADDRESS"],
      total: 2,
    });
    expect(msg).toContain("PERSON, EMAIL_ADDRESS");
    expect(msg).toContain("2");
    expect(msg).not.toContain("@");
  });

  test("the block reason contains only the types, never a value", () => {
    const reason = buildBlockReason({ types: ["EMAIL_ADDRESS"], total: 1 });
    expect(reason).toContain("EMAIL_ADDRESS");
    expect(reason).toContain("!pg-off");
  });
});

describe("analysePrompt", () => {
  test("off mode: no network call, none outcome", async () => {
    const calls: FakeCall[] = [];
    const outcome = await analysePrompt("off", "my email is jean@exemple.fr", {
      fetchFn: noCallFetch(calls),
    });
    expect(outcome).toEqual({ kind: "none" });
    expect(calls.length).toBe(0);
  });

  test("empty prompt: no network call", async () => {
    const calls: FakeCall[] = [];
    const outcome = await analysePrompt("warn", "   ", {
      fetchFn: noCallFetch(calls),
    });
    expect(outcome).toEqual({ kind: "none" });
    expect(calls.length).toBe(0);
  });

  test("!pg-off prefix: no network call", async () => {
    const calls: FakeCall[] = [];
    const outcome = await analysePrompt("block", "!pg-off jean@exemple.fr", {
      fetchFn: noCallFetch(calls),
    });
    expect(outcome).toEqual({ kind: "none" });
    expect(calls.length).toBe(0);
  });

  test("clean prompt (no entity): none outcome", async () => {
    const outcome = await analysePrompt("warn", "hello, how are you?", {
      fetchFn: fakeEngine([]),
    });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("warn mode, positive detection: systemMessage with types, no value", async () => {
    const calls: FakeCall[] = [];
    const outcome = await analysePrompt("warn", "contact jean@exemple.fr", {
      fetchFn: fakeEngine([{ type: "EMAIL_ADDRESS", placeholder: "[[EMAIL_ADDRESS_1]]" }], calls),
    });
    expect(outcome.kind).toBe("warn");
    if (outcome.kind === "warn") {
      expect(outcome.systemMessage).toContain("EMAIL_ADDRESS");
      expect(outcome.systemMessage).not.toContain("jean@exemple.fr");
    }
    // Pure detection: no startFrom, no session_id in the request body.
    expect(calls[0]?.body).toEqual({ text: "contact jean@exemple.fr" });
  });

  test("block mode, positive detection: block decision with reason listing the types", async () => {
    const outcome = await analysePrompt("block", "contact jean@exemple.fr", {
      fetchFn: fakeEngine([{ type: "EMAIL_ADDRESS", placeholder: "[[EMAIL_ADDRESS_1]]" }]),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain("EMAIL_ADDRESS");
      expect(outcome.reason).not.toContain("jean@exemple.fr");
    }
  });

  test("engine down (fetch rejects): no output, no blocking", async () => {
    const outcome = await analysePrompt("block", "jean@exemple.fr", {
      fetchFn: rejectingFetch(),
    });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("non-ok HTTP status: no output, no blocking", async () => {
    const outcome = await analysePrompt("warn", "jean@exemple.fr", {
      fetchFn: async () => new Response("error", { status: 503 }),
    });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("unexpected payload (entities missing): no output", async () => {
    const outcome = await analysePrompt("warn", "jean@exemple.fr", {
      fetchFn: async () => new Response(JSON.stringify({ surprise: true }), { status: 200 }),
    });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("invalid JSON in response: no output", async () => {
    const outcome = await analysePrompt("warn", "jean@exemple.fr", {
      fetchFn: async () => new Response("not json", { status: 200 }),
    });
    expect(outcome).toEqual({ kind: "none" });
  });
});
