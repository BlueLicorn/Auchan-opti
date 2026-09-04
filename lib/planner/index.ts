import type { Catalog, MealPlan, PlanRequest, Product } from "@/lib/types";
import { filterCatalog, indexById } from "@/lib/catalog";
import { buildShoppingList } from "@/lib/planner/cost";
import { fitToBudget, suggestExtras } from "@/lib/planner/repair";
import { planOffline } from "@/lib/planner/offline";
import { summarize } from "@/lib/planner/scoring";
import { validatePlan } from "@/lib/planner/validate";
import {
  PLAN_SCHEMA, SYSTEM_INSTRUCTION, buildPlanPrompt, buildRepairPrompt,
  type RawPlan,
} from "@/lib/ai/prompts";
import { generateJson, withRetry } from "@/lib/ai/gemini";

export * from "@/lib/planner/cost";
export * from "@/lib/planner/scoring";

/**
 * Chaîne complète de production d'un plan.
 *
 * 1. On restreint le catalogue à ce que l'utilisateur peut acheter.
 * 2. Le modèle compose des repas avec ces produits, et rien d'autre.
 * 3. On valide sa réponse sans lui faire confiance.
 * 4. On chiffre au conditionnement réel.
 * 5. Si ça dépasse, on demande une correction au modèle, puis on répare
 *    localement — parce qu'un second aller-retour coûte du temps et des jetons,
 *    et que les substitutions déterministes suffisent souvent.
 */

export interface PlanOptions {
  request: PlanRequest;
  catalog: Catalog;
  /** Absent : le planificateur hors-ligne prend le relais. */
  gemini?: { apiKey: string; model: string };
  /** Facture les épices au prorata plutôt qu'au pot entier. */
  assumeStaples?: boolean;
  signal?: AbortSignal;
  /** Retour de progression, pour l'interface. */
  onProgress?: (step: string) => void;
}

export async function generatePlan(options: PlanOptions): Promise<MealPlan> {
  const { request, catalog, gemini, signal, onProgress } = options;

  const pool = filterCatalog(catalog.products, {
    diet: request.diet,
    exclusions: request.exclusions,
    excludeOutOfStock: true,
  });

  if (pool.length < 20) {
    throw new Error(
      "Trop peu de produits disponibles après filtrage. Assouplis les régimes ou les exclusions.",
    );
  }

  const productsById = indexById({ ...catalog, products: pool });
  const costOptions = { pantry: request.pantry, assumeStaples: options.assumeStaples };
  const warnings: string[] = [];

  if (!gemini?.apiKey) {
    onProgress?.("Composition des repas (mode hors-ligne)…");
    return finalize({
      recipes: planOffline(request, pool),
      request, pool, productsById, costOptions,
      warnings: [
        "Plan généré sans IA : ajoute une clé Gemini dans les réglages pour des recettes plus variées.",
      ],
      engine: "offline",
    });
  }

  onProgress?.("Composition des repas par Gemini…");

  let raw = await withRetry(() =>
    generateJson<RawPlan>({
      apiKey: gemini.apiKey,
      model: gemini.model,
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildPlanPrompt(request, pool),
      responseSchema: PLAN_SCHEMA,
      signal,
    }),
  );

  let validation = validatePlan(raw, pool, request);
  warnings.push(...validation.warnings);

  if (validation.recipes.length === 0) {
    warnings.push("Aucune recette exploitable : repli sur le planificateur hors-ligne.");
    return finalize({
      recipes: planOffline(request, pool),
      request, pool, productsById, costOptions, warnings, engine: "offline",
    });
  }

  // Chiffrage réel, puis second essai si le dépassement est important.
  let list = buildShoppingList(validation.recipes, productsById, costOptions);
  const overshoot = list.total / request.budget;

  if (overshoot > 1.15) {
    onProgress?.(`Plan à ${list.total.toFixed(2)} € pour ${request.budget.toFixed(2)} € : correction…`);
    const expensive = [...list.lines]
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 6)
      .map((l) => ({ name: l.product.name, cost: l.cost }));

    try {
      raw = await withRetry(() =>
        generateJson<RawPlan>({
          apiKey: gemini.apiKey,
          model: gemini.model,
          systemInstruction: SYSTEM_INSTRUCTION,
          prompt: `${buildPlanPrompt(request, pool)}\n\n${buildRepairPrompt(request, list.total, expensive)}`,
          responseSchema: PLAN_SCHEMA,
          temperature: 0.5,
          signal,
        }),
      );

      const second = validatePlan(raw, pool, request);
      if (second.recipes.length > 0) {
        const secondList = buildShoppingList(second.recipes, productsById, costOptions);
        if (secondList.total < list.total) {
          validation = second;
          list = secondList;
          warnings.push(...second.warnings);
        }
      }
    } catch {
      // Un échec du second appel n'est pas bloquant : la réparation locale
      // ci-dessous fera le travail, simplement de façon moins créative.
      warnings.push("La correction par l'IA a échoué ; ajustement fait localement.");
    }
  }

  onProgress?.("Ajustement au budget…");

  return finalize({
    recipes: validation.recipes,
    request, pool, productsById, costOptions, warnings,
    engine: "gemini",
    model: gemini.model,
  });
}

interface FinalizeInput {
  recipes: MealPlan["recipes"];
  request: PlanRequest;
  pool: Product[];
  productsById: Map<string, Product>;
  costOptions: { pantry?: PlanRequest["pantry"]; assumeStaples?: boolean };
  warnings: string[];
  engine: "gemini" | "offline";
  model?: string;
}

/** Réparation budgétaire, chiffrage définitif et bilan nutritionnel. */
function finalize(input: FinalizeInput): MealPlan {
  const { recipes, request, pool, productsById, costOptions } = input;
  const warnings = [...input.warnings];

  if (recipes.length === 0) {
    throw new Error(
      "Impossible de composer un plan avec ces contraintes. Élargis l'équipement, le temps ou le niveau de cuisine.",
    );
  }

  const repaired = fitToBudget({
    recipes, productsById, pool,
    budget: request.budget,
    diet: request.diet,
    costOptions,
  });

  if (!repaired.withinBudget) {
    const gap = repaired.shoppingList.total - request.budget;
    warnings.push(
      `Budget dépassé de ${gap.toFixed(2)} € malgré les ajustements : réduis le nombre de repas, ou augmente le budget d'autant.`,
    );
  }

  // Budget nettement sous-employé : on propose de quoi le compléter plutôt
  // que de laisser croire que le plan a coûté tout ce qui était prévu.
  const remaining = request.budget - repaired.shoppingList.total;
  const suggestions = remaining >= Math.max(5, request.budget * 0.12)
    ? suggestExtras(remaining, pool, new Set(repaired.shoppingList.lines.map((l) => l.product.id)))
    : [];

  return {
    recipes: repaired.recipes,
    shoppingList: repaired.shoppingList,
    suggestions,
    nutrition: summarize(repaired.recipes, productsById, request.indulgence),
    request,
    warnings,
    provenance: {
      engine: input.engine,
      ...(input.model ? { model: input.model } : {}),
      repairs: repaired.repairs,
    },
  };
}
