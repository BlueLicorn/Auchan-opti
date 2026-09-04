import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { seedCatalog } from "@/lib/catalog";
import {
  isStale, mergeCommunityPrices, parseLocations, parsePrices,
  sameStore, type CommunityPrice,
} from "@/lib/catalog/openprices";
import { importReleve } from "@/lib/catalog/collect";

const today = new Date().toISOString().slice(0, 10);

function price(over: Partial<CommunityPrice> = {}): CommunityPrice {
  return { price: 1.42, currency: "EUR", date: today, name: "Penne", ...over };
}

describe("lecture des réponses Open Prices", () => {
  it("accepte la pagination sous ses différentes formes", () => {
    const attendu = [{ osm_id: 42, osm_name: "Auchan Villars", osm_type: "way" }];
    for (const payload of [
      { items: attendu },
      { results: attendu },
      { data: attendu },
      attendu,
    ]) {
      const locations = parseLocations(payload);
      assert.equal(locations.length, 1, `forme non reconnue : ${JSON.stringify(payload).slice(0, 40)}`);
      assert.equal(locations[0].osmType, "WAY", "le type OSM doit être normalisé");
    }
  });

  it("ignore une entrée de magasin inexploitable", () => {
    const locations = parseLocations({ items: [{ osm_name: "Sans identifiant" }, { osm_id: 7 }] });
    assert.equal(locations.length, 0);
  });

  it("lit un prix, que le produit soit imbriqué ou à plat", () => {
    const imbrique = parsePrices({
      items: [{
        price: 1.42, currency: "EUR", date: "2026-08-30T10:00:00Z",
        product_code: "3245390000001",
        product: { product_name: "Penne 500 g", brands: "Auchan" },
        location: { osm_name: "Auchan Villars" },
      }],
    });
    assert.equal(imbrique.length, 1);
    assert.equal(imbrique[0].code, "3245390000001");
    assert.equal(imbrique[0].name, "Penne 500 g");
    assert.equal(imbrique[0].date, "2026-08-30", "l'horodatage doit être ramené à une date");
    assert.equal(imbrique[0].store, "Auchan Villars");

    const plat = parsePrices({
      items: [{ price: "2,15", currency: "eur", product_code: "1", product_name: "Riz" }],
    });
    assert.equal(plat[0].price, 2.15, "la virgule décimale doit être acceptée");
    assert.equal(plat[0].currency, "EUR");
  });

  it("écarte une ligne sans prix exploitable", () => {
    assert.equal(parsePrices({ items: [{ price: 0 }, { price: "abc" }, {}] }).length, 0);
  });

  it("ne casse pas sur une réponse inattendue", () => {
    for (const payload of [null, undefined, 42, "texte", {}, { items: "pas un tableau" }]) {
      assert.equal(parsePrices(payload).length, 0);
      assert.equal(parseLocations(payload).length, 0);
    }
  });
});

describe("fusion des prix communautaires", () => {
  it("comble une estimation", () => {
    const result = mergeCommunityPrices([price()], seedCatalog);
    assert.equal(result.applied, 1);
    const penne = result.catalog.products.find((p) => p.id === "es-penne")!;
    assert.equal(penne.price, 1.42);
    assert.equal(penne.priceFrom.source, "communaute");
  });

  it("ne remplace jamais un relevé personnel", () => {
    const perso = importReleve(
      JSON.stringify({ produits: [{ nom: "Penne", prix: 1.15, releveLe: "2020-01-01" }] }),
    ).catalog;

    const result = mergeCommunityPrices([price({ price: 3.5, date: today })], perso);

    assert.equal(result.skipped, 1);
    assert.equal(
      result.catalog.products.find((p) => p.id === "es-penne")!.price,
      1.15,
      "un prix d'inconnu ne doit pas écraser le relevé de l'utilisateur, même plus ancien",
    );
  });

  it("remplace un prix communautaire plus ancien", () => {
    const ancien = mergeCommunityPrices([price({ price: 1.1, date: "2025-01-01" })], seedCatalog);
    const recent = mergeCommunityPrices([price({ price: 1.6, date: today })], ancien.catalog);
    assert.equal(recent.applied, 1);
    assert.equal(recent.catalog.products.find((p) => p.id === "es-penne")!.price, 1.6);
  });

  it("apparie par code-barres avant le libellé", () => {
    const base = {
      ...seedCatalog,
      products: seedCatalog.products.map((p) =>
        p.id === "es-penne" ? { ...p, ean: "3245390000001" } : p,
      ),
    };
    const result = mergeCommunityPrices(
      [price({ code: "3245390000001", name: "Libellé sans rapport", price: 2.4 })],
      base,
    );
    assert.equal(result.applied, 1);
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.price, 2.4);
  });

  it("mémorise le code-barres découvert, pour les appariements suivants", () => {
    const result = mergeCommunityPrices([price({ code: "3245390000009" })], seedCatalog);
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.ean, "3245390000009");
  });

  it("écarte les devises étrangères", () => {
    const result = mergeCommunityPrices([price({ currency: "CHF", price: 2 })], seedCatalog);
    assert.equal(result.foreign, 1);
    assert.equal(result.applied, 0);
  });

  it("compte les prix qu'il n'a pas su rattacher", () => {
    const result = mergeCommunityPrices(
      [price({ name: "Zzzz produit totalement inconnu", code: "0000000000000" })],
      seedCatalog,
    );
    assert.equal(result.unmatched, 1);
  });

  it("ne modifie jamais le catalogue reçu", () => {
    const avant = seedCatalog.products.find((p) => p.id === "es-penne")!.price;
    mergeCommunityPrices([price({ price: 99 })], seedCatalog);
    assert.equal(seedCatalog.products.find((p) => p.id === "es-penne")!.price, avant);
  });
});

describe("fraîcheur et magasin", () => {
  it("signale un prix trop ancien pour être fiable", () => {
    assert.equal(isStale(price({ date: "2020-01-01" })), true);
    assert.equal(isStale(price({ date: today })), false);
  });

  it("compare les magasins sans se laisser piéger par la casse", () => {
    assert.ok(sameStore("Auchan Villars", "auchan  villars"));
    assert.ok(!sameStore("Auchan Villars", "Auchan Bordeaux"));
    assert.ok(!sameStore(undefined, "Auchan Villars"));
  });
});
