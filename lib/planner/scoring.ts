import type {
  IndulgenceLevel, NutritionSummary, Nutrition, Product, Recipe,
} from "@/lib/types";
import { averagePieceWeight } from "@/lib/catalog";

/**
 * Évaluation nutritionnelle d'un plan.
 *
 * Le score d'équilibre n'est pas un jugement moral sur la nourriture : c'est
 * un écart mesuré aux repères de l'ANSES pour un adulte. Le curseur « gros
 * porc » déplace explicitement ces repères, pour que l'application dise la
 * vérité sur ce qu'elle propose au lieu de la maquiller.
 */

/** Repères par portion pour un repas principal d'adulte (base 2 000 kcal/j). */
const TARGET = {
  kcal: 700,
  proteinRatio: 0.2,   // part de l'énergie issue des protéines
  carbsRatio: 0.48,
  fatRatio: 0.32,
  fiber: 10,           // grammes par repas
  salt: 2.2,           // grammes par repas, plafond
};

/** Quantité totale de nutriments apportée par une recette. */
export function recipeNutrition(
  recipe: Recipe,
  productsById: Map<string, Product>,
): Nutrition {
  const total: Nutrition = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, salt: 0 };

  for (const ingredient of recipe.ingredients) {
    const product = productsById.get(ingredient.productId);
    if (!product?.nutrition) continue;

    // Les valeurs sont pour 100 g / 100 ml. Une pièce est convertie via un
    // poids moyen, faute de mieux : mieux vaut une approximation annoncée
    // qu'une donnée manquante qui fausserait le score vers le haut.
    const grams = product.unit === "piece"
      ? ingredient.quantity * averagePieceWeight(product)
      : ingredient.quantity;

    const factor = grams / 100;
    total.kcal += product.nutrition.kcal * factor;
    total.protein += product.nutrition.protein * factor;
    total.carbs += product.nutrition.carbs * factor;
    total.fat += product.nutrition.fat * factor;
    total.fiber += product.nutrition.fiber * factor;
    total.salt += product.nutrition.salt * factor;
  }

  return total;
}

export function summarize(
  recipes: Recipe[],
  productsById: Map<string, Product>,
  indulgence: IndulgenceLevel,
): NutritionSummary {
  const servings = recipes.reduce((sum, r) => sum + r.servings, 0);
  if (servings === 0) {
    return {
      kcalPerServing: 0, proteinPerServing: 0, carbsPerServing: 0,
      fatPerServing: 0, fiberPerServing: 0, saltPerServing: 0, balanceScore: 0,
    };
  }

  const total: Nutrition = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, salt: 0 };
  for (const recipe of recipes) {
    const n = recipeNutrition(recipe, productsById);
    total.kcal += n.kcal;
    total.protein += n.protein;
    total.carbs += n.carbs;
    total.fat += n.fat;
    total.fiber += n.fiber;
    total.salt += n.salt;
  }

  const perServing = {
    kcalPerServing: round(total.kcal / servings),
    proteinPerServing: round(total.protein / servings),
    carbsPerServing: round(total.carbs / servings),
    fatPerServing: round(total.fat / servings),
    fiberPerServing: round(total.fiber / servings),
    saltPerServing: round1(total.salt / servings),
  };

  return { ...perServing, balanceScore: balanceScore(perServing, indulgence) };
}

/**
 * Score 0 → 100. Chaque critère pénalise l'écart relatif à sa cible ; le
 * curseur plaisir relâche les cibles caloriques et lipidiques au lieu de
 * masquer l'écart, si bien qu'un plan « gros porc » peut être bien noté
 * parce qu'il fait bien ce qu'on lui a demandé de faire.
 */
export function balanceScore(
  perServing: Omit<NutritionSummary, "balanceScore">,
  indulgence: IndulgenceLevel,
): number {
  const t = indulgentTargets(indulgence);
  const kcal = Math.max(perServing.kcalPerServing, 1);

  const proteinRatio = (perServing.proteinPerServing * 4) / kcal;
  const carbsRatio = (perServing.carbsPerServing * 4) / kcal;
  const fatRatio = (perServing.fatPerServing * 9) / kcal;

  // Tolérances resserrées : avec des bandes larges, presque tout obtenait
  // 100/100 et la note ne disait plus rien.
  const penalties = [
    { weight: 20, gap: relative(perServing.kcalPerServing, t.kcal, 0.15) },
    { weight: 22, gap: relative(proteinRatio, t.proteinRatio, 0.2) },
    { weight: 16, gap: relative(carbsRatio, t.carbsRatio, 0.2) },
    { weight: 20, gap: relative(fatRatio, t.fatRatio, 0.2) },
    { weight: 12, gap: shortfall(perServing.fiberPerServing, t.fiber) },
    { weight: 10, gap: excess(perServing.saltPerServing, t.salt) },
  ];

  const lost = penalties.reduce((sum, p) => sum + p.weight * Math.min(1, p.gap), 0);
  return Math.max(0, Math.min(100, Math.round(100 - lost)));
}

/** Déplace les repères selon le curseur plaisir. 0 = ANSES, 100 = plaisir assumé. */
function indulgentTargets(indulgence: IndulgenceLevel) {
  const k = Math.max(0, Math.min(100, indulgence)) / 100;
  return {
    kcal: TARGET.kcal * (1 + 0.55 * k),
    proteinRatio: TARGET.proteinRatio * (1 - 0.15 * k),
    carbsRatio: TARGET.carbsRatio * (1 - 0.08 * k),
    fatRatio: TARGET.fatRatio * (1 + 0.35 * k),
    fiber: TARGET.fiber * (1 - 0.45 * k),
    salt: TARGET.salt * (1 + 0.5 * k),
  };
}

/** Écart relatif à une cible, normalisé par une tolérance. */
function relative(value: number, target: number, tolerance: number): number {
  if (target <= 0) return 0;
  const deviation = Math.abs(value - target) / target;
  return Math.max(0, (deviation - tolerance) / (1 - tolerance + 1e-9));
}

/** Pénalise seulement le fait d'être en dessous (fibres). */
function shortfall(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, (target - value) / target);
}

/** Pénalise seulement le fait d'être au-dessus (sel). */
function excess(value: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.max(0, (value - limit) / limit);
}

/** Commentaire lisible du score, affiché à côté du chiffre. */
export function balanceComment(score: number, indulgence: IndulgenceLevel): string {
  const mode = indulgence >= 70 ? "plaisir" : indulgence >= 35 ? "équilibré-gourmand" : "équilibré";
  if (score >= 80) return `Très cohérent avec le réglage ${mode}.`;
  if (score >= 60) return `Correct pour le réglage ${mode}, avec quelques écarts.`;
  if (score >= 40) return `Déséquilibré par rapport au réglage ${mode}.`;
  return `Loin des repères, même pour un réglage ${mode}.`;
}

const round = (n: number) => Math.round(n);
const round1 = (n: number) => Math.round(n * 10) / 10;
