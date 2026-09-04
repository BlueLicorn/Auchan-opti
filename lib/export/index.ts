import type { MealPlan, ShoppingLine } from "@/lib/types";
import { formatPrice, packLabel, quantityLabel } from "@/lib/catalog";
import { costPerRecipe, costPerServing, leftoverValue } from "@/lib/planner/cost";

/**
 * Sorties destinées à quitter l'application : presse-papier, fichier, drive.
 * Chaque format vise un usage précis plutôt qu'un « export générique ».
 */

/** Liste courte, à coller dans un pense-bête ou à envoyer par message. */
export function shoppingListToText(plan: MealPlan): string {
  const lines: string[] = [
    `Liste de courses — ${plan.request.meals} repas, ${plan.request.servingsPerMeal} pers.`,
    `Total estimé : ${formatPrice(plan.shoppingList.total)} (budget ${formatPrice(plan.request.budget)})`,
    "",
  ];

  for (const group of plan.shoppingList.byRayon) {
    const buyable = group.lines;
    if (buyable.length === 0) continue;
    lines.push(`${group.rayon.toUpperCase()} — ${formatPrice(group.subtotal)}`);
    for (const line of buyable) lines.push(`  [ ] ${lineLabel(line)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Une désignation par ligne, sans quantité ni prix : le format qui se colle
 * le mieux dans la recherche d'un drive, où l'on saisit un produit à la fois.
 */
export function shoppingListToDriveQueries(plan: MealPlan): string {
  return plan.shoppingList.lines
    .filter((line) => line.packs > 0 && !line.prorated)
    .map((line) => (line.packs > 1 ? `${line.product.name} x${line.packs}` : line.product.name))
    .join("\n");
}

/** Tableur : une ligne par produit, avec le détail du chiffrage. */
export function shoppingListToCsv(plan: MealPlan): string {
  const header = [
    "rayon", "produit", "conditionnement", "quantite_paquets", "prix_unitaire",
    "cout", "besoin_recettes", "surplus", "utilise_par",
  ];

  const rows = plan.shoppingList.lines
    .filter((line) => line.packs > 0 && !line.prorated)
    .map((line) => [
      line.product.rayon,
      line.product.name,
      packLabel(line.product),
      String(line.packs),
      line.product.price.toFixed(2),
      line.cost.toFixed(2),
      quantityLabel(line.neededQuantity, line.product.unit),
      quantityLabel(line.leftoverQuantity, line.product.unit),
      line.usedBy.join(" / "),
    ].map(escapeCsv).join(";"));

  return [header.join(";"), ...rows].join("\n");
}

function escapeCsv(value: string): string {
  return /[;"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Document complet en Markdown : le plan, les recettes, la liste. */
export function planToMarkdown(plan: MealPlan): string {
  const perRecipe = costPerRecipe(plan.recipes, plan.shoppingList);
  const out: string[] = [];

  out.push(`# Plan de repas — ${plan.request.meals} repas pour ${plan.request.servingsPerMeal} personne(s)`);
  out.push("");
  out.push(`- **Budget** : ${formatPrice(plan.request.budget)} · **Total** : ${formatPrice(plan.shoppingList.total)} · **Par portion** : ${formatPrice(costPerServing(plan))}`);
  out.push(`- **Conformité au profil demandé** : ${plan.nutrition.balanceScore}/100 · ${plan.nutrition.kcalPerServing} kcal, ${plan.nutrition.proteinPerServing} g de protéines par portion`);
  out.push(`- **Surplus non consommé** : ${formatPrice(leftoverValue(plan.shoppingList))}`);
  out.push("");

  if (plan.warnings.length > 0) {
    out.push("> **À savoir**");
    for (const warning of plan.warnings) out.push(`> - ${warning}`);
    out.push("");
  }

  out.push("## Liste de courses");
  out.push("");
  for (const group of plan.shoppingList.byRayon) {
    const buyable = group.lines;
    if (buyable.length === 0) continue;
    out.push(`### ${group.rayon} — ${formatPrice(group.subtotal)}`);
    out.push("");
    for (const line of buyable) out.push(`- [ ] ${lineLabel(line)}`);
    out.push("");
  }

  out.push("## Les recettes");
  out.push("");
  for (const recipe of plan.recipes) {
    out.push(`### ${recipe.title}`);
    out.push("");
    if (recipe.description) {
      out.push(`*${recipe.description}*`);
      out.push("");
    }
    out.push(`**${recipe.servings} personne(s)** · ${recipe.prepMinutes} min de préparation · ${recipe.cookMinutes} min de cuisson · environ ${formatPrice(perRecipe.get(recipe.id) ?? 0)}`);
    out.push("");
    out.push("**Ingrédients**");
    out.push("");
    for (const ingredient of recipe.ingredients) {
      out.push(`- ${ingredient.label}${ingredient.optional ? " *(facultatif)*" : ""}`);
    }
    out.push("");
    out.push("**Préparation**");
    out.push("");
    recipe.steps.forEach((step, i) => out.push(`${i + 1}. ${step}`));
    out.push("");
    if (recipe.tips.length > 0) {
      out.push("**Astuces**");
      out.push("");
      for (const tip of recipe.tips) out.push(`- ${tip}`);
      out.push("");
    }
  }

  const engine = plan.provenance.engine === "gemini"
    ? `Gemini (${plan.provenance.model ?? "modèle inconnu"})`
    : "planificateur hors-ligne";
  out.push("---");
  out.push("");
  out.push(`Recettes composées par ${engine}. Prix issus du catalogue local : vérifie-les en rayon, ils bougent.`);

  return out.join("\n");
}

function lineLabel(line: ShoppingLine): string {
  const quantity = line.packs > 1 ? `${line.packs} × ` : "";
  const leftover = line.leftoverQuantity > 0
    ? ` — reste ${quantityLabel(line.leftoverQuantity, line.product.unit)}`
    : "";
  return `${quantity}${line.product.name} (${packLabel(line.product)}) · ${formatPrice(line.cost)}${leftover}`;
}

/** Déclenche le téléchargement d'un contenu texte depuis le navigateur. */
export function download(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
