import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { filterCatalog, seedCatalog, indexById } from "@/lib/catalog";
import { buildShoppingList } from "@/lib/planner/cost";
import { fitToBudget, suggestExtras } from "@/lib/planner/repair";
import { planOffline } from "@/lib/planner/offline";
import { generatePlan } from "@/lib/planner";
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

/**
 * Signalé : « les recettes n'ont aucun sens ».
 *
 * Trois causes distinctes, toutes reproductibles : des pois chiches secs
 * servis crus en salade, des étapes qui parlaient de viande alors que le
 * budget avait imposé une légumineuse, et un français cassé par l'absence
 * d'article — « Émincer ail », « arroser de huile de tournesol ».
 */
describe("des recettes qui tiennent debout", () => {
  const pool = filterCatalog(seedCatalog.products, {});
  const byId = indexById(seedCatalog);

  /** Le budget nul pousse le planificateur dans ses retranchements. */
  const auPlusSerre = (equipment: PlanRequest["equipment"]) =>
    planOffline({ ...baseRequest, budget: 0, meals: 8, equipment }, pool);

  const toutLEquipement: PlanRequest["equipment"] = [
    "four", "plaques", "poele", "micro_ondes", "cocotte", "mixeur",
  ];

  it("ne sert jamais un légume sec sans cuisson longue", () => {
    for (const equipment of [toutLEquipement, ["four", "plaques", "poele"] as const]) {
      for (const recipe of auPlusSerre(equipment as PlanRequest["equipment"])) {
        const secs = recipe.ingredients
          .map((i) => byId.get(i.productId))
          .filter((p) => p?.dryPulse);
        if (secs.length === 0) continue;
        assert.ok(
          recipe.cookMinutes >= 30,
          `${recipe.title} : ${secs[0]!.name} dans un plat qui cuit ${recipe.cookMinutes} min`,
        );
      }
    }
  });

  it("annonce le trempage quand il en faut un", () => {
    for (const recipe of auPlusSerre(toutLEquipement)) {
      const aTremper = recipe.ingredients
        .map((i) => byId.get(i.productId))
        .filter((p) => p?.needsSoaking);
      if (aTremper.length === 0) continue;
      assert.ok(
        recipe.steps.some((step) => step.toLowerCase().includes("tremper")),
        `${recipe.title} contient ${aTremper[0]!.name} sans étape de trempage`,
      );
    }
  });

  it("ne parle de viande que lorsqu'il y en a", () => {
    const animales = new Set([
      "boeuf", "porc", "agneau", "veau", "canard", "poulet", "dinde", "lapin",
      "poisson-blanc", "poisson-gras", "fruits-de-mer", "charcuterie",
      "poisson-surgele", "conserve-poisson", "viande-surgelee",
    ]);

    for (const equipment of [toutLEquipement, ["four", "plaques", "poele"] as const]) {
      for (const recipe of auPlusSerre(equipment as PlanRequest["equipment"])) {
        const carne = recipe.ingredients
          .map((i) => byId.get(i.productId))
          .some((p) => p && animales.has(p.category));
        if (carne) continue;
        for (const step of recipe.steps) {
          assert.ok(
            !/\bla viande\b/i.test(step),
            `${recipe.title} n'a pas de viande, et pourtant : « ${step} »`,
          );
        }
      }
    }
  });

  it("nomme un ingrédient avec sa quantité, jamais tout nu", () => {
    // « Émincer ail », « arroser de huile de tournesol » : le nom nu ne se
    // place pas en français sans connaître son genre. Reprendre la quantité
    // — « Émincer 40 g d'ail » — est l'usage en cuisine et reste correct quel
    // que soit le produit. C'est donc cela qu'on vérifie : dès qu'une étape
    // cite un ingrédient, elle le cite entier.
    for (const equipment of [toutLEquipement, ["four", "plaques", "poele"] as const]) {
      for (const recipe of auPlusSerre(equipment as PlanRequest["equipment"])) {
        for (const ingredient of recipe.ingredients) {
          const nom = byId.get(ingredient.productId)!.name.toLowerCase();
          // Sur les bords du mot, sinon « ail » se trouve dans « taille ».
          const cite = new RegExp(
            `(?<![a-zà-ÿ])${nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zà-ÿ])`,
            "i",
          );
          for (const step of recipe.steps) {
            if (!cite.test(step)) continue;
            assert.ok(
              step.includes(ingredient.label),
              `${recipe.title} : « ${step} » cite ${nom} sans sa quantité`
                + ` (attendu « ${ingredient.label} »)`,
            );
          }
        }
      }
    }
  });

  it("n'accorde pas un participe au hasard", () => {
    // « haricots blancs rincée », « mozzarella râpé » : ces accords étaient
    // écrits en dur dans les gabarits, donc faux dès que le produit changeait.
    const accords = /\brincée\b|\brâpé\b|\bhachée\b|\bgrillé\b|\bémincé\b/;

    for (const equipment of [toutLEquipement, ["four", "plaques", "poele"] as const]) {
      for (const recipe of auPlusSerre(equipment as PlanRequest["equipment"])) {
        for (const step of recipe.steps) {
          assert.ok(!accords.test(step), `accord deviné — « ${step} »`);
        }
      }
    }
  });
});

/**
 * Signalé : « quand je change ma demande, mauvaise actualisation ».
 *
 * Un gabarit impossible à remplir — sans gluten, il n'y a pas de pâtes —
 * faisait perdre le repas en silence : six repas demandés, cinq rendus.
 */
describe("le nombre de repas demandé est rendu", () => {
  for (const diet of [[], ["vegetarien"], ["vegan"], ["sans_gluten"], ["sans_lactose"]] as const) {
    const nom = diet.length === 0 ? "sans régime" : diet[0];
    it(`en rend six pour six — ${nom}`, () => {
      const request = { ...baseRequest, meals: 6, diet: [...diet] } as PlanRequest;
      const pool = filterCatalog(seedCatalog.products, { diet: request.diet });
      assert.equal(planOffline(request, pool).length, 6);
    });
  }

  it("en rend six pour six même sans budget", () => {
    const request = { ...baseRequest, meals: 6, budget: 0 } as PlanRequest;
    assert.equal(planOffline(request, filterCatalog(seedCatalog.products, {})).length, 6);
  });
});

/**
 * Signalé : « le site me propose toujours les mêmes trucs à acheter, j'ai
 * l'impression que la liste de produit est minuscule ».
 *
 * Elle ne l'était pas : le planificateur était déterministe et le produit le
 * moins cher de chaque catégorie gagnait toujours. Pire, la pénalité de
 * répétition était un facteur multiplicatif appliqué à un coût marginal nul
 * dès qu'un paquet était ouvert — donc sans effet.
 */
describe("la liste ne se répète pas d'une génération à l'autre", () => {
  const pool = filterCatalog(seedCatalog.products, {});
  const request: PlanRequest = { ...baseRequest, budget: 48, meals: 6 };

  const produits = (seed: number) =>
    new Set(planOffline(request, pool, seed).flatMap((r) => r.ingredients.map((i) => i.productId)));

  it("rend le même plan à graine égale", () => {
    assert.deepEqual(planOffline(request, pool, 7), planOffline(request, pool, 7));
  });

  it("rend un plan différent à graine différente", () => {
    const differences = [1, 2, 3, 4, 5].filter((seed) => {
      const a = [...produits(seed)].sort().join();
      return a !== [...produits(0)].sort().join();
    });
    assert.ok(
      differences.length >= 3,
      `seules ${differences.length} graines sur cinq changent quelque chose`,
    );
  });

  it("puise largement dans le catalogue sur une dizaine de générations", () => {
    const cumul = new Set<string>();
    for (let seed = 0; seed < 10; seed++) for (const id of produits(seed)) cumul.add(id);
    // Une seule génération en propose une quinzaine ; dix générations qui
    // resservent la même liste en donneraient tout autant.
    assert.ok(cumul.size >= 35, `${cumul.size} produits distincts sur dix générations`);
  });

  it("garde le budget malgré la variation", () => {
    const byId = indexById(seedCatalog);
    for (let seed = 0; seed < 10; seed++) {
      const total = buildShoppingList(
        planOffline(request, pool, seed), byId, { assumeStaples: true },
      ).total;
      assert.ok(
        total < request.budget * 1.15,
        `graine ${seed} : ${total.toFixed(2)} € pour un budget de ${request.budget} €`,
      );
    }
  });
});

describe("le plat de fête n'est pas servi à n'importe quel prix", () => {
  const pool = filterCatalog(seedCatalog.products, {});

  it("disparaît quand le budget ne peut pas le porter", () => {
    // « Façon plaisir, sauce crémeuse » réclame viande, crème, beurre et
    // fromage : près de sept euros pour deux. Le servir à un euro la portion
    // mangeait un cinquième du panier.
    const serre = planOffline({ ...baseRequest, budget: 10, meals: 5 }, pool);
    assert.ok(
      serre.every((r) => r.indulgence <= 60),
      `plat trop riche au menu : ${serre.find((r) => r.indulgence > 60)?.title}`,
    );
  });

  it("reste disponible quand le budget le permet", () => {
    const large = planOffline({ ...baseRequest, budget: 200, meals: 5, indulgence: 85 }, pool);
    assert.ok(large.some((r) => r.indulgence > 60), "aucun plat généreux à budget large");
  });
});

describe("élision devant une voyelle", () => {
  it("écrit « d'œufs », pas « de œufs »", () => {
    const pool = filterCatalog(seedCatalog.products, {});
    for (let seed = 0; seed < 20; seed++) {
      for (const recipe of planOffline({ ...baseRequest, meals: 6 }, pool, seed)) {
        assert.ok(
          !/\bde [aeiouyœæéèêà]/i.test(recipe.title),
          `élision manquée : « ${recipe.title} »`,
        );
      }
    }
  });
});

/**
 * Signalé sur un plan réel : « 30 × Concombre — 35,70 € » pour une seule
 * recette, soit la moitié du panier, et des recettes dont le titre annonçait
 * un poisson que la liste ne contenait plus.
 */
describe("la réparation ne fabrique pas d'absurdités", () => {
  const pool = filterCatalog(seedCatalog.products, {});
  const byId = indexById(seedCatalog);

  const brut = (productId: string, quantity: number) => ({
    recipes: [{
      title: "Wrap au thon et crudités",
      description: "x", servings: 1, prepMinutes: 10, cookMinutes: 0,
      skill: 1, equipment: [], indulgence: 30,
      steps: ["Garnir le pain."], tips: [],
      ingredients: [
        { productId, quantity, label: "x" },
        { productId: "es-thon", quantity: 80, label: "80 g de thon" },
        { productId: "bl-pita", quantity: 1, label: "1 pain pita" },
      ],
    }],
  });

  it("lit des grammes quand le nombre est impossible en pièces", () => {
    // « 150 g de salade » arrivait dans un champ qui compte des pièces, et le
    // plafond le ramenait à 30 — un nombre de salades parfaitement recevable.
    const request = { ...baseRequest, servingsPerMeal: 1 } as PlanRequest;
    const v = validatePlan(brut("fl-salade", 150) as never, pool, request);
    const salade = v.recipes[0]!.ingredients.find((i) => i.productId === "fl-salade");
    assert.equal(salade?.quantity, 1, "150 g de salade font une salade, pas trente");
  });

  it("laisse passer un nombre de pièces plausible", () => {
    const request = { ...baseRequest, servingsPerMeal: 4 } as PlanRequest;
    const v = validatePlan(brut("cr-oeuf", 8) as never, pool, request);
    assert.equal(v.recipes[0]!.ingredients.find((i) => i.productId === "cr-oeuf")?.quantity, 8);
  });

  it("borne les grammes à la portion, pas à la recette", () => {
    const request = { ...baseRequest, servingsPerMeal: 1 } as PlanRequest;
    const v = validatePlan(brut("fl-carotte", 4000) as never, pool, request);
    const carotte = v.recipes[0]!.ingredients.find((i) => i.productId === "fl-carotte");
    assert.ok((carotte?.quantity ?? 0) <= 900, `${carotte?.quantity} g de carottes pour une portion`);
  });

  it("convertit l'unité quand le substitut ne se vend pas comme l'original", () => {
    // Carottes au poids remplacées par un concombre à la pièce : sans
    // conversion, 300 g devenaient 300 concombres.
    const recipe = {
      id: "r1", title: "Salade", description: "", servings: 2,
      prepMinutes: 5, cookMinutes: 0, skill: 1 as const, equipment: [],
      ingredients: [{ productId: "fl-carotte", quantity: 300, label: "300 g de carottes" }],
      steps: [], tips: [], diet: [], indulgence: 20,
    };
    const carotte = byId.get("fl-carotte")!;
    const concombre = byId.get("fl-concombre")!;
    const swapped = fitToBudget({
      recipes: [recipe], productsById: byId, pool: [carotte, concombre],
      budget: 0.01, diet: [], costOptions: {},
    });
    const ligne = swapped.recipes[0]!.ingredients[0]!;
    const produit = byId.get(ligne.productId)!;
    if (produit.unit === "piece") {
      assert.ok(ligne.quantity <= 3, `${ligne.quantity} concombres pour 300 g de carottes`);
    }
  });

  it("remet le titre et les étapes d'accord avec ce qu'on achète", () => {
    const recipe = {
      id: "r1", title: "Filet de lieu poêlé et haricots verts",
      description: "", servings: 2, prepMinutes: 5, cookMinutes: 10,
      skill: 1 as const, equipment: [],
      ingredients: [{ productId: "po-lieu", quantity: 200, label: "200 g de filets de lieu noir" }],
      steps: ["Poêler le filet de lieu noir 4 minutes par face."],
      tips: [], diet: [], indulgence: 30,
    };
    const lieu = byId.get("po-lieu")!;
    const substitut = pool.find((p) => p.category === lieu.category && p.id !== lieu.id)!;

    const r = fitToBudget({
      recipes: [recipe], productsById: byId, pool: [lieu, substitut],
      budget: 0.01, diet: [], costOptions: {},
    });

    const retenu = byId.get(r.recipes[0]!.ingredients[0]!.productId)!;
    if (retenu.id === lieu.id) return; // pas de substitution possible : rien à vérifier

    const texte = `${r.recipes[0]!.title} ${r.recipes[0]!.steps.join(" ")}`.toLowerCase();
    assert.ok(
      !texte.includes("lieu noir"),
      `« ${r.recipes[0]!.title} » parle encore d'un poisson qui n'est plus dans la liste`,
    );
  });
});

describe("n'utiliser que des prix relevés", () => {
  const releve = { source: "collecte" as const, at: "2026-09-01", store: "Auchan Corte" };

  it("écarte les produits dont le prix n'est qu'une estimation", () => {
    const products = seedCatalog.products.map((p, i) =>
      i % 10 === 0 ? { ...p, priceFrom: releve } : p,
    );
    const filtre = filterCatalog(products, { verifiedPriceOnly: true });
    assert.equal(filtre.length, products.filter((p) => p.priceFrom.source === "collecte").length);
    assert.ok(filtre.every((p) => p.priceFrom.source !== "estimation"));
  });

  it("ne change rien quand l'option est absente", () => {
    assert.equal(filterCatalog(seedCatalog.products, {}).length, seedCatalog.products.length);
  });

  it("explique le vrai blocage plutôt que d'accuser les régimes", async () => {
    // Sur le catalogue embarqué, tous les prix sont estimés : exiger des
    // relevés vide le panier. Le message doit nommer la bonne cause.
    await assert.rejects(
      () => generatePlan({
        request: { ...baseRequest, verifiedOnly: true },
        catalog: seedCatalog,
        assumeStaples: true,
      }),
      /prix relevé/,
    );
  });
});

describe("un plan enregistré par une version antérieure", () => {
  it("est marqué comme périmé quand la version a changé", async () => {
    const { KEYS, PLAN_VERSION, loadPlan, savePlan } = await import("@/lib/storage");

    // Faux localStorage : le module lit `window.localStorage`.
    const boite = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => boite.get(k) ?? null,
        setItem: (k: string, v: string) => void boite.set(k, v),
        removeItem: (k: string) => void boite.delete(k),
      },
    };

    try {
      const plan = { recipes: [], shoppingList: { lines: [], total: 0 } } as never;
      savePlan(plan);
      assert.equal(loadPlan()?.current, true, "un plan tout juste écrit est à jour");

      boite.set(KEYS.planVersion, JSON.stringify(PLAN_VERSION - 1));
      assert.equal(loadPlan()?.current, false, "une version antérieure doit être signalée");

      boite.delete(KEYS.planVersion);
      assert.equal(loadPlan()?.current, false, "un plan sans version est antérieur au marquage");

      boite.delete(KEYS.plan);
      assert.equal(loadPlan(), null);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
