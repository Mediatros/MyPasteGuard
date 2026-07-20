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

/** Faux moteur /api/mask : renvoie les entités fournies, enregistre les appels. */
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
  test("défaut off si variable absente", () => {
    expect(readPromptMode({})).toBe("off");
  });

  test("valeur inconnue retombe sur off", () => {
    expect(readPromptMode({ PASTEGUARD_PROMPT_MODE: "n'importe quoi" })).toBe("off");
  });

  test("warn et block reconnus", () => {
    expect(readPromptMode({ PASTEGUARD_PROMPT_MODE: "warn" })).toBe("warn");
    expect(readPromptMode({ PASTEGUARD_PROMPT_MODE: "block" })).toBe("block");
  });
});

describe("summarizeEntities / messages", () => {
  test("types uniques, ordre de première apparition", () => {
    const summary = summarizeEntities([
      { type: "PERSON", placeholder: "[[PERSON_1]]" },
      { type: "EMAIL_ADDRESS", placeholder: "[[EMAIL_ADDRESS_1]]" },
      { type: "PERSON", placeholder: "[[PERSON_2]]" },
    ]);
    expect(summary).toEqual({ types: ["PERSON", "EMAIL_ADDRESS"], total: 3 });
  });

  test("le message d'avertissement ne contient que types + nombre, jamais de valeur", () => {
    const msg = buildWarningMessage({
      types: ["PERSON", "EMAIL_ADDRESS"],
      total: 2,
    });
    expect(msg).toContain("PERSON, EMAIL_ADDRESS");
    expect(msg).toContain("2");
    expect(msg).not.toContain("@");
  });

  test("la raison de blocage ne contient que les types, jamais de valeur", () => {
    const reason = buildBlockReason({ types: ["EMAIL_ADDRESS"], total: 1 });
    expect(reason).toContain("EMAIL_ADDRESS");
    expect(reason).toContain("!pg-off");
  });
});

describe("analysePrompt", () => {
  test("mode off : aucun appel réseau, sortie none", async () => {
    const calls: FakeCall[] = [];
    const outcome = await analysePrompt("off", "mon email est jean@exemple.fr", {
      fetchFn: noCallFetch(calls),
    });
    expect(outcome).toEqual({ kind: "none" });
    expect(calls.length).toBe(0);
  });

  test("prompt vide : aucun appel réseau", async () => {
    const calls: FakeCall[] = [];
    const outcome = await analysePrompt("warn", "   ", {
      fetchFn: noCallFetch(calls),
    });
    expect(outcome).toEqual({ kind: "none" });
    expect(calls.length).toBe(0);
  });

  test("préfixe !pg-off : aucun appel réseau", async () => {
    const calls: FakeCall[] = [];
    const outcome = await analysePrompt("block", "!pg-off jean@exemple.fr", {
      fetchFn: noCallFetch(calls),
    });
    expect(outcome).toEqual({ kind: "none" });
    expect(calls.length).toBe(0);
  });

  test("prompt propre (aucune entité) : sortie none", async () => {
    const outcome = await analysePrompt("warn", "bonjour, comment ça va ?", {
      fetchFn: fakeEngine([]),
    });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("mode warn, détection positive : systemMessage avec types, sans valeur", async () => {
    const calls: FakeCall[] = [];
    const outcome = await analysePrompt("warn", "contacte jean@exemple.fr", {
      fetchFn: fakeEngine([{ type: "EMAIL_ADDRESS", placeholder: "[[EMAIL_ADDRESS_1]]" }], calls),
    });
    expect(outcome.kind).toBe("warn");
    if (outcome.kind === "warn") {
      expect(outcome.systemMessage).toContain("EMAIL_ADDRESS");
      expect(outcome.systemMessage).not.toContain("jean@exemple.fr");
    }
    // Détection pure : pas de startFrom, pas de session_id dans le corps envoyé.
    expect(calls[0]?.body).toEqual({ text: "contacte jean@exemple.fr" });
  });

  test("mode block, détection positive : decision block avec reason listant les types", async () => {
    const outcome = await analysePrompt("block", "contacte jean@exemple.fr", {
      fetchFn: fakeEngine([{ type: "EMAIL_ADDRESS", placeholder: "[[EMAIL_ADDRESS_1]]" }]),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain("EMAIL_ADDRESS");
      expect(outcome.reason).not.toContain("jean@exemple.fr");
    }
  });

  test("moteur down (fetch qui rejette) : aucune sortie, aucun blocage", async () => {
    const outcome = await analysePrompt("block", "jean@exemple.fr", {
      fetchFn: rejectingFetch(),
    });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("statut HTTP non ok : aucune sortie, aucun blocage", async () => {
    const outcome = await analysePrompt("warn", "jean@exemple.fr", {
      fetchFn: async () => new Response("erreur", { status: 503 }),
    });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("payload imprévu (entities absent) : aucune sortie", async () => {
    const outcome = await analysePrompt("warn", "jean@exemple.fr", {
      fetchFn: async () => new Response(JSON.stringify({ surprise: true }), { status: 200 }),
    });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("JSON invalide en réponse : aucune sortie", async () => {
    const outcome = await analysePrompt("warn", "jean@exemple.fr", {
      fetchFn: async () => new Response("pas du json", { status: 200 }),
    });
    expect(outcome).toEqual({ kind: "none" });
  });
});
