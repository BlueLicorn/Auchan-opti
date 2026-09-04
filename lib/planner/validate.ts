import type {
  Equipment, PlanRequest, Product, Recipe, RecipeIngredient, SkillLevel,
} from "@/lib/types";
import { EQUIPMENT } from "@/lib/types";
import { findProduct, normalize } from "@/lib/catalog";
import type { RawPlan } from "@/lib/ai/prompts";

/**
 * Transforme la réponse du modèle en recettes exploitables, ou explique
 * pourquoi elle ne l'est pas.
 *
 * On ne fait confiance à rien : un id inconnu est rattrapé par recherche
 * textuelle puis, à défaut, l'ingrédient est écarté ; une quantité aberrante
 * est ramenée à une valeur plausible ; un régime non respecté fait échouer la
 * recette entière, parce qu'une allergie ne se négocie pas.
 */

export interface ValidationResult {
  recipes: Recipe[];
  warnings: string[];
}

/** Bornes de bon sens par unité, pour une recette entière. */
const MAX_QUANTITY: Record<Product["unit"], number> = { g: 4000, ml: 4000, piece: 30 };

export function validatePlan(
  raw: RawPlan,
  pool: Product[],
  request: PlanRequest,
): ValidationResult {
  const warnings: string[] = [];
  const byId = new Map(pool.map((p) => [p.id, p]));
  const allowedEquipment = new Set<string>(request.equipment);
  const exclusions = request.exclusions.map(normalize).filter((e) => e.length >= 2);
  const recipes: Recipe[] = [];

  if (!Array.isArray(raw?.recipes) || raw.recipes.length === 0) {
    return { recipes: [], warnings: ["Le modèle n'a renvoyé aucune recette."] };
  }

  for (const [index, rawRecipe] of raw.recipes.entries()) {
    const title = String(rawRecipe?.title ?? "").trim();
    if (!title) {
      warnings.push(`Recette ${index + 1} ignorée : titre manquant.`);
      continue;
    }

    const ingredients: RecipeIngredient[] = [];
    let violatesDiet = false;

    for (const rawIngredient of rawRecipe.ingredients ?? []) {
      const resolved = resolveProduct(rawIngredient, byId, pool);
      if (!resolved) {
        warnings.push(`« ${title} » : ingrédient « ${rawIngredient?.label ?? rawIngredient?.productId ?? "?"} » introuvable au catalogue, retiré.`);
        continue;
      }

      // Une exclusion utilisateur invalide la recette : on ne « répare » pas
      // une allergie en supprimant discrètement la ligne.
      const haystack = `${normalize(resolved.name)} ${normalize(resolved.category)} ${normalize(rawIngredient.label ?? "")}`;
      if (exclusions.some((term) => haystack.includes(term))) {
        warnings.push(`« ${title} » écartée : contient un ingrédient exclu (${resolved.name}).`);
        violatesDiet = true;
        break;
      }
      if (request.diet.some((tag) => !resolved.diet.includes(tag))) {
        warnings.push(`« ${title} » écartée : ${resolved.name} ne respecte pas le régime demandé.`);
        violatesDiet = true;
        break;
      }

      const quantity = clampQuantity(Number(rawIngredient.quantity), resolved);
      if (quantity === undefined) {
        warnings.push(`« ${title} » : quantité illisible pour ${resolved.name}, ingrédient retiré.`);
        continue;
      }

      const existing = ingredients.find((i) => i.productId === resolved.id);
      if (existing) {
        existing.quantity += quantity;
        continue;
      }

      ingredients.push({
        productId: resolved.id,
        quantity,
        label: String(rawIngredient.label ?? resolved.name).trim() || resolved.name,
        ...(rawIngredient.optional ? { optional: true } : {}),
      });
    }

    if (violatesDiet) continue;

    if (ingredients.length < 2) {
      warnings.push(`« ${title} » écartée : pas assez d'ingrédients exploitables.`);
      continue;
    }

    const steps = (rawRecipe.steps ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (steps.length === 0) {
      warnings.push(`« ${title} » écartée : aucune étape de préparation.`);
      continue;
    }

    const equipment = (rawRecipe.equipment ?? [])
      .map((e) => normalize(String(e)).replace(/[\s-]+/g, "_"))
      .filter((e): e is Equipment => (EQUIPMENT as readonly string[]).includes(e));

    const unauthorized = equipment.filter((e) => !allowedEquipment.has(e));
    if (unauthorized.length > 0) {
      warnings.push(`« ${title} » utilise un équipement non déclaré : ${unauthorized.join(", ")}.`);
    }

    recipes.push({
      id: `r${index + 1}-${slug(title)}`,
      title,
      description: String(rawRecipe.description ?? "").trim(),
      servings: clampInt(rawRecipe.servings, 1, 12, request.servingsPerMeal),
      prepMinutes: clampInt(rawRecipe.prepMinutes, 0, 240, 15),
      cookMinutes: clampInt(rawRecipe.cookMinutes, 0, 480, 20),
      skill: clampInt(rawRecipe.skill, 1, 3, request.skill) as SkillLevel,
      equipment,
      ingredients,
      steps,
      tips: (rawRecipe.tips ?? []).map((t) => String(t).trim()).filter(Boolean),
      diet: dietOf(ingredients, byId),
      indulgence: clampInt(rawRecipe.indulgence, 0, 100, request.indulgence),
    });
  }

  if (recipes.length < request.meals) {
    warnings.push(
      `${recipes.length} recette(s) exploitable(s) sur ${request.meals} demandée(s).`,
    );
  }

  const overTime = recipes.filter((r) => r.prepMinutes + r.cookMinutes > request.maxPrepMinutes);
  if (overTime.length > 0) {
    warnings.push(
      `${overTime.length} recette(s) dépassent les ${request.maxPrepMinutes} min demandées : ${overTime.map((r) => r.title).join(", ")}.`,
    );
  }

  return { recipes: recipes.slice(0, request.meals), warnings };
}

/** Retrouve le produit visé, par id exact puis par rapprochement de libellé. */
function resolveProduct(
  rawIngredient: { productId?: string; label?: string } | undefined,
  byId: Map<string, Product>,
  pool: Product[],
): Product | undefined {
  if (!rawIngredient) return undefined;
  const id = String(rawIngredient.productId ?? "").trim();
  const direct = byId.get(id);
  if (direct) return direct;
  return findProduct(id, pool) ?? findProduct(String(rawIngredient.label ?? ""), pool);
}

function clampQuantity(quantity: number, product: Product): number | undefined {
  if (!Number.isFinite(quantity) || quantity <= 0) return undefined;
  const max = MAX_QUANTITY[product.unit];
  return Math.min(quantity, max);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Régimes réellement satisfaits par la recette : l'intersection de ses produits. */
function dietOf(ingredients: RecipeIngredient[], byId: Map<string, Product>) {
  const products = ingredients
    .map((i) => byId.get(i.productId))
    .filter((p): p is Product => Boolean(p));
  if (products.length === 0) return [];
  return products[0].diet.filter((tag) => products.every((p) => p.diet.includes(tag)));
}

function slug(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
}
