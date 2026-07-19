import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchLike, MaskUnavailableError, maskText } from "./mask-client";
import { loadState, saveState } from "./store";
import { freshState } from "./types";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pg-mask-"));
}

interface FakeEngineCall {
  text: string;
  startFrom: Record<string, number>;
}

/**
 * Faux moteur /api/mask reproduisant le comportement prouvé au lot 1 :
 * détection d'emails par regex, placeholders numérotés depuis startFrom,
 * AUCUNE dédup entre appels.
 */
function fakeEngine(calls?: FakeEngineCall[], latencyMs = 0): FetchLike {
  return async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as FakeEngineCall;
    calls?.push(body);
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * latencyMs));
    }
    const counters = { ...body.startFrom };
    const context: Record<string, string> = {};
    const entities: { type: string; placeholder: string }[] = [];
    const masked = body.text.replace(/[a-z0-9.]+@[a-z0-9.]+/g, (value) => {
      counters.EMAIL_ADDRESS = (counters.EMAIL_ADDRESS ?? 0) + 1;
      const placeholder = `[[EMAIL_ADDRESS_${counters.EMAIL_ADDRESS}]]`;
      context[placeholder] = value;
      entities.push({ type: "EMAIL_ADDRESS", placeholder });
      return placeholder;
    });
    return new Response(JSON.stringify({ masked, context, counters, entities }), { status: 200 });
  };
}

describe("maskText", () => {
  test("texte vide ou blanc : aucun appel réseau", async () => {
    const dir = await tempDir();
    const calls: FakeEngineCall[] = [];
    const result = await maskText("s", "   ", {
      dir,
      fetchFn: fakeEngine(calls),
    });
    expect(result).toEqual({ masked: "   ", changed: false });
    expect(calls.length).toBe(0);
  });

  test("masquage simple + fusion counters et mapping", async () => {
    const dir = await tempDir();
    const result = await maskText("s", "mail: jean@exemple.fr", {
      dir,
      fetchFn: fakeEngine(),
    });
    expect(result.masked).toBe("mail: [[EMAIL_ADDRESS_1]]");
    expect(result.changed).toBe(true);
    const state = await loadState("s", dir);
    expect(state.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("jean@exemple.fr");
    expect(state.counters.EMAIL_ADDRESS).toBe(1);
  });

  test("pré-remplacement : valeur déjà connue remplacée AVANT l'appel, valeurs imbriquées", async () => {
    const dir = await tempDir();
    const state = freshState();
    state.mapping["[[PERSON_1]]"] = "Jean Dupont";
    state.mapping["[[PERSON_2]]"] = "Dupont";
    state.counters.PERSON = 2;
    await saveState("s", state, dir);

    const calls: FakeEngineCall[] = [];
    const result = await maskText("s", "Jean Dupont et Dupont sont là", {
      dir,
      fetchFn: fakeEngine(calls),
    });
    // « Jean Dupont » (plus long) remplacé d'abord, puis « Dupont » seul.
    expect(calls[0]?.text).toBe("[[PERSON_1]] et [[PERSON_2]] sont là");
    expect(result.masked).toBe("[[PERSON_1]] et [[PERSON_2]] sont là");
    expect(result.changed).toBe(true);
  });

  test("startFrom envoyé = counters de session", async () => {
    const dir = await tempDir();
    const state = freshState();
    state.counters.EMAIL_ADDRESS = 4;
    await saveState("s", state, dir);

    const result = await maskText("s", "mail: nouveau@exemple.fr", {
      dir,
      fetchFn: fakeEngine(),
    });
    expect(result.masked).toBe("mail: [[EMAIL_ADDRESS_5]]");
    expect((await loadState("s", dir)).counters.EMAIL_ADDRESS).toBe(5);
  });

  test("dédup passe b : variante détectée d'une valeur déjà mappée → placeholder existant réutilisé", async () => {
    const dir = await tempDir();
    const state = freshState();
    // Valeur déjà connue sous un placeholder, mais introuvable par le
    // pré-remplacement exact (on simule via un faux moteur qui la re-détecte).
    state.mapping["[[EMAIL_ADDRESS_1]]"] = "jean@exemple.fr";
    state.counters.EMAIL_ADDRESS = 1;
    await saveState("s", state, dir);

    const engine: FetchLike = async () =>
      new Response(
        JSON.stringify({
          masked: "mail: [[EMAIL_ADDRESS_2]]",
          context: { "[[EMAIL_ADDRESS_2]]": "jean@exemple.fr" },
          counters: { EMAIL_ADDRESS: 2 },
          entities: [{ type: "EMAIL_ADDRESS", placeholder: "[[EMAIL_ADDRESS_2]]" }],
        }),
        { status: 200 },
      );

    const result = await maskText("s", "mail: JEAN@exemple.fr", {
      dir,
      fetchFn: engine,
    });
    expect(result.masked).toBe("mail: [[EMAIL_ADDRESS_1]]");
    const after = await loadState("s", dir);
    expect(after.mapping["[[EMAIL_ADDRESS_2]]"]).toBeUndefined();
  });

  test("placeholder re-détecté comme entité → masquage annulé, pas de poupée russe (bug E2E lot 4)", async () => {
    const dir = await tempDir();
    const state = freshState();
    state.mapping["[[PERSON_2]]"] = "Sarah Connor";
    state.counters.PERSON = 2;
    await saveState("s", state, dir);

    // GLiNER voit « [[PERSON_2]] » (issu du pré-remplacement) comme une personne.
    const engine: FetchLike = async () =>
      new Response(
        JSON.stringify({
          masked: "[[PERSON_3]], consultante",
          context: { "[[PERSON_3]]": "[[PERSON_2]]" },
          counters: { PERSON: 3 },
          entities: [{ type: "PERSON", placeholder: "[[PERSON_3]]" }],
        }),
        { status: 200 },
      );

    const result = await maskText("s", "Sarah Connor, consultante", {
      dir,
      fetchFn: engine,
    });
    expect(result.masked).toBe("[[PERSON_2]], consultante");
    expect(result.changed).toBe(true);
    const after = await loadState("s", dir);
    expect(after.mapping["[[PERSON_3]]"]).toBeUndefined();
    expect(after.mapping["[[PERSON_2]]"]).toBe("Sarah Connor");
  });

  test("idempotence (R14) : un texte déjà masqué ressort intact", async () => {
    const dir = await tempDir();
    const state = freshState();
    state.mapping["[[EMAIL_ADDRESS_1]]"] = "jean@exemple.fr";
    state.counters.EMAIL_ADDRESS = 1;
    await saveState("s", state, dir);

    const result = await maskText("s", "mail: [[EMAIL_ADDRESS_1]]", {
      dir,
      fetchFn: fakeEngine(),
    });
    expect(result.masked).toBe("mail: [[EMAIL_ADDRESS_1]]");
    expect(result.changed).toBe(false);
  });

  test("erreur réseau → MaskUnavailableError, état inchangé", async () => {
    const dir = await tempDir();
    const failing: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      maskText("s", "mail: jean@exemple.fr", { dir, fetchFn: failing }),
    ).rejects.toBeInstanceOf(MaskUnavailableError);
    expect(await loadState("s", dir)).toEqual(freshState());
  });

  test("HTTP non-200 → MaskUnavailableError", async () => {
    const dir = await tempDir();
    const engine503: FetchLike = async () => new Response("busy", { status: 503 });
    await expect(maskText("s", "texte", { dir, fetchFn: engine503 })).rejects.toBeInstanceOf(
      MaskUnavailableError,
    );
  });
});

describe("concurrence bout en bout", () => {
  test("10 maskText parallèles : une valeur = un placeholder, aucun doublon", async () => {
    const dir = await tempDir();
    const shared = "commun@exemple.fr";
    const texts = Array.from(
      { length: 10 },
      (_, i) => `msg ${i}: ${shared} et perso${i}@exemple.fr`,
    );

    const results = await Promise.all(
      texts.map((text) => maskText("s", text, { dir, fetchFn: fakeEngine(undefined, 20) })),
    );

    const state = await loadState("s", dir);
    // Une valeur n'apparaît que sous UN placeholder.
    const values = Object.values(state.mapping);
    expect(new Set(values).size).toBe(values.length);
    // 11 valeurs distinctes attendues (1 commune + 10 perso).
    expect(values.length).toBe(11);
    // La valeur commune porte le même placeholder dans toutes les sorties.
    const sharedPlaceholder = Object.entries(state.mapping).find(([, v]) => v === shared)?.[0];
    expect(sharedPlaceholder).toBeDefined();
    for (const result of results) {
      expect(result.masked).toContain(sharedPlaceholder as string);
      expect(result.masked).not.toContain("@exemple.fr");
    }
  });
});
