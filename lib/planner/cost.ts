import type {
  MealPlan, PantryItem, Product, Rayon, Recipe,
  ShoppingLine, ShoppingList,
} from "@/lib/types";
import { rayonRank } from "@/lib/catalog";

/**
 * Chiffrage d'un ensemble de recettes.
 *
 * Le principe qui rend le budget fiable : on n'additionne pas des prix au
 * gramme. On agrège les besoins de toutes les recettes par produit, puis on
 * arrondit au conditionnement supérieur, parce que c'est ce qui se passe en
 * caisse. 350 g de pâtes coûtent le prix d'un paquet de 500 g, et les 150 g
 * restants sont comptés comme surplus, pas comme une économie.
 */

export interface CostOptions {
  /** Produits déjà en stock à la maison, déduits des besoins. */
  pantry?: PantryItem[];
  /**
   * Épices, sel, poivre, huile : on ne fait pas racheter un pot de curry
   * entier pour 5 g. Ces catégories sont facturées au prorata si l'utilisateur
   * déclare avoir un placard de base.
   */
  assumeStaples?: boolean;
}

/** Catégories considérées comme fond de placard quand `assumeStaples` est vrai. */
const STAPLE_CATEGORIES = new Set(["epice", "herbe", "matiere-grasse", "condiment", "farine"]);

export function buildShoppingList(
  recipes: Recipe[],
  productsById: Map<string, Product>,
  options: CostOptions = {},
): ShoppingList {
  const pantry = new Map((options.pantry ?? []).map((p) => [p.productId, p.quantity]));

  /** Besoin cumulé par produit, toutes recettes confondues. */
  const needed = new Map<string, { quantity: number; usedBy: Set<string> }>();

  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      if (ingredient.optional) continue;
      if (!productsById.has(ingredient.productId)) continue;
      if (!(ingredient.quantity > 0)) continue;

      const entry = needed.get(ingredient.productId) ?? { quantity: 0, usedBy: new Set() };
      entry.quantity += ingredient.quantity;
      entry.usedBy.add(recipe.title);
      needed.set(ingredient.productId, entry);
    }
  }

  const lines: ShoppingLine[] = [];

  for (const [productId, entry] of needed) {
    const product = productsById.get(productId)!;
    const available = pantry.get(productId) ?? 0;
    const fromPantry = Math.min(available, entry.quantity);
    const toBuy = entry.quantity - fromPantry;

    if (toBuy <= 0) {
      lines.push({
        product, packs: 0, neededQuantity: entry.quantity,
        leftoverQuantity: 0, cost: 0, usedBy: [...entry.usedBy], fromPantry,
      });
      continue;
    }

    const prorated = options.assumeStaples && STAPLE_CATEGORIES.has(product.category);
    const packs = prorated
      ? toBuy / product.packSize
      : Math.ceil(round(toBuy / product.packSize));

    const cost = round2(packs * product.price);
    const bought = packs * product.packSize;

    lines.push({
      product,
      packs: prorated ? round2(packs) : packs,
      neededQuantity: entry.quantity,
      leftoverQuantity: Math.max(0, round(bought - toBuy)),
      cost,
      usedBy: [...entry.usedBy],
      fromPantry,
      ...(prorated ? { prorated: true } : {}),
    });
  }

  lines.sort((a, b) => {
    const byRayon = rayonRank(a.product.rayon) - rayonRank(b.product.rayon);
    return byRayon !== 0 ? byRayon : a.product.name.localeCompare(b.product.name, "fr");
  });

  const total = round2(lines.reduce((sum, line) => sum + line.cost, 0));
  return { lines, total, byRayon: groupByRayon(lines) };
}

/**
 * Regroupe pour le parcours en magasin. Les lignes au prorata en sont exclues :
 * elles comptent dans le budget mais ne correspondent à rien qu'on attrape en
 * rayon, et les inclure ferait mentir les sous-totaux affichés.
 */
function groupByRayon(lines: ShoppingLine[]): ShoppingList["byRayon"] {
  const groups = new Map<Rayon, ShoppingLine[]>();
  for (const line of lines) {
    if (line.prorated || line.packs <= 0) continue;
    const bucket = groups.get(line.product.rayon) ?? [];
    bucket.push(line);
    groups.set(line.product.rayon, bucket);
  }
  return [...groups.entries()]
    .sort((a, b) => rayonRank(a[0]) - rayonRank(b[0]))
    .map(([rayon, group]) => ({
      rayon,
      lines: group,
      subtotal: round2(group.reduce((sum, l) => sum + l.cost, 0)),
    }));
}

/**
 * Coût réel d'une recette : sa part du panier, au prorata de ce qu'elle
 * consomme de chaque produit. Deux recettes qui partagent un paquet de pâtes
 * se partagent son prix — la somme des coûts par recette égale le total.
 */
export function costPerRecipe(
  recipes: Recipe[],
  list: ShoppingList,
): Map<string, number> {
  const linesByProduct = new Map(list.lines.map((l) => [l.product.id, l]));
  const totalNeeded = new Map<string, number>();

  for (const recipe of recipes) {
    for (const ing of recipe.ingredients) {
      if (ing.optional) continue;
      totalNeeded.set(ing.productId, (totalNeeded.get(ing.productId) ?? 0) + ing.quantity);
    }
  }

  const result = new Map<string, number>();
  for (const recipe of recipes) {
    let cost = 0;
    for (const ing of recipe.ingredients) {
      if (ing.optional) continue;
      const line = linesByProduct.get(ing.productId);
      const total = totalNeeded.get(ing.productId) ?? 0;
      if (!line || total <= 0) continue;
      cost += line.cost * (ing.quantity / total);
    }
    result.set(recipe.id, round2(cost));
  }
  return result;
}

/** Coût par portion servie sur l'ensemble du plan. */
export function costPerServing(plan: Pick<MealPlan, "recipes" | "shoppingList">): number {
  const servings = plan.recipes.reduce((sum, r) => sum + r.servings, 0);
  return servings > 0 ? round2(plan.shoppingList.total / servings) : 0;
}

/**
 * Au-delà de cette durée de conservation, un surplus n'est pas perdu : il
 * rejoint le placard et servira. Un litre d'huile acheté pour 25 ml n'est pas
 * du gâchis ; 800 g de salade sur 200 g utilisés, si.
 */
export const PANTRY_SHELF_LIFE_DAYS = 60;

/**
 * Valeur du surplus périssable : ce qui est acheté, non consommé par le plan,
 * et qui se sera abîmé avant de pouvoir l'être. C'est le seul surplus qui
 * mérite d'être appelé du gâchis, et donc le seul qu'on affiche comme tel.
 */
export function leftoverValue(list: ShoppingList): number {
  return sumLeftovers(list, (line) => line.product.shelfLifeDays <= PANTRY_SHELF_LIFE_DAYS);
}

/**
 * Valeur du surplus qui se conserve : de la provision, pas de la perte.
 * L'afficher séparément évite de faire passer un paquet de riz pour un déchet.
 */
export function pantryStockValue(list: ShoppingList): number {
  return sumLeftovers(list, (line) => line.product.shelfLifeDays > PANTRY_SHELF_LIFE_DAYS);
}

function sumLeftovers(list: ShoppingList, keep: (line: ShoppingLine) => boolean): number {
  let value = 0;
  for (const line of list.lines) {
    if (line.packs <= 0 || !keep(line)) continue;
    const bought = line.packs * line.product.packSize;
    if (bought <= 0) continue;
    value += line.cost * (line.leftoverQuantity / bought);
  }
  return round2(value);
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const round2 = (n: number) => Math.round(n * 100) / 100;
