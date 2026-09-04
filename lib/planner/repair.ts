import type { DietTag, Product, Recipe, ShoppingList } from "@/lib/types";
import {
  averagePieceWeight, comparablePrice, formatPrice, gramsToProductQuantity,
  quantityLabel, substitutesFor, unitPrice,
} from "@/lib/catalog";
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

/**
 * Protéines animales, classées de la plus chère à la plus abordable, et les
 * substituts qui les remplacent quand le budget ne suit pas.
 *
 * C'est le poste le plus lourd d'un panier, et il était jusqu'ici intouchable :
 * le moteur pouvait rogner le fromage mais pas remplacer une entrecôte par des
 * lentilles, ce qui est pourtant le premier geste de quiconque cuisine à
 * budget serré.
 */
const PROTEINES_ANIMALES = new Set([
  "boeuf", "porc", "agneau", "veau", "canard", "poulet", "dinde",
  "poisson-blanc", "poisson-gras", "fruits-de-mer", "charcuterie",
  "poisson-surgele", "conserve-poisson",
]);

/**
 * Ce qui peut réellement tenir la place d'une viande.
 *
 * « graine » en faisait partie : la semoule est le moins cher au kilo de tout
 * le catalogue, elle gagnait donc à chaque fois, et un filet de lieu se
 * retrouvait remplacé par de la semoule au nom de la protéine. C'est un
 * féculent. Il est sorti de la liste, et les candidats restants sont classés
 * au prix du gramme de protéine, pas au prix du kilo.
 */
const PROTEINES_ABORDABLES = ["legumineuse", "oeuf", "vegetal"];

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

  if (list.total <= budget) return { recipes, shoppingList: list, repairs, withinBudget: true };

  // --- 4. Report des protéines animales vers des protéines abordables -------
  // Dernier levier avant l'aveu d'échec, et le plus efficace : la viande pèse
  // souvent la moitié du panier. On l'annonce clairement plutôt que de
  // substituer en silence — ce n'est plus tout à fait le plat proposé.
  for (const line of [...list.lines].sort((a, b) => b.cost - a.cost)) {
    if (list.total <= budget) break;
    if (!PROTEINES_ANIMALES.has(line.product.category)) continue;

    const remplacant = cheapestProtein(PROTEINES_ABORDABLES, pool, diet);
    if (!remplacant || comparablePrice(remplacant) >= comparablePrice(line.product)) continue;

    const candidate = recipes.map((recipe) => swapProduct(recipe, line.product, remplacant));
    const candidateList = buildShoppingList(candidate, productsById, costOptions);
    if (candidateList.total >= list.total) continue;

    const saved = list.total - candidateList.total;
    recipes = candidate;
    list = candidateList;
    repairs.push(
      `${line.product.name} remplacé par ${remplacant.name} : le budget ne permettait pas de protéine animale ici (${formatPrice(saved)} économisés).`,
    );
  }

  if (list.total <= budget) return { recipes, shoppingList: list, repairs, withinBudget: true };

  // --- 5. Réduction des protéines restantes ---------------------------------
  // Jamais en dessous de la moitié : au-delà, ce n'est plus un repas, et il
  // vaut mieux dire que le budget ne passe pas.
  for (const factor of [0.85, 0.7, 0.55]) {
    if (list.total <= budget) break;

    const candidate = recipes.map((recipe) => ({
      ...recipe,
      ingredients: recipe.ingredients.map((ing) => {
        const product = productsById.get(ing.productId);
        if (!product || !PROTEINES_ANIMALES.has(product.category)) return ing;
        const base = input.recipes
          .find((r) => r.id === recipe.id)?.ingredients
          .find((o) => o.productId === ing.productId);
        return { ...ing, quantity: roundQuantity((base?.quantity ?? ing.quantity) * factor, product) };
      }),
    }));

    const candidateList = buildShoppingList(candidate, productsById, costOptions);
    if (candidateList.total < list.total) {
      recipes = candidate;
      list = candidateList;
      if (candidateList.total <= budget || factor === 0.55) {
        repairs.push(
          `Portions de viande et de poisson réduites de ${Math.round((1 - factor) * 100)} % pour tenir le budget.`,
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

/** Produit le moins cher au kilo équivalent parmi une liste de catégories. */
function cheapestIn(
  categories: string[],
  pool: Product[],
  requiredDiet: DietTag[],
): Product | undefined {
  return candidats(categories, pool, requiredDiet)
    .sort((a, b) => comparablePrice(a) - comparablePrice(b))[0];
}

/**
 * Le moins cher au gramme de protéine — la seule comparaison qui a du sens
 * quand il s'agit de remplacer une viande. Au prix du kilo, un produit peu
 * protéiné gagne toujours, et le repas perd ce qu'il était censé garder.
 */
function cheapestProtein(
  categories: string[],
  pool: Product[],
  requiredDiet: DietTag[],
): Product | undefined {
  const coutParGrammeDeProteine = (p: Product) => {
    const proteine = p.nutrition?.protein ?? 0;
    return proteine > 0 ? comparablePrice(p) / (proteine * 10) : Number.POSITIVE_INFINITY;
  };

  return candidats(categories, pool, requiredDiet)
    .filter((p) => Number.isFinite(coutParGrammeDeProteine(p)))
    .sort((a, b) => coutParGrammeDeProteine(a) - coutParGrammeDeProteine(b))[0];
}

function candidats(categories: string[], pool: Product[], requiredDiet: DietTag[]): Product[] {
  return pool.filter(
    (p) =>
      categories.includes(p.category) &&
      p.stock !== "rupture" &&
      requiredDiet.every((tag) => p.diet.includes(tag)),
  );
}

/** Remplace un produit par un autre dans une recette, en convertissant la quantité. */
function swapProduct(recipe: Recipe, from: Product, to: Product): Recipe {
  if (!recipe.ingredients.some((i) => i.productId === from.id)) return recipe;

  return {
    ...recipe,
    // Le titre et les étapes ne sont pas réécrits : substituer le nom donnait
    // « lentilles vertes poêlé » et « poêler le lentilles vertes ». On note la
    // substitution sur la recette, et l'écran l'affiche — le lecteur voit donc
    // que le titre parle d'un poisson qui n'est plus dans sa liste, au lieu de
    // le découvrir en rayon.
    substitutions: [...(recipe.substitutions ?? []), { from: from.name, to: to.name }],
    ingredients: recipe.ingredients.map((ing) => {
      if (ing.productId !== from.id) return ing;
      const quantity = roundQuantity(convertQuantity(ing.quantity, from, to), to);
      return {
        ...ing,
        productId: to.id,
        quantity,
        // Libellé reconstruit plutôt que rapiécé : `label.replace(from.name…)`
        // était sensible à la casse et au pluriel, et laissait donc souvent
        // l'ancien nom en place — avec l'ancienne quantité, dans la mauvaise
        // unité.
        label: `${quantityLabel(quantity, to.unit)} de ${to.name.toLowerCase()}`,
      };
    }),
  };
}

/**
 * Convertit une quantité d'un produit vers un autre en passant par les grammes.
 *
 * Sans cela, remplacer 300 g de carottes par des concombres — vendus à la
 * pièce, même catégorie — donnait 300 concombres.
 */
function convertQuantity(quantity: number, from: Product, to: Product): number {
  if (from.unit === to.unit) return quantity;
  const grammes = from.unit === "piece" ? quantity * averagePieceWeight(from) : quantity;
  return gramsToProductQuantity(grammes, to);
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
