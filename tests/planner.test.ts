import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { filterCatalog, seedCatalog, indexById } from "@/lib/catalog";
import { buildShoppingList } from "@/lib/planner/cost";
import { fitToBudget, suggestExtras } from "@/lib/planner/repair";
import { planOffline } from "@/lib/planner/offline";
import { balanceScore, summarize } from "@/lib/planner/scoring";
import { leftoverValue } from "@/lib/planner/cost";
import { validatePlan } from "@/lib/planner/validate";
import { importCsv, exportCsv } from "@/lib/catalog/sources";
import type { PlanRequest, Product, Recipe } from "@/lib/types";

const baseRequest: PlanRequest = {
  budget: 60,
  meals: 4,
  servingsPerMeal: 2,
  skill: 2,
  indulgence: 40,
  equipment: ["four", "plaques", "poele", "cocotte", "mixeur"],
  diet: [],
  exclusions: [],
  maxPrepMinutes: 90,
  pantry: [],
};

describe("filtrage du catalogue", () => {
  it("écarte tout produit incompatible avec un régime", () => {
    const vegan = filterCatalog(seedCatalog.products, { diet: ["vegan"] });
    assert.ok(vegan.length > 20, "il doit rester de quoi cuisiner");
    for (const product of vegan) {
      assert.ok(product.diet.includes("vegan"), `${product.name} n'est pas vegan`);
    }
  });

  it("écarte les produits nommés dans les exclusions", () => {
    const sansChampignon = filterCatalog(seedCatalog.products, { exclusions: ["champignon"] });
    assert.ok(
      !sansChampignon.some((p) => p.name.toLowerCase().includes("champignon")),
      "aucun champignon ne doit passer",
    );
  });

  it("écarte les produits en rupture quand on le demande", () => {
    const withRupture = seedCatalog.products.map((p, i) =>
      i === 0 ? { ...p, stock: "rupture" as const } : p,
    );
    const filtered = filterCatalog(withRupture, { excludeOutOfStock: true });
    assert.equal(filtered.length, withRupture.length - 1);
  });
});

describe("réparation budgétaire", () => {
  const pool = filterCatalog(seedCatalog.products, {});
  const productsById = indexById(seedCatalog);

  const cher: Recipe = {
    id: "cher", title: "Entrecôte et comté", description: "",
    servings: 2, prepMinutes: 10, cookMinutes: 10, skill: 2, equipment: ["poele"],
    ingredients: [
      { productId: "bo-entrecote", quantity: 300, label: "300 g d'entrecôte" },
      { productId: "cr-comte", quantity: 200, label: "200 g de comté" },
    ],
    steps: ["Saisir."], tips: [], diet: [], indulgence: 80,
  };

  it("ramène un plan dans son budget par substitution", () => {
    const before = buildShoppingList([cher], productsById);
    assert.ok(before.total > 10, "le plan de départ doit bien dépasser");

    const result = fitToBudget({
      recipes: [cher], productsById, pool, budget: 8, diet: [],
    });

    assert.ok(result.shoppingList.total < before.total, "le coût doit baisser");
    assert.ok(result.repairs.length > 0, "les modifications doivent être journalisées");
  });

  it("ne touche à rien quand le budget est déjà respecté", () => {
    const result = fitToBudget({
      recipes: [cher], productsById, pool, budget: 500, diet: [],
    });
    assert.equal(result.repairs.length, 0);
    assert.ok(result.withinBudget);
  });

  it("signale honnêtement un budget intenable au lieu de le masquer", () => {
    const result = fitToBudget({
      recipes: [cher], productsById, pool, budget: 0.5, diet: [],
    });
    assert.equal(result.withinBudget, false, "le dépassement doit être annoncé");
  });

  it("ne substitue jamais vers un produit qui casse le régime", () => {
    const result = fitToBudget({
      recipes: [cher], productsById,
      pool: filterCatalog(seedCatalog.products, { diet: ["sans_porc"] }),
      budget: 5, diet: ["sans_porc"],
    });
    for (const line of result.shoppingList.lines) {
      assert.ok(line.product.diet.includes("sans_porc"), `${line.product.name} contient du porc`);
    }
  });

  it("propose des compléments quand il reste du budget", () => {
    const extras = suggestExtras(10, pool, new Set());
    assert.ok(extras.length > 0);
    for (const product of extras) assert.ok(product.price <= 10);
  });
});

describe("planificateur hors-ligne", () => {
  it("produit le nombre de repas demandé", () => {
    const pool = filterCatalog(seedCatalog.products, {});
    const recipes = planOffline(baseRequest, pool);
    assert.equal(recipes.length, baseRequest.meals);
    for (const recipe of recipes) {
      assert.ok(recipe.ingredients.length >= 2, `${recipe.title} : trop peu d'ingrédients`);
      assert.ok(recipe.steps.length >= 4, `${recipe.title} : pas assez d'étapes`);
      assert.equal(recipe.servings, baseRequest.servingsPerMeal);
    }
  });

  it("n'utilise que l'équipement déclaré", () => {
    const pool = filterCatalog(seedCatalog.products, {});
    const recipes = planOffline({ ...baseRequest, equipment: ["poele", "plaques"] }, pool);
    for (const recipe of recipes) {
      for (const item of recipe.equipment) {
        assert.ok(["poele", "plaques"].includes(item), `${recipe.title} exige ${item}`);
      }
    }
  });

  it("respecte un régime vegan de bout en bout", () => {
    const pool = filterCatalog(seedCatalog.products, { diet: ["vegan"] });
    const recipes = planOffline({ ...baseRequest, diet: ["vegan"] }, pool);
    const byId = indexById(seedCatalog);
    for (const recipe of recipes) {
      for (const ingredient of recipe.ingredients) {
        const product = byId.get(ingredient.productId)!;
        assert.ok(product.diet.includes("vegan"), `${product.name} n'est pas vegan`);
      }
    }
  });

  it("choisit le conditionnement adapté au besoin, pas le moins cher au kilo", () => {
    const pool = filterCatalog(seedCatalog.products, {});
    const recipes = planOffline(baseRequest, pool);
    const byId = indexById(seedCatalog);

    // Un poulet entier de 1,4 kg est moins cher au kilo que 400 g
    // d'aiguillettes, mais coûte 2,50 € de plus quand on n'a besoin que
    // de 360 g. Le planificateur ne doit pas tomber dans ce piège.
    for (const recipe of recipes) {
      for (const ingredient of recipe.ingredients) {
        const product = byId.get(ingredient.productId)!;
        // Les produits de garde (huile, épices, riz) se stockent : acheter un
        // litre pour 25 ml n'est pas une erreur de conditionnement.
        if (product.unit === "piece" || product.shelfLifeDays > 60) continue;
        const packs = Math.ceil(ingredient.quantity / product.packSize);
        const bought = packs * product.packSize;
        assert.ok(
          ingredient.quantity / bought > 0.15,
          `${recipe.title} : ${product.name} acheté à ${bought} pour ${ingredient.quantity} utilisés`,
        );
      }
    }
  });

  it("garde le gâchis périssable sous le quart du panier", () => {
    const pool = filterCatalog(seedCatalog.products, {});
    const productsById = indexById(seedCatalog);
    const recipes = planOffline(baseRequest, pool);
    const list = buildShoppingList(recipes, productsById);
    const waste = leftoverValue(list) / list.total;
    assert.ok(waste < 0.25, `${Math.round(waste * 100)} % du panier part au rebut`);
  });

  it("tient dans un budget serré après réparation", () => {
    const pool = filterCatalog(seedCatalog.products, {});
    const productsById = indexById(seedCatalog);
    const recipes = planOffline({ ...baseRequest, budget: 35 }, pool);
    const result = fitToBudget({ recipes, productsById, pool, budget: 35, diet: [] });
    assert.ok(
      result.shoppingList.total <= 35 * 1.2,
      `total ${result.shoppingList.total} trop loin de 35 €`,
    );
  });
});

describe("validation de la réponse du modèle", () => {
  const pool = filterCatalog(seedCatalog.products, {});

  it("rejette un identifiant inventé sans casser la recette", () => {
    const result = validatePlan(
      {
        recipes: [{
          title: "Test", description: "", servings: 2, prepMinutes: 10, cookMinutes: 10,
          skill: 1, equipment: ["poele"], indulgence: 50,
          ingredients: [
            { productId: "es-penne", quantity: 200, label: "200 g de penne" },
            { productId: "produit-invente-42", quantity: 100, label: "100 g de rien" },
            { productId: "fl-tomate", quantity: 300, label: "300 g de tomates" },
          ],
          steps: ["Cuire les pâtes."],
        }],
      },
      pool,
      { ...baseRequest, meals: 1 },
    );

    assert.equal(result.recipes.length, 1);
    assert.equal(result.recipes[0].ingredients.length, 2, "l'ingrédient inventé doit disparaître");
    assert.ok(result.warnings.some((w) => w.includes("introuvable")));
  });

  it("écarte entièrement une recette qui viole une exclusion", () => {
    const result = validatePlan(
      {
        recipes: [{
          title: "Poulet", description: "", servings: 2, prepMinutes: 10, cookMinutes: 10,
          skill: 1, equipment: ["poele"], indulgence: 50,
          ingredients: [
            { productId: "vo-filet-poulet", quantity: 300, label: "300 g de poulet" },
            { productId: "es-penne", quantity: 200, label: "200 g de penne" },
          ],
          steps: ["Cuire."],
        }],
      },
      pool,
      { ...baseRequest, meals: 1, exclusions: ["poulet"] },
    );

    assert.equal(result.recipes.length, 0, "une exclusion ne se répare pas, elle disqualifie");
  });

  it("borne les quantités aberrantes", () => {
    const result = validatePlan(
      {
        recipes: [{
          title: "Test", description: "", servings: 2, prepMinutes: 10, cookMinutes: 10,
          skill: 1, equipment: ["poele"], indulgence: 50,
          ingredients: [
            { productId: "es-penne", quantity: 999999, label: "beaucoup" },
            { productId: "fl-tomate", quantity: 300, label: "300 g" },
          ],
          steps: ["Cuire."],
        }],
      },
      pool,
      { ...baseRequest, meals: 1 },
    );
    assert.ok(result.recipes[0].ingredients[0].quantity <= 4000);
  });

  it("fusionne un produit cité deux fois", () => {
    const result = validatePlan(
      {
        recipes: [{
          title: "Test", description: "", servings: 2, prepMinutes: 10, cookMinutes: 10,
          skill: 1, equipment: ["poele"], indulgence: 50,
          ingredients: [
            { productId: "es-penne", quantity: 200, label: "200 g" },
            { productId: "es-penne", quantity: 100, label: "100 g de plus" },
            { productId: "fl-tomate", quantity: 300, label: "300 g" },
          ],
          steps: ["Cuire."],
        }],
      },
      pool,
      { ...baseRequest, meals: 1 },
    );
    assert.equal(result.recipes[0].ingredients.length, 2);
    assert.equal(result.recipes[0].ingredients[0].quantity, 300);
  });

  it("signale une recette qui dépasse le temps imparti", () => {
    const result = validatePlan(
      {
        recipes: [{
          title: "Longue", description: "", servings: 2, prepMinutes: 60, cookMinutes: 120,
          skill: 1, equipment: ["four"], indulgence: 50,
          ingredients: [
            { productId: "es-penne", quantity: 200, label: "200 g" },
            { productId: "fl-tomate", quantity: 300, label: "300 g" },
          ],
          steps: ["Attendre."],
        }],
      },
      pool,
      { ...baseRequest, meals: 1, maxPrepMinutes: 30 },
    );
    assert.ok(result.warnings.some((w) => w.includes("dépassent")));
  });
});

describe("score nutritionnel", () => {
  it("note haut un repas conforme aux repères", () => {
    const score = balanceScore(
      { kcalPerServing: 700, proteinPerServing: 35, carbsPerServing: 84,
        fatPerServing: 25, fiberPerServing: 10, saltPerServing: 2 },
      0,
    );
    assert.ok(score >= 75, `score ${score} trop bas pour un repas équilibré`);
  });

  it("sanctionne un repas très gras quand on demande l'équilibre", () => {
    const score = balanceScore(
      { kcalPerServing: 1400, proteinPerServing: 25, carbsPerServing: 90,
        fatPerServing: 90, fiberPerServing: 3, saltPerServing: 6 },
      0,
    );
    assert.ok(score < 45, `score ${score} trop élevé pour un repas déséquilibré`);
  });

  it("cesse de sanctionner ce que l'utilisateur a explicitement demandé", () => {
    const gourmand = { kcalPerServing: 1050, proteinPerServing: 35, carbsPerServing: 100,
                       fatPerServing: 55, fiberPerServing: 6, saltPerServing: 3 };
    assert.ok(
      balanceScore(gourmand, 100) > balanceScore(gourmand, 0),
      "le curseur plaisir doit déplacer les repères, pas les ignorer",
    );
  });

  it("calcule un bilan cohérent sur un plan réel", () => {
    const pool = filterCatalog(seedCatalog.products, {});
    const recipes = planOffline(baseRequest, pool);
    const summary = summarize(recipes, indexById(seedCatalog), baseRequest.indulgence);
    assert.ok(summary.kcalPerServing > 150, "un repas doit apporter des calories");
    assert.ok(summary.proteinPerServing > 5);
    assert.ok(summary.balanceScore >= 0 && summary.balanceScore <= 100);
  });
});

describe("import CSV", () => {
  it("recale le prix d'un produit connu sans en créer un nouveau", () => {
    const result = importCsv("id;nom;prix\nes-penne;Penne;2.50");
    assert.equal(result.updated, 1);
    assert.equal(result.added, 0);
    const penne = result.catalog.products.find((p) => p.id === "es-penne")!;
    assert.equal(penne.price, 2.5);
    assert.ok(penne.nutrition, "la fiche nutritionnelle doit être conservée");
  });

  it("reconnaît un produit par son nom quand l'id manque", () => {
    const result = importCsv("nom;prix\nPenne;1.90");
    assert.equal(result.updated, 1);
  });

  it("ajoute un produit inconnu", () => {
    const result = importCsv("nom;prix;rayon;unite;contenance\nYaourt de brebis;3.20;Crémerie;g;500");
    assert.equal(result.added, 1);
    const added = result.catalog.products.find((p) => p.name === "Yaourt de brebis")!;
    assert.equal(added.rayon, "Crémerie");
    assert.equal(added.packSize, 500);
  });

  it("accepte la virgule décimale et le symbole euro", () => {
    const result = importCsv("id;nom;prix\nes-penne;Penne;1,45 €");
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.price, 1.45);
  });

  it("rejette une ligne illisible en disant pourquoi", () => {
    const result = importCsv("id;nom;prix\nes-penne;Penne;abc");
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("Prix"));
  });

  it("refuse un fichier sans les colonnes obligatoires", () => {
    const result = importCsv("colonne;autre\nvaleur;valeur");
    assert.ok(result.rejected[0].reason.includes("En-tête"));
  });

  it("détecte la virgule comme séparateur", () => {
    const result = importCsv("id,nom,prix\nes-penne,Penne,3.00");
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.price, 3);
  });

  it("marque une rupture de stock", () => {
    const result = importCsv("id;nom;prix;stock\nes-penne;Penne;1.15;rupture");
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.stock, "rupture");
  });

  it("fait un aller-retour export → import sans perte de prix", () => {
    const csv = exportCsv(seedCatalog);
    const back = importCsv(csv);
    assert.equal(back.added, 0, "aucun produit ne doit être dupliqué");
    for (const original of seedCatalog.products) {
      const roundTrip = back.catalog.products.find((p) => p.id === original.id)!;
      assert.equal(roundTrip.price, original.price, `${original.id} : prix altéré`);
    }
  });
});
