import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { comparablePrice, filterCatalog } from "@/lib/catalog";
import { echantillonnerCatalogue } from "@/lib/ai/prompts";
import type { Catalog } from "@/lib/types";

const catalogue = JSON.parse(
  readFileSync("public/catalogue-magasin.json", "utf8"),
) as Catalog;

/**
 * Le catalogue du magasin est une donnée livrée, pas du code : rien ne la
 * relit à chaque modification. Ces vérifications tiennent lieu de relecture.
 */
describe("catalogue du magasin", () => {
  const produits = catalogue.products;

  it("porte un magasin et une date", () => {
    assert.ok(catalogue.storeLabel, "le magasin doit être nommé");
    assert.match(catalogue.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(produits.length > 1000, `${produits.length} produits, c'est trop peu`);
  });

  it("n'a ni prix nul, ni conditionnement nul, ni identifiant en double", () => {
    const vus = new Set<string>();
    for (const p of produits) {
      assert.ok(p.price > 0, `${p.name} : prix ${p.price}`);
      assert.ok(p.packSize > 0, `${p.name} : conditionnement ${p.packSize}`);
      assert.ok(["g", "ml", "piece"].includes(p.unit), `${p.name} : unité ${p.unit}`);
      assert.ok(!vus.has(p.id), `identifiant en double : ${p.id}`);
      vus.add(p.id);
    }
  });

  it("annonce des prix relevés, pas des estimations", () => {
    assert.ok(
      produits.every((p) => p.priceFrom.source === "collecte"),
      "un prix venu du magasin ne doit pas être marqué comme estimé",
    );
    assert.ok(produits.every((p) => p.priceFrom.store === catalogue.storeLabel));
  });

  it("ne contient aucun rayon non alimentaire", () => {
    // « Croquettes de pommes de terre » est un aliment : c'est le complément
    // « pour chat » qui trahit l'animalerie, pas le mot seul.
    const interdits = /pour (chat|chien)|litiere|litière|lessive|shampoing|dentifrice/i;
    const fautifs = produits.filter((p) => interdits.test(p.name));
    assert.deepEqual(fautifs.map((p) => p.name), [], "produit non alimentaire au catalogue");
  });

  it("garde de quoi composer un repas dans chaque famille utile", () => {
    // Sans protéine, sans féculent ou sans légume, aucun gabarit ne se remplit.
    for (const [famille, minimum] of [
      ["pates", 10], ["riz", 5], ["legume", 20], ["legumineuse", 10],
      ["oeuf", 3], ["fromage", 20], ["poulet", 10], ["matiere-grasse", 5],
    ] as const) {
      const n = produits.filter((p) => p.category === famille).length;
      assert.ok(n >= minimum, `${famille} : ${n} produits, moins que les ${minimum} attendus`);
    }
  });

  it("ne classe pas un plat cuisiné en ingrédient brut", () => {
    // « Taboulé au poulet » rangé en « poulet » finissait saisi à la poêle.
    const bruts = new Set(["poulet", "boeuf", "porc", "poisson-blanc", "legume", "aromate"]);
    const prepares = /\b(taboul|salade de|soupe|velout|gaspacho|gazpacho|sandwich|pizza)/i;
    const fautifs = produits.filter((p) => bruts.has(p.category) && prepares.test(p.name));
    assert.deepEqual(fautifs.map((p) => `${p.name} → ${p.category}`), []);
  });

  it("ne range pas une boisson parmi les ingrédients", () => {
    // « Tomates pelées au jus » n'est pas une boisson : c'est le liquide de la
    // conserve. Seul un nom qui COMMENCE par la boisson en désigne une.
    const boissons = /^(jus|soda|limonade|citronnade|ginger ale|boisson|nectar|smoothie)\b/i;
    const fautifs = produits.filter(
      (p) => !["condiment", "traiteur", "lait"].includes(p.category) && boissons.test(p.name),
    );
    assert.deepEqual(fautifs.map((p) => `${p.name} → ${p.category}`), []);
  });

  it("tient dans un prompt même en entier", () => {
    const pool = filterCatalog(produits, { excludeOutOfStock: true });
    const echantillon = echantillonnerCatalogue(pool);
    assert.ok(
      echantillon.length < 900,
      `${echantillon.length} produits envoyés au modèle, c'est trop`,
    );
    // L'échantillon doit rester représentatif, pas se réduire aux pâtes.
    const familles = new Set(echantillon.map((p) => p.category));
    assert.ok(familles.size >= 25, `${familles.size} familles seulement dans l'échantillon`);
  });

  it("met le moins cher de chaque famille dans l'échantillon", () => {
    const pool = filterCatalog(produits, { excludeOutOfStock: true });
    const echantillon = new Set(echantillonnerCatalogue(pool).map((p) => p.id));
    for (const famille of ["pates", "riz", "legumineuse", "legume"]) {
      const dansLaFamille = pool
        .filter((p) => p.category === famille)
        .sort((a, b) => comparablePrice(a) - comparablePrice(b));
      assert.ok(
        echantillon.has(dansLaFamille[0]!.id),
        `le ${famille} le moins cher (${dansLaFamille[0]!.name}) manque à l'échantillon`,
      );
    }
  });
});
