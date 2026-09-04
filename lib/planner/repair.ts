import type { DietTag, Product, Recipe, ShoppingList } from "@/lib/types";
import { formatPrice, substitutesFor, unitPrice } from "@/lib/catalog";
import { buildShoppingList, type CostOptions } from "@/lib/planner/cost";

/**
 * Ramène un plan dans son budget sans repasser par l'IA.
 *
 * Trois leviers, appliqués dans cet ordre parce que c'est l'ordre qui dégrade
 * le moins le repas :
 *   1. substituer un produit par un équivalent moins cher (même catégorie) ;
 *   2. retirer les ingrédients marqués optionnels ;
 *   3. réduire les quantités des ingrédients d'accompagnement.
 *
 * La viande et le poisson ne sont jamais réduits en dernier recours sans le
 * dire : chaque intervention est journalisée et remontée à l'utilisateur.
 */

export interface RepairInput {
  recipes: Recipe[];
  productsById: Map<string, Product>;
  /** Produits achetables, déjà filtrés selon le régime et les exclusions. */
  pool: Product[];
  budget: number;
  diet: DietTag[];
  costOptions?: CostOptions;
}

export interface RepairResult {
  recipes: Recipe[];
  shoppingList: ShoppingList;
  /** Journal lisible des modifications, affiché sous le plan. */
  repairs: string[];
  withinBudget: boolean;
}

/** Catégories qu'on réduit en priorité : elles pèsent peu dans le plaisir. */
const FLEXIBLE_CATEGORIES = new Set([
  "fromage", "creme", "beurre", "apero", "dip", "chocolat", "fruit-sec",
  "condiment", "matiere-grasse", "alcool", "soda", "biscuit",
]);

export function fitToBudget(input: RepairInput): RepairResult {
  const { productsById, pool, budget, diet, costOptions } = input;
  let recipes = input.recipes.map(cloneRecipe);
  const repairs: string[] = [];

  let list = buildShoppingList(recipes, productsById, costOptions);
  if (list.total <= budget) return { recipes, shoppingList: list, repairs, withinBudget: true };

  // --- 1. Substitutions -----------------------------------------------------
  // On traite les lignes les plus chères d'abord : c'est là que se trouvent
  // les euros, et une seule substitution y règle souvent le dépassement.
  const substitutionOrder = [...list.lines].sort((a, b) => b.cost - a.cost);

  for (const line of substitutionOrder) {
    if (list.total <= budget) break;

    const current = line.product;
    const [cheapest] = substitutesFor(current, pool, diet);
    if (!cheapest || unitPrice(cheapest) >= unitPrice(current)) continue;

    const candidate = recipes.map((recipe) => swapProduct(recipe, current, cheapest));
    const candidateList = buildShoppingList(candidate, productsById, costOptions);
    if (candidateList.total >= list.total) continue;

    const saved = list.total - candidateList.total;
    recipes = candidate;
    list = candidateList;
    repairs.push(
      `${current.name} remplacé par ${cheapest.name} (${formatPrice(saved)} économisés).`,
    );
  }

  if (list.total <= budget) return { recipes, shoppingList: list, repairs, withinBudget: true };

  // --- 2. Ingrédients optionnels -------------------------------------------
  const withoutOptional = recipes.map((recipe) => ({
    ...recipe,
    ingredients: recipe.ingredients.filter((i) => !i.optional),
  }));
  const droppedCount = recipes.reduce(
    (sum, r) => sum + r.ingredients.filter((i) => i.optional).length, 0,
  );
  if (droppedCount > 0) {
    recipes = withoutOptional;
    list = buildShoppingList(recipes, productsById, costOptions);
    repairs.push(
      `${droppedCount} ingrédient${droppedCount > 1 ? "s" : ""} optionnel${droppedCount > 1 ? "s" : ""} retiré${droppedCount > 1 ? "s" : ""}.`,
    );
  }

  if (list.total <= budget) return { recipes, shoppingList: list, repairs, withinBudget: true };

  // --- 3. Réduction progressive des quantités flexibles ---------------------
  // Par paliers de 10 %, jamais en dessous de 60 % de la quantité d'origine :
  // en dessous, ce n'est plus la même recette et il vaut mieux le dire.
  for (const factor of [0.9, 0.8, 0.7, 0.6]) {
    if (list.total <= budget) break;

    const candidate = input.recipes.map((original, i) => {
      const currentRecipe = recipes[i] ?? cloneRecipe(original);
      return {
        ...currentRecipe,
        ingredients: currentRecipe.ingredients.map((ing) => {
          const product = productsById.get(ing.productId);
          if (!product || !FLEXIBLE_CATEGORIES.has(product.category)) return ing;
          const base = original.ingredients.find((o) => o.productId === ing.productId);
          const reference = base?.quantity ?? ing.quantity;
          return { ...ing, quantity: roundQuantity(reference * factor, product) };
        }),
      };
    });

    const candidateList = buildShoppingList(candidate, productsById, costOptions);
    if (candidateList.total < list.total) {
      recipes = candidate;
      list = candidateList;
      if (factor === 0.6 || candidateList.total <= budget) {
        repairs.push(
          `Quantités d'accompagnement (fromage, crème, matières grasses) réduites de ${Math.round((1 - factor) * 100)} %.`,
        );
      }
    }
  }

  return {
    recipes,
    shoppingList: list,
    repairs,
    withinBudget: list.total <= budget,
  };
}

/** Remplace un produit par un autre dans une recette, en convertissant la quantité. */
function swapProduct(recipe: Recipe, from: Product, to: Product): Recipe {
  if (!recipe.ingredients.some((i) => i.productId === from.id)) return recipe;

  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ing) => {
      if (ing.productId !== from.id) return ing;
      return {
        ...ing,
        productId: to.id,
        quantity: roundQuantity(ing.quantity, to),
        label: ing.label.replace(from.name, to.name),
      };
    }),
  };
}

/** Arrondit une quantité à un pas réaliste : pas de « 137,4 g de crème ». */
function roundQuantity(quantity: number, product: Product): number {
  if (product.unit === "piece") return Math.max(1, Math.round(quantity));
  const step = quantity >= 500 ? 50 : quantity >= 100 ? 10 : 5;
  return Math.max(step, Math.round(quantity / step) * step);
}

function cloneRecipe(recipe: Recipe): Recipe {
  return { ...recipe, ingredients: recipe.ingredients.map((i) => ({ ...i })) };
}

/**
 * Inverse du précédent : quand il reste du budget, propose des ajouts utiles
 * plutôt que de laisser l'argent sur la table sans rien dire.
 */
export function suggestExtras(
  remaining: number,
  pool: Product[],
  alreadyBought: Set<string>,
  limit = 6,
): Product[] {
  if (remaining < 1) return [];

  const nice = pool.filter(
    (p) =>
      !alreadyBought.has(p.id) &&
      p.stock !== "rupture" &&
      p.price <= remaining &&
      ["fruit", "legume", "yaourt", "fromage", "apero", "chocolat", "biscuit", "dip"].includes(p.category),
  );

  // Priorité au frais et au moins cher : on complète le plan, on ne le noie pas.
  return nice
    .sort((a, b) => {
      const freshness = rank(a) - rank(b);
      return freshness !== 0 ? freshness : a.price - b.price;
    })
    .slice(0, limit);
}

function rank(product: Product): number {
  if (product.category === "fruit" || product.category === "legume") return 0;
  if (product.category === "yaourt") return 1;
  return 2;
}
