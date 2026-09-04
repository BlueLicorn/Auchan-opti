import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  applyOverrides, coverage, isEstimate, provenanceLabel, seedCatalog,
} from "@/lib/catalog";
import { importReleve } from "@/lib/catalog/collect";
import type { Catalog } from "@/lib/types";

const today = new Date().toISOString().slice(0, 10);

function releve(produits: unknown[]): string {
  return JSON.stringify({ version: 1, produits });
}

describe("import d'un relevé magasin", () => {
  it("remplace un prix estimé par le prix relevé, avec sa provenance", () => {
    const result = importReleve(releve([
      { nom: "Penne", prix: 1.42, stock: "en_rayon", magasin: "Auchan Villars", releveLe: today },
    ]));

    assert.equal(result.matched, 1);
    const penne = result.catalog.products.find((p) => p.id === "es-penne")!;
    assert.equal(penne.price, 1.42);
    assert.equal(penne.priceFrom.source, "collecte");
    assert.equal(penne.priceFrom.store, "Auchan Villars");
    assert.equal(penne.stock, "en_rayon");
    assert.equal(result.storeLabel, "Auchan Villars");
  });

  it("apparie par code-barres en priorité sur le libellé", () => {
    const base: Catalog = {
      ...seedCatalog,
      products: seedCatalog.products.map((p) =>
        p.id === "es-penne" ? { ...p, ean: "3245390000001" } : p,
      ),
    };

    const result = importReleve(
      releve([{ nom: "Libellé du site totalement différent", ean: "3245390000001", prix: 2.1 }]),
      base,
    );

    assert.equal(result.added, 0, "le code-barres doit éviter la création d'un doublon");
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.price, 2.1);
  });

  it("enregistre une rupture même sans prix", () => {
    const result = importReleve(releve([{ nom: "Penne", stock: "rupture" }]));
    assert.equal(result.stockUpdated, 1);
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.stock, "rupture");
  });

  it("rejette un prix invraisemblable plutôt que de fausser le budget", () => {
    const result = importReleve(releve([{ nom: "Penne", prix: 9999 }]));
    assert.equal(result.matched, 0);
    assert.ok(result.rejected.some((r) => r.reason.includes("invraisemblable")));
    assert.equal(
      result.catalog.products.find((p) => p.id === "es-penne")!.price,
      seedCatalog.products.find((p) => p.id === "es-penne")!.price,
      "le prix d'origine doit être intact",
    );
  });

  it("écarte une entrée sans nom ni disponibilité exploitable", () => {
    const result = importReleve(releve([{ prix: 2 }, { nom: "X" }]));
    assert.equal(result.matched, 0);
    assert.equal(result.added, 0);
    assert.equal(result.rejected.length, 2);
  });

  it("refuse un contenu qui n'est pas un relevé", () => {
    const result = importReleve("ceci n'est pas du JSON");
    assert.equal(result.catalog, seedCatalog, "le catalogue ne doit pas être touché");
    assert.ok(result.rejected[0].reason.includes("JSON"));
  });

  it("ajoute un produit inconnu quand il a un prix", () => {
    const result = importReleve(releve([
      { nom: "Yaourt de brebis bio", ean: "3256540000000", prix: 3.2, stock: "en_rayon" },
    ]));
    assert.equal(result.added, 1);
    const ajoute = result.catalog.products.find((p) => p.name === "Yaourt de brebis bio")!;
    assert.equal(ajoute.priceFrom.source, "collecte");
    assert.equal(ajoute.ean, "3256540000000");
  });
});

describe("fiabilité affichée", () => {
  it("compte le catalogue embarqué comme entièrement estimé", () => {
    const stats = coverage(seedCatalog.products);
    assert.equal(stats.realPrices, 0, "aucun prix du catalogue n'est un relevé");
    assert.equal(stats.knownStock, 0, "le stock d'un magasin n'est pas connu d'avance");
    assert.ok(seedCatalog.products.every(isEstimate));
  });

  it("distingue un prix relevé d'un prix estimé", () => {
    const result = importReleve(releve([{ nom: "Penne", prix: 1.42, releveLe: today }]));
    const stats = coverage(result.catalog.products);
    assert.equal(stats.realPrices, 1);
    assert.ok(provenanceLabel(
      result.catalog.products.find((p) => p.id === "es-penne")!.priceFrom,
    ).includes("relevé"));
  });

  it("signale un relevé périmé", () => {
    const result = importReleve(releve([{ nom: "Penne", prix: 1.42, releveLe: "2020-01-01" }]));
    assert.equal(coverage(result.catalog.products).stale, 1);
  });
});

describe("priorité entre sources", () => {
  it("laisse le relevé du jour l'emporter sur une correction ancienne", () => {
    const collecte = importReleve(
      releve([{ nom: "Penne", prix: 1.42, releveLe: today }]),
    ).catalog;

    const avec = applyOverrides(collecte, [
      { productId: "es-penne", price: 9.99, at: "2020-01-01" },
    ]);

    assert.equal(
      avec.products.find((p) => p.id === "es-penne")!.price,
      1.42,
      "une saisie de 2020 ne doit pas écraser un relevé d'aujourd'hui",
    );
  });

  it("laisse une correction du jour l'emporter sur un relevé ancien", () => {
    const collecte = importReleve(
      releve([{ nom: "Penne", prix: 1.42, releveLe: "2020-01-01" }]),
    ).catalog;

    const avec = applyOverrides(collecte, [
      { productId: "es-penne", price: 2.05, at: today },
    ]);

    const penne = avec.products.find((p) => p.id === "es-penne")!;
    assert.equal(penne.price, 2.05);
    assert.equal(penne.priceFrom.source, "saisie");
  });

  it("applique toujours une correction sur un prix seulement estimé", () => {
    const avec = applyOverrides(seedCatalog, [
      { productId: "es-penne", price: 2.05, at: "2020-01-01" },
    ]);
    assert.equal(avec.products.find((p) => p.id === "es-penne")!.price, 2.05);
  });
});
