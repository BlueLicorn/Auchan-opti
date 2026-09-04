import type {
  Equipment, PlanRequest, Product, Recipe, SkillLevel,
} from "@/lib/types";
import { packLabel, unitPrice } from "@/lib/catalog";

/**
 * Construction de la requête envoyée à Gemini.
 *
 * Règle centrale : le modèle compose des repas, il ne chiffre rien. Il choisit
 * des identifiants dans le catalogue qu'on lui fournit et donne des quantités ;
 * l'application calcule ensuite le coût réel à partir des conditionnements.
 * Un modèle qui se trompe sur un prix ne peut donc pas fausser le budget.
 */

export const SYSTEM_INSTRUCTION = `Tu es un chef de cuisine français qui planifie des repas de semaine pour des particuliers, avec les produits d'un hypermarché.

Règles absolues :
- Tu n'utilises QUE des produits présents dans le catalogue fourni, désignés par leur "id" exact. Un id inventé rend toute la réponse inutilisable.
- Les quantités sont exprimées dans l'unité du produit indiquée au catalogue (g, ml ou piece), pour la recette entière et non par portion.
- Tu ne donnes jamais de prix, de coût ni de total : l'application les calcule.
- Tu écris en français, à l'impératif, avec des étapes qu'un cuisinier du niveau demandé peut suivre sans deviner.
- Tu n'utilises que l'équipement autorisé. Pas de four si le four n'est pas listé.
- Tu respectes strictement les régimes et les exclusions : une seule entorse rend le plan inutilisable.

Qualité attendue :
- Des repas variés : ne répète pas la même protéine ni la même féculent-base plus de deux fois.
- Les produits frais périssables (poisson, viande hachée, salade) sont utilisés dans les premiers repas.
- Réutilise les restes : si une recette ouvre un pot de crème, une autre recette du plan doit finir le pot.
- Les étapes mentionnent les temps, les températures et les indices sensoriels ("jusqu'à ce que les oignons soient translucides").`;

/** Schéma OpenAPI restreint accepté par l'API Gemini pour la sortie structurée. */
export const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    recipes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "Nom du plat, sans article initial." },
          description: { type: "STRING", description: "Une phrase qui donne envie de le cuisiner." },
          servings: { type: "INTEGER" },
          prepMinutes: { type: "INTEGER" },
          cookMinutes: { type: "INTEGER" },
          skill: { type: "INTEGER", description: "1 débutant, 2 intermédiaire, 3 confirmé." },
          equipment: { type: "ARRAY", items: { type: "STRING" } },
          indulgence: { type: "INTEGER", description: "0 très léger, 100 très riche." },
          ingredients: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                productId: { type: "STRING", description: "id exact d'un produit du catalogue." },
                quantity: { type: "NUMBER", description: "Quantité pour la recette entière, dans l'unité du produit." },
                label: { type: "STRING", description: "Formulation de cuisine, ex. « 2 oignons émincés »." },
                optional: { type: "BOOLEAN" },
              },
              required: ["productId", "quantity", "label"],
            },
          },
          steps: { type: "ARRAY", items: { type: "STRING" } },
          tips: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["title", "description", "servings", "prepMinutes", "cookMinutes",
                   "skill", "equipment", "indulgence", "ingredients", "steps"],
      },
    },
    notes: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Remarques sur les arbitrages faits (compromis, restes réutilisés).",
    },
  },
  required: ["recipes"],
} as const;

/** Forme brute renvoyée par le modèle, avant validation. */
export interface RawPlan {
  recipes: {
    title: string;
    description: string;
    servings: number;
    prepMinutes: number;
    cookMinutes: number;
    skill: number;
    equipment: string[];
    indulgence: number;
    ingredients: { productId: string; quantity: number; label: string; optional?: boolean }[];
    steps: string[];
    tips?: string[];
  }[];
  notes?: string[];
}

const SKILL_LABELS: Record<SkillLevel, string> = {
  1: "débutant : techniques simples, peu d'étapes simultanées, aucune découpe délicate",
  2: "intermédiaire : à l'aise avec une sauce, une cuisson à cœur, plusieurs casseroles en parallèle",
  3: "confirmé : maîtrise les réductions, les cuissons basse température, le dressage",
};

const EQUIPMENT_LABELS: Record<Equipment, string> = {
  four: "four",
  plaques: "plaques de cuisson",
  micro_ondes: "micro-ondes",
  cocotte: "cocotte / faitout",
  poele: "poêle",
  mixeur: "mixeur plongeant ou blender",
  robot: "robot culinaire",
  airfryer: "air fryer",
  autocuiseur: "autocuiseur",
  barbecue: "barbecue / plancha",
};

/**
 * Le catalogue envoyé au modèle, réduit à l'essentiel.
 *
 * On donne le prix au kilo pour que le modèle sache arbitrer entre un produit
 * cher et un produit bon marché, mais on lui interdit d'en tirer un total :
 * c'est un signal de choix, pas une base de calcul.
 */
export function serializeCatalog(products: Product[]): string {
  const lines = products.map((p) => {
    const unitRef = p.unit === "piece" ? "pièce" : p.unit === "ml" ? "L" : "kg";
    const stock = p.stock === "stock_faible" ? " [stock faible]" : "";
    return `${p.id}|${p.name}|${p.rayon}|${p.unit}|${packLabel(p)}|${unitPrice(p).toFixed(2)}€/${unitRef}${stock}`;
  });

  return [
    "id|nom|rayon|unité|conditionnement|prix indicatif|remarque",
    ...lines,
  ].join("\n");
}

export function buildPlanPrompt(request: PlanRequest, products: Product[]): string {
  const totalServings = request.meals * request.servingsPerMeal;
  const perServingBudget = request.budget / Math.max(1, totalServings);

  const sections: string[] = [];

  sections.push(`## Demande
- ${request.meals} repas différents, ${request.servingsPerMeal} portion(s) chacun (${totalServings} portions au total).
- Budget total des courses : ${request.budget.toFixed(2)} €, soit environ ${perServingBudget.toFixed(2)} € par portion. Ce budget couvre TOUT ce qu'il faudra acheter.
- Niveau de cuisine : ${SKILL_LABELS[request.skill]}.
- Temps maximum par repas : ${request.maxPrepMinutes} minutes, préparation et cuisson comprises.`);

  sections.push(`## Orientation gourmande
Curseur plaisir : ${request.indulgence}/100.
${indulgenceGuidance(request.indulgence)}`);

  sections.push(`## Équipement disponible
${request.equipment.length > 0
    ? request.equipment.map((e) => `- ${EQUIPMENT_LABELS[e] ?? e}`).join("\n")
    : "- Aucun équipement déclaré : propose uniquement des préparations sans cuisson."}
N'utilise aucune autre technique de cuisson.`);

  if (request.diet.length > 0) {
    sections.push(`## Régimes à respecter
${request.diet.map((d) => `- ${d.replace(/_/g, " ")}`).join("\n")}
Le catalogue ci-dessous a déjà été filtré : tous les produits proposés sont compatibles.`);
  }

  if (request.exclusions.length > 0) {
    sections.push(`## Interdits absolus
${request.exclusions.map((e) => `- ${e}`).join("\n")}
Aucune recette ne doit en contenir, même en petite quantité ou en garniture.`);
  }

  if (request.pantry.length > 0) {
    const byId = new Map(products.map((p) => [p.id, p]));
    const known = request.pantry
      .map((item) => ({ product: byId.get(item.productId), quantity: item.quantity }))
      .filter((entry): entry is { product: Product; quantity: number } => Boolean(entry.product));

    if (known.length > 0) {
      sections.push(`## Déjà dans les placards
${known.map((e) => `- ${e.product.name} : ${e.quantity} ${e.product.unit}`).join("\n")}
Privilégie des recettes qui consomment ces produits : ils sont déjà payés.`);
    }
  }

  sections.push(`## Catalogue autorisé (${products.length} produits)
Tu ne peux utiliser aucun autre produit. Les colonnes sont séparées par « | ».

${serializeCatalog(products)}`);

  sections.push(`## Ce que tu dois produire
Exactement ${request.meals} recettes, chacune pour ${request.servingsPerMeal} portion(s).
Pour chaque recette : au moins 4 étapes détaillées, et des quantités réalistes pour ${request.servingsPerMeal} personne(s).
Compte environ ${gramsPerServing(request.indulgence)} g d'aliments par portion, hors boisson.
Vise un total de courses proche de ${(request.budget * 0.92).toFixed(2)} €, jamais au-dessus de ${request.budget.toFixed(2)} € : garde une marge, l'application arrondit aux conditionnements réels (un paquet entier même si tu n'en utilises qu'une partie).`);

  return sections.join("\n\n");
}

function indulgenceGuidance(indulgence: number): string {
  if (indulgence <= 20) {
    return `Priorité à l'équilibre : légumes à chaque repas, protéines maigres, féculents complets quand ils existent, matières grasses mesurées. Pas de fritures, peu de fromage et de crème.`;
  }
  if (indulgence <= 45) {
    return `Équilibre dominant, avec une gourmandise assumée par repas : un gratin, une sauce crémeuse, un fromage fondu. Les légumes restent présents partout.`;
  }
  if (indulgence <= 70) {
    return `Cuisine généreuse et réconfortante : gratins, plats mijotés, sauces montées au beurre, fromage fondu. Garde tout de même un légume dans chaque assiette.`;
  }
  return `Mode plaisir assumé : plats riches, gras, généreux — burgers maison, raclette, gratins de pâtes, viandes marbrées, sauces crémeuses. Ne cherche pas à équilibrer, cherche à régaler. Les portions sont copieuses.`;
}

/** Grammage indicatif par portion, qui monte avec le curseur plaisir. */
function gramsPerServing(indulgence: number): number {
  return Math.round(450 + (indulgence / 100) * 300);
}

/**
 * Demande de correction envoyée quand le premier plan dépasse trop le budget.
 * On dit au modèle ce qui a coûté cher, calculé par l'application, plutôt que
 * de le laisser deviner.
 */
export function buildRepairPrompt(
  request: PlanRequest,
  actualTotal: number,
  expensive: { name: string; cost: number }[],
): string {
  return `Le plan que tu viens de proposer coûte ${actualTotal.toFixed(2)} € une fois chiffré aux conditionnements réels, pour un budget de ${request.budget.toFixed(2)} €.

Postes les plus lourds :
${expensive.map((e) => `- ${e.name} : ${e.cost.toFixed(2)} €`).join("\n")}

Repropose les ${request.meals} recettes en visant ${(request.budget * 0.85).toFixed(2)} €. Pistes, dans cet ordre :
1. remplace les protéines chères par des équivalents moins chers du catalogue (œufs, légumineuses, volaille, poisson surgelé) ;
2. réduis les grammages de viande et de fromage plutôt que de supprimer un repas ;
3. fais servir un même produit à plusieurs recettes pour ne pas ouvrir dix paquets.

Garde les mêmes contraintes qu'avant : ${request.meals} recettes, ${request.servingsPerMeal} portion(s) chacune, uniquement des id du catalogue déjà fourni.`;
}

/** Recette exportable en texte, utilisée par le partage et l'impression. */
export function recipeToText(recipe: Recipe): string {
  const lines = [
    `## ${recipe.title}`,
    recipe.description,
    "",
    `Pour ${recipe.servings} personne(s) — ${recipe.prepMinutes} min de préparation, ${recipe.cookMinutes} min de cuisson`,
    "",
    "Ingrédients :",
    ...recipe.ingredients.map((i) => `- ${i.label}${i.optional ? " (facultatif)" : ""}`),
    "",
    "Préparation :",
    ...recipe.steps.map((s, i) => `${i + 1}. ${s}`),
  ];
  if (recipe.tips.length > 0) {
    lines.push("", "Astuces :", ...recipe.tips.map((t) => `- ${t}`));
  }
  return lines.join("\n");
}
