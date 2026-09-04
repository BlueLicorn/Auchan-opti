import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { filterCatalog, indexById, seedCatalog } from "@/lib/catalog";
import { decouperEnLots, generatePlan } from "@/lib/planner";
import { buildShoppingList } from "@/lib/planner/cost";
import { budgetPressure, planOffline } from "@/lib/planner/offline";
import type { PlanRequest } from "@/lib/types";

/**
 * Le budget est une contrainte, pas une indication.
 *
 * Ces tests existent parce que l'application rendait 4 € la portion quand on
 * lui en demandait 1 : le planificateur hors-ligne ne lisait tout simplement
 * pas le budget, et rien ne le vérifiait de bout en bout.
 */

function request(budget: number, meals: number, servingsPerMeal: number): PlanRequest {
  return {
    budget,
    meals,
    servingsPerMeal,
    skill: 2,
    indulgence: 35,
    equipment: ["four", "plaques", "poele", "micro_ondes"],
    diet: [],
    exclusions: [],
    maxPrepMinutes: 60,
    pantry: [],
  };
}

const plan = (req: PlanRequest) =>
  generatePlan({ request: req, catalog: seedCatalog, assumeStaples: true });

const perServing = (total: number, req: PlanRequest) =>
  total / (req.meals * req.servingsPerMeal);

describe("tension budgétaire", () => {
  it("est nulle quand le budget est confortable", () => {
    assert.equal(budgetPressure(request(120, 5, 2)), 0);
  });

  it("est maximale quand le budget est très serré", () => {
    assert.equal(budgetPressure(request(5, 5, 2)), 1);
  });

  it("croît quand le budget baisse", () => {
    const large = budgetPressure(request(40, 5, 2));
    const moyen = budgetPressure(request(20, 5, 2));
    const serre = budgetPressure(request(10, 5, 2));
    assert.ok(large < moyen && moyen < serre, `${large} < ${moyen} < ${serre}`);
  });
});

describe("le budget pilote réellement le plan", () => {
  const pool = filterCatalog(seedCatalog.products, {});
  const productsById = indexById(seedCatalog);

  const cost = (req: PlanRequest) =>
    buildShoppingList(planOffline(req, pool), productsById, { assumeStaples: true }).total;

  it("produit un panier moins cher quand on demande moins", () => {
    const large = cost(request(120, 5, 2));
    const serre = cost(request(10, 5, 2));
    // Le seuil n'est pas plus bas parce que dix portions se heurtent au
    // conditionnement : on achète un sac de pommes de terre, pas 500 g. Il a
    // d'ailleurs dû remonter de 0,75 le jour où les légumes secs ont cessé
    // d'être servis crus — un pois chiche sec était un raccourci bon marché,
    // mais immangeable.
    assert.ok(
      serre < large * 0.8,
      `un budget douze fois plus petit doit peser bien moins : ${serre} vs ${large}`,
    );
  });

  it("réduit la protéine animale plutôt que de la garder à tout prix", () => {
    const animales = new Set([
      "boeuf", "porc", "agneau", "veau", "canard", "poulet", "dinde",
      "poisson-blanc", "poisson-gras", "fruits-de-mer", "charcuterie",
      "poisson-surgele", "conserve-poisson",
    ]);

    const partViande = (req: PlanRequest) => {
      const list = buildShoppingList(planOffline(req, pool), productsById, { assumeStaples: true });
      const viande = list.lines
        .filter((l) => animales.has(l.product.category))
        .reduce((sum, l) => sum + l.cost, 0);
      return viande / Math.max(0.01, list.total);
    };

    assert.ok(
      partViande(request(10, 5, 2)) < partViande(request(120, 5, 2)),
      "à budget serré, la viande doit reculer",
    );
  });

  it("amortit les conditionnements au lieu de rouvrir un paquet par recette", () => {
    // Un même produit réutilisé ne doit être facturé qu'une fois s'il tient
    // dans le paquet déjà acheté.
    const recipes = planOffline(request(10, 5, 2), pool);
    const list = buildShoppingList(recipes, productsById, { assumeStaples: true });
    const partages = list.lines.filter((l) => l.usedBy.length > 1);
    assert.ok(partages.length > 0, "aucun produit n'est partagé entre recettes");
  });
});

describe("respect du budget de bout en bout", () => {
  it("tient un budget confortable", async () => {
    const req = request(80, 5, 2);
    const result = await plan(req);
    assert.ok(
      result.shoppingList.total <= req.budget,
      `${result.shoppingList.total} € pour un budget de ${req.budget} €`,
    );
    assert.ok(
      !result.warnings.some((w) => w.includes("Budget non tenu")),
      "aucun avertissement de dépassement ne doit apparaître",
    );
  });

  it("tient un budget moyen", async () => {
    const req = request(45, 5, 2);
    const result = await plan(req);
    assert.ok(result.shoppingList.total <= req.budget, `${result.shoppingList.total} €`);
  });

  it("approche de près un budget serré pour une famille", async () => {
    const req = request(20, 5, 4);
    const result = await plan(req);
    assert.ok(
      perServing(result.shoppingList.total, req) < 1.2,
      `${perServing(result.shoppingList.total, req).toFixed(2)} € par portion`,
    );
  });

  it("ne dépasse jamais du quadruple, même au budget le plus serré", async () => {
    // Le défaut d'origine : 1 € demandé, 4 € servis, sans un mot.
    for (const req of [request(10, 5, 2), request(5, 5, 1), request(6, 3, 2)]) {
      const result = await plan(req);
      const obtenu = perServing(result.shoppingList.total, req);
      const demande = perServing(req.budget, req);
      assert.ok(
        obtenu < demande * 2.5,
        `${obtenu.toFixed(2)} € servis pour ${demande.toFixed(2)} € demandés`,
      );
    }
  });
});

describe("honnêteté quand le budget est intenable", () => {
  it("annonce le dépassement, sa cause et le minimum atteignable", async () => {
    const req = request(5, 5, 1);
    const result = await plan(req);

    assert.ok(
      result.warnings.some((w) => w.includes("Budget non tenu")),
      "le dépassement doit être annoncé",
    );
    assert.ok(
      result.warnings.some((w) => w.includes("conditionnement domine")),
      "la cause dominante doit être nommée",
    );
    assert.ok(
      result.warnings.some((w) => w.includes("minimum atteignable")),
      "le minimum réel doit être chiffré",
    );
  });

  it("n'annonce jamais un minimum supérieur à ce qui vient d'être servi", async () => {
    for (const req of [request(5, 5, 1), request(10, 5, 2), request(20, 5, 4)]) {
      const result = await plan(req);
      const message = result.warnings.find((w) => w.includes("minimum atteignable"));
      if (!message) continue;

      // Le message est en français : « environ 1,23 € ».
      const annonce = Number(
        message.match(/environ ([\d\s,]+)\s?€/)?.[1].replace(/\s/g, "").replace(",", "."),
      );
      const servi = perServing(result.shoppingList.total, req);
      assert.ok(
        annonce <= servi + 0.01,
        `minimum annoncé ${annonce} € alors que le plan servi coûte ${servi.toFixed(2)} €`,
      );
    }
  });

  it("se tait quand le budget est tenu", async () => {
    const result = await plan(request(80, 5, 2));
    assert.ok(!result.warnings.some((w) => w.includes("minimum atteignable")));
  });
});

describe("découpage des grandes demandes en lots", () => {
  it("n'en fait qu'un seul tant que la demande tient", () => {
    assert.deepEqual(decouperEnLots(1, 6), [1]);
    assert.deepEqual(decouperEnLots(6, 6), [6]);
  });

  it("répartit équitablement au-delà", () => {
    assert.deepEqual(decouperEnLots(7, 6), [4, 3]);
    assert.deepEqual(decouperEnLots(12, 6), [6, 6]);
    assert.deepEqual(decouperEnLots(30, 6), [6, 6, 6, 6, 6]);
  });

  it("ne laisse jamais un lot d'un seul repas isolé", () => {
    // Un découpage naïf de 13 en lots de 6 donnerait [6, 6, 1] : le dernier
    // appel coûterait autant pour une seule recette, et sans contexte.
    for (const total of [7, 8, 13, 19, 25, 31, 43, 60]) {
      const lots = decouperEnLots(total, 6);
      assert.equal(lots.reduce((a, b) => a + b, 0), total, `somme fausse pour ${total}`);
      assert.ok(Math.min(...lots) >= 2, `lot isolé pour ${total} : ${lots.join("+")}`);
      assert.ok(Math.max(...lots) <= 6, `lot trop gros pour ${total} : ${lots.join("+")}`);
    }
  });

  it("garde des lots d'écart minimal", () => {
    for (const total of [7, 11, 17, 23, 29, 41]) {
      const lots = decouperEnLots(total, 6);
      assert.ok(
        Math.max(...lots) - Math.min(...lots) <= 1,
        `lots déséquilibrés pour ${total} : ${lots.join("+")}`,
      );
    }
  });
});

describe("beaucoup de repas", () => {
  it("compose un plan bien au-delà de l'ancien plafond de quatorze", async () => {
    const req = request(300, 40, 2);
    const result = await plan(req);
    assert.equal(result.recipes.length, 40, "les quarante repas doivent être là");
    assert.ok(result.shoppingList.lines.length > 0);
  });

  it("amortit les conditionnements quand le budget serre", async () => {
    // Un paquet de riz se partage entre quarante repas comme entre cinq, mais
    // il ne se paie qu'une fois : à budget par portion identique et serré, le
    // grand plan doit descendre plus bas que le petit.
    const petit = await plan(request(10, 5, 2));
    const grand = await plan(request(80, 40, 2));

    const parPortion = (r: Awaited<ReturnType<typeof plan>>, n: number) =>
      r.shoppingList.total / n;

    assert.ok(
      parPortion(grand, 80) < parPortion(petit, 10),
      `${parPortion(grand, 80).toFixed(2)} € devrait être sous ${parPortion(petit, 10).toFixed(2)} €`,
    );
  });

  it("n'ouvre pas un produit de plus à chaque repas ajouté", async () => {
    // La vraie mesure de l'amortissement : la liste de courses ne grossit pas
    // au rythme du menu. Huit fois plus de repas ne doit pas donner huit fois
    // plus de produits distincts à acheter.
    const distincts = async (req: PlanRequest) => {
      const result = await plan(req);
      return new Set(result.recipes.flatMap((r) => r.ingredients.map((i) => i.productId))).size;
    };

    const petit = await distincts(request(30, 5, 2));
    const grand = await distincts(request(240, 40, 2));

    assert.ok(
      grand / 40 < petit / 5,
      `${(grand / 40).toFixed(2)} produit(s) par repas sur quarante, `
        + `contre ${(petit / 5).toFixed(2)} sur cinq`,
    );
  });

  it("tient encore le budget à soixante repas", async () => {
    // Le plafond de l'application est à soixante : le budget doit y rester une
    // contrainte, pas une indication.
    const req = request(360, 60, 2);
    const result = await plan(req);

    assert.equal(result.recipes.length, 60);
    assert.ok(
      result.shoppingList.total <= req.budget,
      `${result.shoppingList.total.toFixed(2)} € pour un budget de ${req.budget} €`,
    );
  });
});
