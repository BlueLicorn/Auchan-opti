import type { Catalog, MealPlan, PlanRequest, Product } from "@/lib/types";
import { filterCatalog, formatPrice, indexById } from "@/lib/catalog";
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

  let raw = await composeAvecGemini({
    request, pool, gemini, signal, onProgress,
  });

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

/**
 * Nombre de repas demandés en une seule requête au modèle.
 *
 * Au-delà, la réponse se fait tronquer : une recette détaillée pèse plusieurs
 * centaines de jetons, et le plafond de sortie d'un modèle Flash est vite
 * atteint. Découper permet de demander trente repas sans rien perdre — au prix
 * d'un appel supplémentaire par lot, prélevé sur le quota de l'utilisateur.
 */
const REPAS_PAR_LOT = 6;

/**
 * Demande les repas au modèle, en un seul appel ou en plusieurs lots.
 *
 * Chaque lot reçoit la liste des plats déjà composés, pour que le menu ne
 * tourne pas en rond : sans cela, chaque lot repartirait des mêmes produits
 * les moins chers et proposerait trois fois les mêmes pâtes.
 */
async function composeAvecGemini({
  request, pool, gemini, signal, onProgress,
}: {
  request: PlanRequest;
  pool: Product[];
  gemini: { apiKey: string; model: string };
  signal?: AbortSignal;
  onProgress?: (step: string) => void;
}): Promise<RawPlan> {
  const lots = decouperEnLots(request.meals, REPAS_PAR_LOT);

  if (lots.length === 1) {
    onProgress?.("Composition des repas par Gemini…");
    return withRetry(() =>
      generateJson<RawPlan>({
        apiKey: gemini.apiKey,
        model: gemini.model,
        systemInstruction: SYSTEM_INSTRUCTION,
        prompt: buildPlanPrompt(request, pool),
        responseSchema: PLAN_SCHEMA,
        signal,
      }),
    );
  }

  const recipes: RawPlan["recipes"] = [];
  const notes: string[] = [];

  for (const [index, taille] of lots.entries()) {
    onProgress?.(
      `Composition des repas ${recipes.length + 1} à ${recipes.length + taille}`
      + ` sur ${request.meals}…`,
    );

    // Le budget est réparti au prorata du lot : chacun doit viser sa part,
    // sinon le premier lot consomme tout et les suivants n'ont plus rien.
    const partDuLot: PlanRequest = {
      ...request,
      meals: taille,
      budget: round2(request.budget * (taille / request.meals)),
    };

    const dejaProposes = recipes.map((recipe) => recipe.title);
    const consigne = dejaProposes.length > 0
      ? `${buildPlanPrompt(partDuLot, pool)}\n\n## Déjà au menu\n`
        + `${dejaProposes.map((titre) => `- ${titre}`).join("\n")}\n`
        + `Propose autre chose : ni les mêmes plats, ni les mêmes protéines`
        + ` dominantes. Tu peux en revanche réutiliser les produits déjà`
        + ` achetés — c'est même souhaitable pour finir les paquets ouverts.`
      : buildPlanPrompt(partDuLot, pool);

    try {
      const lot = await withRetry(() =>
        generateJson<RawPlan>({
          apiKey: gemini.apiKey,
          model: gemini.model,
          systemInstruction: SYSTEM_INSTRUCTION,
          prompt: consigne,
          responseSchema: PLAN_SCHEMA,
          signal,
        }),
      );
      recipes.push(...(lot.recipes ?? []));
      notes.push(...(lot.notes ?? []));
    } catch (error) {
      // Un lot perdu ne doit pas emporter les précédents : on garde ce qui a
      // été composé et l'appelant signalera le manque.
      if (index === 0) throw error;
      notes.push(
        `Le lot ${index + 1} n'a pas abouti ; le plan est plus court que demandé.`,
      );
      break;
    }
  }

  return { recipes, notes };
}

/** Répartit N repas en lots aussi égaux que possible, sans lot d'un seul repas. */
export function decouperEnLots(total: number, taille: number): number[] {
  if (total <= taille) return [total];

  const nombre = Math.ceil(total / taille);
  const base = Math.floor(total / nombre);
  const reste = total % nombre;

  return Array.from({ length: nombre }, (_, i) => base + (i < reste ? 1 : 0));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Explique un dépassement au lieu de le constater.
 *
 * Annoncer « budget dépassé de 12 € » sans dire pourquoi ni de combien on
 * aurait besoin laisse l'utilisateur devant un échec muet. On calcule donc le
 * minimum réellement atteignable avec ses contraintes — en refaisant un plan
 * sous contrainte maximale — et on nomme la cause dominante.
 */
function explainOverBudget(
  request: PlanRequest,
  total: number,
  pool: Product[],
  productsById: Map<string, Product>,
): string[] {
  const servings = Math.max(1, request.meals * request.servingsPerMeal);
  const demande = request.budget / servings;
  const obtenu = total / servings;

  // Plan de référence au plus serré, passé par la même réparation budgétaire
  // que le plan réel : sans cela on annoncerait un « minimum » supérieur à ce
  // qui vient d'être servi, ce qui n'a aucun sens.
  const costOptions = { pantry: request.pantry, assumeStaples: true };
  const serre = planOffline({ ...request, budget: servings * 0.2 }, pool);
  const plancherRepare = serre.length > 0
    ? fitToBudget({
        recipes: serre, productsById, pool,
        budget: servings * 0.2, diet: request.diet, costOptions,
      }).shoppingList.total / servings
    : obtenu;

  // Le plan servi fait foi : le plancher ne peut pas lui être supérieur.
  const coutPlancher = Math.min(plancherRepare, obtenu);

  const messages = [
    `Budget non tenu : ${formatPrice(obtenu)} par portion au lieu des ${formatPrice(demande)} demandés`
    + ` (${formatPrice(total)} au total pour ${formatPrice(request.budget)} prévus).`,
  ];

  // En dessous d'une douzaine de portions, ce sont les conditionnements qui
  // décident : on n'achète pas 110 g de pâtes, on achète un paquet de 500 g.
  if (servings <= 10) {
    messages.push(
      `Avec seulement ${servings} portion(s), le conditionnement domine le prix :`
      + ` un paquet entier est facturé même si la recette n'en utilise qu'une part.`
      + ` Cuisiner plus de portions du même plat ferait davantage baisser le prix unitaire`
      + ` que réduire le nombre de repas.`,
    );
  }

  messages.push(
    `Le minimum atteignable avec ces contraintes est d'environ ${formatPrice(coutPlancher)} par portion,`
    + ` soit ${formatPrice(coutPlancher * servings)} pour l'ensemble.`,
  );

  return messages;
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
    warnings.push(...explainOverBudget(request, repaired.shoppingList.total, pool, productsById));
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
