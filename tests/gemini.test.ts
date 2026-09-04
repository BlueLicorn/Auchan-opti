import { strict as assert } from "node:assert";
import { describe, it, afterEach } from "node:test";

import { FALLBACK_MODELS, listModels, preferredModel } from "@/lib/ai/gemini";

const vraiFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = vraiFetch; });

/** Répond à l'appel de liste avec le corps donné. */
function repond(models: unknown[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ models }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const modele = (name: string) => ({
  name, displayName: name, supportedGenerationMethods: ["generateContent"],
});

describe("liste des modèles Gemini", () => {
  it("écarte les variantes datées et les modèles hors texte", async () => {
    repond([
      modele("models/gemini-2.5-flash"),
      modele("models/gemini-2.0-flash-001"),
      modele("models/text-embedding-004"),
      modele("models/gemini-2.5-flash-image"),
    ]);
    const ids = (await listModels("k")).map((m) => m.id);
    assert.deepEqual(ids, ["gemini-2.5-flash"]);
  });

  it("ignore ce qui ne sait pas générer du contenu", async () => {
    repond([
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-truc", supportedGenerationMethods: ["countTokens"] },
    ]);
    assert.deepEqual((await listModels("k")).map((m) => m.id), ["gemini-2.5-flash"]);
  });

  it("rend les modèles bruts plutôt que la liste codée en dur quand le tri vide tout", async () => {
    // Le cas qui compte : la clé n'ouvre que des variantes datées. Proposer
    // alors des noms écrits il y a des mois, c'est promettre un 404.
    repond([modele("models/gemini-2.0-flash-001"), modele("models/gemini-2.0-pro-002")]);
    const ids = (await listModels("k")).map((m) => m.id);
    assert.deepEqual(ids, ["gemini-2.0-flash-001", "gemini-2.0-pro-002"]);
  });

  it("ne se rabat sur la liste écrite en dur que si l'API ne rend rien", async () => {
    repond([]);
    assert.deepEqual(await listModels("k"), FALLBACK_MODELS);
  });

  it("remonte l'erreur HTTP au lieu de faire semblant", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "clé morte" } }), { status: 403 })) as typeof fetch;
    await assert.rejects(() => listModels("k"), /refusée/i);
  });
});

describe("choix du modèle par défaut", () => {
  const liste = (...ids: string[]) => ids.map((id) => ({ id, label: id }));

  it("préfère un Flash complet à un Flash allégé", () => {
    assert.equal(
      preferredModel(liste("gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.5-flash"))?.id,
      "gemini-2.5-flash",
    );
  });

  it("accepte un Flash allégé s'il n'y a que celui-là", () => {
    assert.equal(preferredModel(liste("gemini-2.5-pro", "gemini-2.5-flash-lite"))?.id,
      "gemini-2.5-flash-lite");
  });

  it("prend le premier venu quand aucun Flash n'existe", () => {
    assert.equal(preferredModel(liste("gemini-9-pro"))?.id, "gemini-9-pro");
  });

  it("ne rend rien sur une liste vide", () => {
    assert.equal(preferredModel([]), undefined);
  });
});
