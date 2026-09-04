import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  buildShoppingList, costPerRecipe, leftoverValue, pantryStockValue,
} from "@/lib/planner/cost";
import { indexById, seedCatalog, unitPrice } from "@/lib/catalog";
import type { Product, Recipe } from "@/lib/types";

const products = new Map<string, Product>([
  ["pates", {
    id: "pates", name: "Penne", rayon: "Épicerie salée", category: "pates",
    brandTier: "mdd", unit: "g", packSize: 500, price: 1.15,
    priceFrom: { source: "estimation", at: "2026-01-01" },
    diet: [],
    shelfLifeDays: 400, stock: "en_rayon",
  }],
  ["poulet", {
    id: "poulet", name: "Filets de poulet", rayon: "Volaille", category: "poulet",
    brandTier: "mdd", unit: "g", packSize: 1000, price: 8.99,
    priceFrom: { source: "estimation", at: "2026-01-01" },
    diet: [],
    shelfLifeDays: 3, stock: "en_rayon",
  }],
]);

function recipe(id: string, ingredients: Recipe["ingredients"]): Recipe {
  return {
    id, title: id, description: "", servings: 2, prepMinutes: 10, cookMinutes: 10,
    skill: 1, equipment: [], ingredients, steps: ["Cuire."], tips: [], diet: [],
    indulgence: 50,
  };
}

describe("chiffrage au conditionnement", () => {
  it("arrondit au paquet supérieur plutôt qu'au gramme", () => {
    const list = buildShoppingList(
      [recipe("r1", [{ productId: "pates", quantity: 350, label: "350 g de penne" }])],
      products,
    );

    const line = list.lines[0];
    assert.equal(line.packs, 1, "350 g doivent coûter un paquet entier");
    assert.equal(line.cost, 1.15);
    assert.equal(line.leftoverQuantity, 150, "le surplus doit être visible");
    assert.equal(list.total, 1.15);
  });

  it("mutualise un produit utilisé par plusieurs recettes", () => {
    const list = buildShoppingList(
      [
        recipe("r1", [{ productId: "pates", quantity: 300, label: "300 g" }]),
        recipe("r2", [{ productId: "pates", quantity: 200, label: "200 g" }]),
      ],
      products,
    );

    assert.equal(list.lines.length, 1);
    assert.equal(list.lines[0].packs, 1, "500 g au total tiennent dans un paquet");
    assert.equal(list.lines[0].usedBy.length, 2);
    assert.equal(list.total, 1.15);
  });

  it("ouvre un second paquet dès le premier gramme au-delà", () => {
    const list = buildShoppingList(
      [recipe("r1", [{ productId: "pates", quantity: 501, label: "501 g" }])],
      products,
    );
    assert.equal(list.lines[0].packs, 2);
    assert.equal(list.lines[0].cost, 2.3);
  });

  it("déduit ce qui est déjà dans les placards", () => {
    const list = buildShoppingList(
      [recipe("r1", [{ productId: "pates", quantity: 400, label: "400 g" }])],
      products,
      { pantry: [{ productId: "pates", quantity: 400 }] },
    );
    assert.equal(list.total, 0);
    assert.equal(list.lines[0].fromPantry, 400);
  });

  it("ignore les ingrédients optionnels", () => {
    const list = buildShoppingList(
      [recipe("r1", [
        { productId: "pates", quantity: 200, label: "200 g" },
        { productId: "poulet", quantity: 300, label: "300 g", optional: true },
      ])],
      products,
    );
    assert.equal(list.lines.length, 1);
    assert.equal(list.total, 1.15);
  });

  it("répartit le coût entre recettes sans en perdre ni en créer", () => {
    const recipes = [
      recipe("r1", [{ productId: "pates", quantity: 300, label: "300 g" }]),
      recipe("r2", [{ productId: "pates", quantity: 200, label: "200 g" }]),
    ];
    const list = buildShoppingList(recipes, products);
    const perRecipe = costPerRecipe(recipes, list);
    const sum = [...perRecipe.values()].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - list.total) < 0.02, `${sum} doit égaler ${list.total}`);
  });

  it("ne compte comme gâchis que le surplus qui va s'abîmer", () => {
    // Les pâtes se gardent : leur surplus est de la provision.
    const pates = buildShoppingList(
      [recipe("r1", [{ productId: "pates", quantity: 250, label: "250 g" }])],
      products,
    );
    assert.equal(leftoverValue(pates), 0, "un paquet de pâtes entamé n'est pas jeté");
    assert.ok(Math.abs(pantryStockValue(pates) - 0.575) < 0.01);

    // Le poulet frais, lui, se perd : 700 g achetés pour 300 g utilisés.
    const poulet = buildShoppingList(
      [recipe("r2", [{ productId: "poulet", quantity: 300, label: "300 g" }])],
      products,
    );
    assert.ok(Math.abs(leftoverValue(poulet) - 6.29) < 0.02);
    assert.equal(pantryStockValue(poulet), 0);
  });

  it("trie les lignes dans l'ordre de parcours du magasin", () => {
    const list = buildShoppingList(
      [recipe("r1", [
        { productId: "pates", quantity: 200, label: "200 g" },
        { productId: "poulet", quantity: 300, label: "300 g" },
      ])],
      products,
    );
    assert.equal(list.byRayon[0].rayon, "Volaille");
    assert.equal(list.byRayon[1].rayon, "Épicerie salée");
  });
});

describe("catalogue embarqué", () => {
  it("ne contient pas d'identifiant en double", () => {
    const ids = new Set(seedCatalog.products.map((p) => p.id));
    assert.equal(ids.size, seedCatalog.products.length);
  });

  it("a des prix et des conditionnements exploitables", () => {
    for (const product of seedCatalog.products) {
      assert.ok(product.price > 0, `${product.id} : prix invalide`);
      assert.ok(product.packSize > 0, `${product.id} : contenance invalide`);
      assert.ok(unitPrice(product) > 0, `${product.id} : prix unitaire invalide`);
    }
  });

  it("garde la cohérence végétarien / vegan", () => {
    for (const product of seedCatalog.products) {
      if (product.diet.includes("vegan")) {
        assert.ok(product.diet.includes("vegetarien"), `${product.id} : vegan sans végétarien`);
      }
    }
  });

  it("est indexable sans perte", () => {
    assert.equal(indexById(seedCatalog).size, seedCatalog.products.length);
  });
});

describe("fond de placard facturé au prorata", () => {
  const staples = new Map<string, Product>([
    ["huile", {
      id: "huile", name: "Huile de tournesol", rayon: "Épicerie salée",
      category: "matiere-grasse", brandTier: "mdd", unit: "ml", packSize: 1000,
      price: 2.49,
    priceFrom: { source: "estimation", at: "2026-01-01" },
    diet: [], shelfLifeDays: 500, stock: "en_rayon",
    }],
    ["pates", {
      id: "pates", name: "Penne", rayon: "Épicerie salée", category: "pates",
      brandTier: "mdd", unit: "g", packSize: 500, price: 1.15,
    priceFrom: { source: "estimation", at: "2026-01-01" },
    diet: [],
      shelfLifeDays: 400, stock: "en_rayon",
    }],
  ]);

  const withOil = [recipe("r1", [
    { productId: "huile", quantity: 25, label: "25 ml d'huile" },
    { productId: "pates", quantity: 400, label: "400 g de penne" },
  ])];

  it("facture la bouteille entière quand on part de zéro", () => {
    const list = buildShoppingList(withOil, staples);
    const huile = list.lines.find((l) => l.product.id === "huile")!;
    assert.equal(huile.packs, 1);
    assert.equal(huile.cost, 2.49);
    assert.ok(!huile.prorated);
  });

  it("ne facture que la part consommée quand le placard est fourni", () => {
    const list = buildShoppingList(withOil, staples, { assumeStaples: true });
    const huile = list.lines.find((l) => l.product.id === "huile")!;
    assert.equal(huile.prorated, true);
    assert.ok(huile.cost < 0.1, `${huile.cost} € pour 25 ml sur une bouteille à 2,49 €`);
  });

  it("sort les lignes au prorata du parcours en rayon sans fausser le total", () => {
    const list = buildShoppingList(withOil, staples, { assumeStaples: true });
    const affichees = list.byRayon.flatMap((g) => g.lines);

    assert.ok(
      !affichees.some((l) => l.prorated),
      "un prorata ne s'attrape pas en rayon",
    );

    const sousTotaux = list.byRayon.reduce((sum, g) => sum + g.subtotal, 0);
    assert.ok(
      list.total > sousTotaux,
      "le budget doit rester supérieur à la somme affichée par rayon",
    );
    assert.ok(
      Math.abs(list.total - sousTotaux - 0.06) < 0.02,
      "l'écart doit valoir exactement la part d'huile consommée",
    );
  });
});
