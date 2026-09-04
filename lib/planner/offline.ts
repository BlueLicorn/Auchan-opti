import type {
  Equipment, IndulgenceLevel, PlanRequest, Product, Recipe,
  RecipeIngredient, SkillLevel,
} from "@/lib/types";
import { gramsToProductQuantity, quantityLabel } from "@/lib/catalog";
import { PANTRY_SHELF_LIFE_DAYS } from "@/lib/planner/cost";

/**
 * Planificateur de repli, sans IA.
 *
 * Il existe pour une raison simple : sans clé Gemini, ou quand l'API tombe,
 * l'application doit toujours produire quelque chose de mangeable. Il travaille
 * par gabarits — une structure de plat dont les emplacements sont remplis avec
 * les produits les moins chers du catalogue qui conviennent.
 *
 * Ce n'est pas de la créativité culinaire : c'est un filet de sécurité qui
 * garantit un plan cohérent, chiffré, et ajusté au budget demandé.
 */

/** Un emplacement à remplir : une famille de produits et une quantité par portion. */
interface Slot {
  /** Catégories acceptables, par ordre de préférence. */
  categories: string[];
  /**
   * Grammes (ou ml) par portion, toujours exprimés au poids. La conversion
   * vers les produits vendus à la pièce est faite au remplissage.
   */
  perServing: number;
  /** Formulation dans la liste d'ingrédients. */
  phrase: (product: Product, quantity: number) => string;
  optional?: boolean;
  /**
   * L'emplacement part en cuisson : les produits qui ne se mangent que crus
   * (salade, concombre, radis) en sont écartés. Sans ce garde-fou, le
   * planificateur met un concombre dans un gratin parce qu'il est bon marché.
   */
  cooked?: boolean;
  /**
   * Nature de l'emplacement, qui détermine comment il réagit à un budget
   * serré. Manger à 1 € la portion, ce n'est pas manger la même assiette en
   * plus petit : c'est moins de protéine animale, plus de féculent, et
   * quasiment plus de fromage ni de crème.
   */
  kind?: "proteine" | "feculent" | "legume" | "extra";
}

interface Template {
  id: string;
  title: (subject: Product) => string;
  /**
   * Emplacement qui donne son nom au plat. Par défaut le premier, mais des
   * pâtes se nomment par leur garniture : « Pâtes aux haricots blancs », pas
   * « Pâtes à la spaghetti ».
   */
  titleSlot?: number;
  description: string;
  skill: SkillLevel;
  equipment: Equipment[];
  prepMinutes: number;
  cookMinutes: number;
  /** Position sur l'axe équilibre / plaisir, sert à choisir les gabarits. */
  indulgence: IndulgenceLevel;
  slots: Slot[];
  steps: (names: Record<string, string>) => string[];
  tips: string[];
}

/** Protéines de repli quand le budget ne permet ni viande ni poisson. */
const REPLIS_PROTEINES = ["legumineuse", "oeuf"];

const grams = (product: Product, quantity: number) => quantityLabel(quantity, product.unit);

/**
 * Mots à h aspiré : « de haricots », pas « d'haricots ». Le h muet, lui,
 * s'élide normalement (« d'huile », « d'herbes »).
 */
const H_ASPIRE = /^(haricot|hareng|homard|houmous|hachis|hamburger)/;

/** « de carottes », « d'ail », « de haricots » : l'élision et ses exceptions. */
function de(name: string): string {
  const lower = name.toLowerCase();
  const elide = /^[aeiouyàâéèêëîïôöùûü]/.test(lower)
    || (lower.startsWith("h") && !H_ASPIRE.test(lower));
  return elide ? `d'${lower}` : `de ${lower}`;
}

/** Formulation standard d'un ingrédient : « 300 g de carottes », « 20 g d'ail ». */
const portion = (product: Product, quantity: number) =>
  `${grams(product, quantity)} ${de(product.name)}`;

const TEMPLATES: Template[] = [
  {
    id: "poelee",
    title: (main) => `Poêlée ${de(main.name)}, légumes et féculent`,
    description: "Un plat complet à la poêle, prêt en une demi-heure, sans vaisselle inutile.",
    skill: 1,
    equipment: ["poele", "plaques"],
    prepMinutes: 10,
    cookMinutes: 20,
    indulgence: 25,
    slots: [
      { categories: ["poulet", "dinde", "boeuf", "poisson-blanc", "vegetal", "oeuf", "legumineuse"], perServing: 150, kind: "proteine", phrase: portion },
      { categories: ["pates", "riz", "graine", "feculent-frais"], perServing: 90, kind: "feculent", phrase: portion },
      { categories: ["legume", "legume-surgele"], perServing: 200, kind: "legume", cooked: true, phrase: portion },
      { categories: ["aromate"], perServing: 40, phrase: portion },
      { categories: ["matiere-grasse"], perServing: 10, phrase: portion },
      { categories: ["epice"], perServing: 2, phrase: portion, optional: true },
    ],
    steps: (n) => [
      `Faire chauffer ${n.s4 ?? "un filet d'huile"} dans une grande poêle à feu vif.`,
      `Émincer ${n.s3 ?? "l'aromate"}, puis faire suer 2 minutes jusqu'à ce que les morceaux deviennent translucides.`,
      `Ajouter ${n.s0 ?? "la protéine"} et saisir 5 à 7 minutes en remuant, jusqu'à coloration.`,
      `Pendant ce temps, cuire ${n.s1 ?? "le féculent"} selon les indications du paquet, puis égoutter.`,
      `Ajouter ${n.s2 ?? "les légumes"} dans la poêle, baisser le feu et cuire 8 minutes à couvert.`,
      `Réunir le féculent et la poêlée, assaisonner, et servir immédiatement.`,
    ],
    tips: ["Réserver une louche d'eau de cuisson du féculent : elle lie la poêlée sans matière grasse."],
  },
  {
    id: "mijote",
    title: (main) => `Mijoté ${de(main.name)} aux légumes`,
    description: "Un mijoté qui se fait tout seul et qui est meilleur réchauffé le lendemain.",
    skill: 2,
    equipment: ["cocotte", "plaques"],
    prepMinutes: 20,
    cookMinutes: 60,
    indulgence: 45,
    slots: [
      { categories: ["boeuf", "porc", "agneau", "poulet", "legumineuse"], perServing: 160, kind: "proteine", phrase: portion },
      { categories: ["legume"], perServing: 180, kind: "legume", cooked: true, phrase: portion },
      { categories: ["conserve-legume"], perServing: 120, phrase: portion },
      { categories: ["aromate"], perServing: 40, phrase: portion },
      { categories: ["epice"], perServing: 2, phrase: portion },
      { categories: ["feculent-frais", "riz", "pates"], perServing: 80, kind: "feculent", phrase: portion },
    ],
    steps: (n) => [
      `Couper ${n.s0 ?? "la viande"} en gros cubes, puis faire dorer dans la cocotte sur toutes les faces, sans rien bouger trop tôt.`,
      `Réserver, puis faire suer ${n.s3 ?? "les aromates"} finement émincé dans le même gras pendant 5 minutes.`,
      `Remettre la viande, ajouter ${n.s2 ?? "les tomates"} et ${n.s1 ?? "les légumes"} coupés en morceaux réguliers.`,
      `Assaisonner avec ${n.s4 ?? "les épices"}, couvrir d'eau à hauteur, porter à frémissement.`,
      `Couvrir et laisser mijoter 1 heure à feu doux, en remuant toutes les 20 minutes.`,
      `Cuire ${n.s5 ?? "l'accompagnement"} en fin de cuisson et servir bien chaud.`,
    ],
    tips: [
      "Le mijoté se garde 3 jours au réfrigérateur et gagne en goût.",
      "Si la sauce reste liquide, retirer le couvercle les 15 dernières minutes.",
    ],
  },
  {
    id: "gratin",
    title: (main) => `Gratin de ${main.name.toLowerCase()}`,
    description: "Le plat qui met tout le monde d'accord : fondant dessous, gratiné dessus.",
    skill: 1,
    equipment: ["four"],
    prepMinutes: 20,
    cookMinutes: 40,
    indulgence: 70,
    slots: [
      { categories: ["feculent-frais"], perServing: 250, kind: "feculent", cooked: true, phrase: portion },
      { categories: ["fromage"], perServing: 60, kind: "extra", phrase: portion },
      { categories: ["creme"], perServing: 80, kind: "extra", phrase: portion },
      { categories: ["porc", "charcuterie", "poulet", "legume"], perServing: 90, kind: "proteine", cooked: true, phrase: portion },
      { categories: ["aromate"], perServing: 20, phrase: portion },
      { categories: ["beurre"], perServing: 10, kind: "extra", phrase: portion, optional: true },
    ],
    steps: (n) => [
      `Préchauffer le four à 190 °C.`,
      `Émincer finement ${n.s0 ?? "la base"} en tranches de 3 mm, et ${n.s4 ?? "l'aromate"} en lamelles.`,
      `Faire revenir ${n.s3 ?? "la garniture"} 5 minutes à la poêle pour bien colorer.`,
      `Frotter un plat à gratin, y ranger les couches en alternant base et garniture, saler et poivrer entre chaque étage.`,
      `Verser ${n.s2 ?? "la crème"} sur l'ensemble, couvrir de ${n.s1 ?? "fromage"} râpé.`,
      `Enfourner 40 minutes : le dessus doit être doré et la pointe d'un couteau doit traverser sans résistance.`,
      `Laisser reposer 10 minutes hors du four avant de servir, le gratin se tient mieux.`,
    ],
    tips: ["Couvrir de papier cuisson les 20 premières minutes si le dessus colore trop vite."],
  },
  {
    id: "pates",
    title: (garniture) => `Pâtes et ${garniture.name.toLowerCase()}`,
    titleSlot: 1,
    description: "Une sauce simple, des pâtes al dente, et le repas est réglé en 25 minutes.",
    skill: 1,
    equipment: ["plaques", "poele"],
    prepMinutes: 10,
    cookMinutes: 15,
    indulgence: 55,
    slots: [
      { categories: ["pates"], perServing: 110, kind: "feculent", phrase: portion },
      { categories: ["charcuterie", "boeuf", "poulet", "legumineuse", "vegetal", "conserve-poisson"], perServing: 100, kind: "proteine", phrase: portion },
      { categories: ["conserve-legume"], perServing: 150, phrase: portion },
      { categories: ["fromage"], perServing: 35, kind: "extra", phrase: portion },
      { categories: ["aromate"], perServing: 25, phrase: portion },
      { categories: ["herbe"], perServing: 4, phrase: portion, optional: true },
    ],
    steps: (n) => [
      `Porter une grande casserole d'eau généreusement salée à ébullition.`,
      `Faire revenir ${n.s4 ?? "l'aromate"}, haché finement, 3 minutes dans un filet d'huile, sans laisser brûler.`,
      `Ajouter ${n.s1 ?? "la garniture"} et faire colorer 5 minutes.`,
      `Verser ${n.s2 ?? "la tomate"}, assaisonner et laisser réduire 10 minutes à feu moyen.`,
      `Cuire ${n.s0 ?? "les pâtes"} une minute de moins que le temps indiqué, puis les égoutter en gardant un verre d'eau de cuisson.`,
      `Réunir pâtes et sauce dans la poêle, ajouter un peu d'eau de cuisson et ${n.s3 ?? "le fromage"}, faire sauter 1 minute pour lier.`,
    ],
    tips: ["L'eau de cuisson, chargée en amidon, remplace la crème pour rendre la sauce onctueuse."],
  },
  {
    id: "roti-four",
    title: (main) => `${main.name} au four et légumes rôtis`,
    description: "Tout part au four sur une seule plaque : peu de travail, beaucoup de goût.",
    skill: 1,
    equipment: ["four"],
    prepMinutes: 15,
    cookMinutes: 45,
    indulgence: 40,
    slots: [
      { categories: ["poulet", "porc", "poisson-blanc", "vegetal"], perServing: 180, kind: "proteine", phrase: portion },
      { categories: ["feculent-frais"], perServing: 200, kind: "feculent", phrase: portion },
      { categories: ["legume"], perServing: 150, kind: "legume", cooked: true, phrase: portion },
      { categories: ["matiere-grasse"], perServing: 12, phrase: portion },
      { categories: ["epice"], perServing: 3, phrase: portion },
      { categories: ["aromate"], perServing: 15, phrase: portion },
    ],
    steps: (n) => [
      `Préchauffer le four à 200 °C.`,
      `Couper ${n.s1 ?? "les féculents"} et ${n.s2 ?? "les légumes"} en morceaux de taille égale, pour une cuisson homogène.`,
      `Les étaler sur une plaque, arroser de ${n.s3 ?? "matière grasse"}, saupoudrer de ${n.s4 ?? "épices"}, mélanger à la main.`,
      `Poser ${n.s0 ?? "la pièce principale"} au centre, saler, poivrer, ajouter ${n.s5 ?? "l'aromate"} en morceaux.`,
      `Enfourner 45 minutes en remuant les légumes à mi-cuisson.`,
      `Vérifier la cuisson au couteau, puis laisser reposer 5 minutes avant de servir.`,
    ],
    tips: ["Ne pas entasser : si la plaque est pleine, les légumes cuisent à la vapeur au lieu de rôtir."],
  },
  {
    id: "salade-complete",
    title: (main) => `Salade complète ${de(main.name)}`,
    description: "Fraîche, rapide, sans cuisson : la solution des soirs sans envie de cuisiner.",
    skill: 1,
    equipment: [],
    prepMinutes: 15,
    cookMinutes: 0,
    indulgence: 15,
    slots: [
      { categories: ["conserve-poisson", "charcuterie", "fromage", "legumineuse", "oeuf"], perServing: 90, kind: "proteine", phrase: portion },
      { categories: ["legume"], perServing: 200, kind: "legume", phrase: portion },
      { categories: ["graine", "legumineuse", "pates"], perServing: 70, kind: "feculent", phrase: portion },
      { categories: ["matiere-grasse"], perServing: 12, phrase: portion },
      { categories: ["condiment"], perServing: 8, phrase: portion },
      { categories: ["herbe"], perServing: 4, phrase: portion, optional: true },
    ],
    steps: (n) => [
      `Rincer et sécher ${n.s1 ?? "les légumes"}, puis couper en morceaux qui tiennent sur une fourchette.`,
      `Préparer ${n.s2 ?? "la base"} : rincer si c'est une conserve, ou cuire puis refroidir sous l'eau froide.`,
      `Émietter ou trancher ${n.s0 ?? "la protéine"}, puis répartir sur le dessus.`,
      `Fouetter ${n.s4 ?? "le condiment"} avec ${n.s3 ?? "l'huile"}, une pincée de sel et du poivre.`,
      `Verser la vinaigrette au dernier moment et mélanger délicatement pour ne pas écraser les ingrédients.`,
    ],
    tips: ["Assaisonner juste avant de servir : une salade assaisonnée trop tôt rend son eau."],
  },
  {
    id: "plaisir-fondant",
    title: (main) => `${main.name} façon plaisir, sauce crémeuse`,
    description: "Généreux, fondant, sans complexe : le repas qu'on attend toute la semaine.",
    skill: 2,
    equipment: ["poele", "plaques"],
    prepMinutes: 15,
    cookMinutes: 25,
    indulgence: 88,
    slots: [
      { categories: ["boeuf", "porc", "poulet", "charcuterie"], perServing: 200, kind: "proteine", phrase: portion },
      { categories: ["creme"], perServing: 90, kind: "extra", phrase: portion },
      { categories: ["fromage"], perServing: 60, phrase: portion },
      { categories: ["feculent-surgele", "feculent-frais", "pates"], perServing: 200, kind: "feculent", phrase: portion },
      { categories: ["aromate"], perServing: 30, phrase: portion },
      { categories: ["beurre"], perServing: 15, kind: "extra", phrase: portion },
    ],
    steps: (n) => [
      `Sortir ${n.s0 ?? "la viande"} 20 minutes avant : la cuisson sera plus régulière.`,
      `Faire fondre ${n.s5 ?? "le beurre"} dans une poêle large et saisir la viande à feu vif, 3 minutes par face, sans y toucher.`,
      `Réserver au chaud sous une feuille d'aluminium.`,
      `Dans la même poêle, faire suer ${n.s4 ?? "l'échalote"} hachée, puis déglacer avec un fond d'eau en grattant les sucs.`,
      `Verser ${n.s1 ?? "la crème"}, laisser réduire 5 minutes, ajouter ${n.s2 ?? "le fromage"} et remuer jusqu'à ce qu'il soit fondu.`,
      `Cuire ${n.s3 ?? "l'accompagnement"} pendant ce temps, napper la viande de sauce et servir sans attendre.`,
    ],
    tips: [
      "Les sucs collés au fond de la poêle sont le goût de la sauce : ne pas les laisser brûler.",
      "Un tour de moulin à poivre au moment de servir réveille l'ensemble.",
    ],
  },
  {
    id: "soupe-repas",
    title: (main) => `Soupe repas ${de(main.name)}`,
    description: "Une soupe assez consistante pour tenir jusqu'au lendemain, économique par nature.",
    skill: 1,
    equipment: ["cocotte", "plaques", "mixeur"],
    prepMinutes: 15,
    cookMinutes: 30,
    indulgence: 20,
    slots: [
      { categories: ["legume"], perServing: 300, kind: "legume", cooked: true, phrase: portion },
      { categories: ["legumineuse", "graine", "riz"], perServing: 60, kind: "proteine", phrase: portion },
      { categories: ["aromate"], perServing: 40, phrase: portion },
      { categories: ["epice"], perServing: 4, phrase: portion },
      { categories: ["creme", "lait"], perServing: 40, phrase: portion, optional: true },
      { categories: ["pain"], perServing: 60, kind: "feculent", phrase: portion },
    ],
    steps: (n) => [
      `Éplucher et couper ${n.s0 ?? "les légumes"} en morceaux grossiers, l'aspect final importe peu.`,
      `Faire revenir ${n.s2 ?? "l'oignon"} 5 minutes dans un filet d'huile au fond de la cocotte.`,
      `Ajouter les légumes, ${n.s1 ?? "la légumineuse"} rincée et ${n.s3 ?? "les épices"}, couvrir d'eau à deux centimètres au-dessus.`,
      `Porter à ébullition puis laisser cuire 30 minutes à couvert, jusqu'à ce que tout s'écrase à la fourchette.`,
      `Mixer par à-coups pour garder un peu de texture, rectifier le sel.`,
      `Servir avec ${n.s5 ?? "du pain"} grillé.`,
    ],
    tips: ["La soupe se congèle en portions : de quoi couvrir un repas de la semaine suivante."],
  },
];

/**
 * Compose un plan complet à partir des gabarits.
 * Les gabarits sont choisis par proximité avec le curseur plaisir, puis les
 * emplacements remplis avec les produits les moins chers disponibles, en
 * évitant de reprendre deux fois la même pièce principale.
 */
/**
 * Tension budgétaire, de 0 (large) à 1 (au ras des pâquerettes).
 *
 * Le seuil haut est fixé à 2,50 € la portion : au-delà, on cuisine sans se
 * contraindre. En dessous de 0,80 €, la pression est maximale — et même là,
 * le plan sera peut-être trop cher : c'est alors à l'application de le dire,
 * pas au planificateur de faire semblant.
 */
export function budgetPressure(request: PlanRequest): number {
  const servings = Math.max(1, request.meals * request.servingsPerMeal);
  const target = request.budget / servings;
  return Math.max(0, Math.min(1, (2.5 - target) / 1.7));
}

/**
 * Facteur appliqué au grammage d'un emplacement selon la tension budgétaire.
 *
 * Ces coefficients décrivent une manière de manger, pas une simple réduction :
 * sous contrainte, la protéine animale et le gras reculent, le féculent avance
 * pour que l'assiette reste pleine, et le légume tient presque sa place.
 */
function budgetScale(kind: Slot["kind"], pressure: number): number {
  switch (kind) {
    case "proteine": return 1 - 0.45 * pressure;
    case "extra": return 1 - 0.75 * pressure;
    case "feculent": return 1 + 0.3 * pressure;
    case "legume": return 1 - 0.15 * pressure;
    default: return 1 - 0.2 * pressure;
  }
}

export function planOffline(request: PlanRequest, pool: Product[]): Recipe[] {
  const pressure = budgetPressure(request);
  const usable = TEMPLATES.filter((template) =>
    template.equipment.every((e) => request.equipment.includes(e))
    && template.skill <= request.skill
    && template.prepMinutes + template.cookMinutes <= request.maxPrepMinutes,
  );

  const candidates = (usable.length > 0 ? usable : TEMPLATES.filter((t) => t.equipment.length === 0))
    .slice()
    .sort((a, b) => Math.abs(a.indulgence - request.indulgence) - Math.abs(b.indulgence - request.indulgence));

  if (candidates.length === 0) return [];

  const byCategory = new Map<string, Product[]>();
  for (const product of pool) {
    if (product.stock === "rupture") continue;
    const bucket = byCategory.get(product.category) ?? [];
    bucket.push(product);
    byCategory.set(product.category, bucket);
  }

  const recipes: Recipe[] = [];
  const usedMains = new Set<string>();
  /** Nombre de recettes déjà bâties sur chaque produit, pour varier les plats. */
  const usageCount = new Map<string, number>();
  /**
   * Quantité déjà engagée sur chaque produit par les recettes précédentes.
   *
   * C'est ce qui permet de raisonner en coût marginal : quand 500 g de pâtes
   * sont déjà achetés et qu'il en reste 280, la recette suivante qui en prend
   * 110 g ne coûte rien de plus. Sans cela, le planificateur croit rouvrir un
   * paquet à chaque plat et s'interdit des menus pourtant abordables.
   */
  const committed = new Map<string, number>();

  for (let i = 0; i < request.meals; i++) {
    const template = candidates[i % candidates.length];
    const recipe = fillTemplate(
      template, i, request, byCategory, usedMains, usageCount, committed, pressure,
    );
    if (recipe) {
      recipes.push(recipe);
      const main = recipe.ingredients[0];
      // À budget serré, s'interdire de refaire un plat sur la même base est un
      // luxe : c'est justement la répétition qui amortit les paquets.
      if (main && pressure < 0.6) usedMains.add(main.productId);
      for (const ingredient of recipe.ingredients) {
        usageCount.set(ingredient.productId, (usageCount.get(ingredient.productId) ?? 0) + 1);
        committed.set(
          ingredient.productId,
          (committed.get(ingredient.productId) ?? 0) + ingredient.quantity,
        );
      }
    }
  }

  return recipes;
}

function fillTemplate(
  template: Template,
  index: number,
  request: PlanRequest,
  byCategory: Map<string, Product[]>,
  usedMains: Set<string>,
  usageCount: Map<string, number>,
  committed: Map<string, number>,
  pressure: number,
): Recipe | undefined {
  const ingredients: RecipeIngredient[] = [];
  const names: Record<string, string> = {};
  /** Produit qui donnera son nom au plat. */
  let mainProduct: Product | undefined;
  /** Produits déjà retenus ici : une liste d'ingrédients ne se répète pas. */
  const chosen = new Set<string>();

  for (const [slotIndex, slot] of template.slots.entries()) {
    // Le grammage suit le budget : c'est le levier le plus puissant, bien
    // avant le choix du produit.
    const needed = slot.perServing
      * budgetScale(slot.kind, pressure)
      * request.servingsPerMeal;
    // Un accompagnement facultatif est le premier sacrifice d'un budget serré.
    if (slot.optional && pressure > 0.5) continue;

    const product = pickProduct(
      slot, needed, byCategory,
      slotIndex === 0 ? usedMains : new Set(),
      usageCount,
      committed,
      chosen,
      pressure,
    );
    if (!product) {
      if (slot.optional) continue;
      // Un emplacement obligatoire vide rend la recette bancale : on l'abandonne
      // plutôt que de produire un plat sans protéine ni féculent.
      if (slotIndex <= 1) return undefined;
      continue;
    }

    chosen.add(product.id);
    if (slotIndex === (template.titleSlot ?? 0)) mainProduct = product;

    const quantity = roundQuantity(gramsToProductQuantity(needed, product), product);
    names[`s${slotIndex}`] = product.name.toLowerCase();
    ingredients.push({
      productId: product.id,
      quantity,
      label: slot.phrase(product, quantity),
      ...(slot.optional ? { optional: true } : {}),
    });
  }

  if (!mainProduct || ingredients.length < 2) return undefined;

  const title = template.title(mainProduct);
  return {
    id: `off${index + 1}-${template.id}`,
    title,
    description: template.description,
    servings: request.servingsPerMeal,
    prepMinutes: template.prepMinutes,
    cookMinutes: template.cookMinutes,
    skill: template.skill,
    equipment: template.equipment,
    ingredients,
    steps: template.steps(names),
    tips: template.tips,
    diet: intersectDiet(ingredients, byCategory),
    indulgence: template.indulgence,
  };
}

/**
 * Choisit le produit qui coûte le moins cher POUR LA QUANTITÉ NÉCESSAIRE.
 *
 * Le prix au kilo est un piège : un poulet entier à 5,35 €/kg est moins cher
 * au kilo que des cuisses à 5,54 €/kg, mais si la recette n'a besoin que de
 * 360 g, le poulet entier coûte 7,49 € et les cuisses 4,99 €. Ce qui compte,
 * c'est le prix du plus petit nombre de conditionnements qui couvre le besoin,
 * et le gâchis que ce choix entraîne.
 */
function pickProduct(
  slot: Slot,
  neededGrams: number,
  byCategory: Map<string, Product[]>,
  avoid: Set<string>,
  usageCount: Map<string, number>,
  committed: Map<string, number>,
  chosen: Set<string>,
  pressure: number,
): Product | undefined {
  let best: { product: Product; score: number } | undefined;

  // Sous forte contrainte, un emplacement protéiné peut se replier sur des
  // légumineuses même si le gabarit ne les listait pas : c'est ce qu'on fait
  // réellement quand la viande ne rentre pas dans le budget.
  const categories = slot.kind === "proteine" && pressure > 0.55
    ? [...slot.categories, ...REPLIS_PROTEINES.filter((c) => !slot.categories.includes(c))]
    : slot.categories;

  // Toutes les catégories acceptables sont évaluées, avec une légère prime à
  // celles listées en premier : mieux vaut une escalope de dinde bien
  // dimensionnée qu'un poulet dont on jettera les deux tiers.
  for (const [rank, category] of categories.entries()) {
    const bucket = byCategory.get(category);
    if (!bucket?.length) continue;

    for (const product of bucket) {
      if (slot.cooked && product.readyToEat) continue;
      if (chosen.has(product.id)) continue;

      const quantity = gramsToProductQuantity(neededGrams, product);

      // Coût marginal : ce que ce choix ajoute réellement au panier, compte
      // tenu des paquets déjà ouverts par les recettes précédentes.
      const dejaEngage = committed.get(product.id) ?? 0;
      const packsAvant = Math.ceil(dejaEngage / product.packSize);
      const packs = Math.ceil((dejaEngage + quantity) / product.packSize) - packsAvant;
      const cost = packs * product.price;

      const bought = packs * product.packSize;
      const wasteRatio = bought > 0 ? (bought - quantity) / bought : 0;

      // Sur un produit frais, le surplus est perdu : il compte pour son prix
      // plein. Sur un produit de garde, il rejoint le placard et ne coûte rien.
      const perishable = product.shelfLifeDays <= PANTRY_SHELF_LIFE_DAYS;

      // Le coût marginal récompense déjà la réutilisation. Cette pénalité ne
      // sert plus qu'à la variété du menu, et s'efface quand le budget serre.
      const repetition = 1 + (usageCount.get(product.id) ?? 0) * 0.4 * (1 - pressure);

      const score = cost * (1 + (perishable ? wasteRatio : 0))
        * (1 + rank * 0.03)
        * repetition
        + (avoid.has(product.id) ? 1000 : 0);

      if (!best || score < best.score) best = { product, score };
    }
  }

  if (best && best.score < 1000) return best.product;

  // Tout est déjà utilisé ailleurs : on accepte la répétition plutôt que de
  // rendre une recette incomplète.
  return best?.product;
}

function roundQuantity(quantity: number, product: Product): number {
  if (product.unit === "piece") return Math.max(1, Math.round(quantity));
  const step = quantity >= 500 ? 50 : quantity >= 100 ? 10 : 5;
  return Math.max(step, Math.round(quantity / step) * step);
}

function intersectDiet(ingredients: RecipeIngredient[], byCategory: Map<string, Product[]>) {
  const all = [...byCategory.values()].flat();
  const byId = new Map(all.map((p) => [p.id, p]));
  const products = ingredients
    .map((i) => byId.get(i.productId))
    .filter((p): p is Product => Boolean(p));
  if (products.length === 0) return [];
  return products[0].diet.filter((tag) => products.every((p) => p.diet.includes(tag)));
}
