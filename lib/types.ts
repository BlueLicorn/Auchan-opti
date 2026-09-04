/**
 * Modèle de données central de Auchan-Opti.
 *
 * Deux principes guident ces types :
 *  1. Le coût est calculé de façon déterministe à partir du catalogue,
 *     jamais estimé par l'IA. L'IA compose des repas, l'application chiffre.
 *  2. Tout ce qui vient d'une source externe (IA, CSV, API) est validé
 *     avant d'entrer dans le moteur.
 */

/** Rayons tels qu'on les parcourt physiquement en magasin, dans l'ordre. */
export const RAYONS = [
  "Fruits & Légumes",
  "Boucherie",
  "Volaille",
  "Poissonnerie",
  "Charcuterie & Traiteur",
  "Crémerie",
  "Boulangerie",
  "Épicerie salée",
  "Épicerie sucrée",
  "Surgelés",
  "Boissons",
  "Monde & Apéritif",
] as const;

export type Rayon = (typeof RAYONS)[number];

/** Unité de mesure d'un ingrédient dans une recette. */
export type Unit = "g" | "ml" | "piece";

/** Régimes et contraintes que le moteur sait filtrer. */
export const DIET_TAGS = [
  "vegetarien",
  "vegan",
  "sans_porc",
  "sans_gluten",
  "sans_lactose",
  "sans_fruits_a_coque",
  "halal_compatible",
] as const;

export type DietTag = (typeof DIET_TAGS)[number];

/** Équipement de cuisine conditionnant les recettes proposées. */
export const EQUIPMENT = [
  "four",
  "plaques",
  "micro_ondes",
  "cocotte",
  "poele",
  "mixeur",
  "robot",
  "airfryer",
  "autocuiseur",
  "barbecue",
] as const;

export type Equipment = (typeof EQUIPMENT)[number];

/** Valeurs nutritionnelles pour 100 g (ou 100 ml) de produit. */
export interface Nutrition {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  salt: number;
}

/**
 * Disponibilité en rayon.
 *
 * « inconnu » est l'état par défaut et ce n'est pas un détail : le catalogue
 * embarqué ne sait rien du stock d'un magasin donné. Afficher « en rayon »
 * sans l'avoir constaté serait une information inventée.
 */
export type StockStatus = "inconnu" | "en_rayon" | "stock_faible" | "rupture";

/**
 * D'où vient une donnée de prix ou de stock.
 *
 * Distinguer un relevé d'une estimation est la différence entre une liste
 * qu'on peut opposer à la caisse et une liste approximative. L'interface
 * affiche cette provenance partout où le chiffre est montré.
 */
export type DataSource =
  /** Relevé indicatif livré avec l'application. Plausible, pas exact. */
  | "estimation"
  /** Importé depuis un fichier CSV fourni par l'utilisateur. */
  | "import"
  /** Relevé sur le site Auchan par le collecteur, dans le navigateur. */
  | "collecte"
  /**
   * Base de prix ouverte Open Prices (Open Food Facts) : un prix saisi par
   * quelqu'un d'autre, dans un magasin identifié, à une date donnée. Fiable
   * dans son principe, mais ce n'est ni ton relevé ni forcément ton magasin.
   */
  | "communaute"
  /** Saisi à la main, en rayon ou depuis les réglages. */
  | "saisie";

/** Une donnée datée et sourcée, pour que l'interface sache quoi en dire. */
export interface Provenance {
  source: DataSource;
  /** Date du relevé, ISO 8601 court (AAAA-MM-JJ). */
  at: string;
  /** Magasin concerné, quand la source le précise. */
  store?: string;
}

/**
 * Un produit tel qu'il est vendu : un conditionnement, un prix, un rayon.
 *
 * `packSize` est exprimé dans `unit`. Un paquet de pâtes de 500 g est donc
 * { unit: "g", packSize: 500, price: 1.15 }. C'est cette granularité qui
 * permet de chiffrer juste : on n'achète pas 350 g de pâtes, on achète un
 * paquet de 500 g et il reste 150 g.
 */
export interface Product {
  id: string;
  name: string;
  rayon: Rayon;
  /** Sous-famille utilisée pour les substitutions (« pates », « poulet »…). */
  category: string;
  brandTier: "mdd" | "national" | "premium" | "bio";
  unit: Unit;
  packSize: number;
  /** Prix du conditionnement, en euros TTC. */
  price: number;
  /** Origine et date du prix ci-dessus. */
  priceFrom: Provenance;
  /** Étiquettes de régime satisfaites par le produit. */
  diet: DietTag[];
  /** Valeurs pour 100 g / 100 ml. Absent pour les produits non alimentaires. */
  nutrition?: Nutrition;
  /** Durée de conservation après achat, en jours. Sert à éviter le gâchis. */
  shelfLifeDays: number;
  /** Disponibilité constatée, « inconnu » tant que rien ne l'a été. */
  stock: StockStatus;
  /** Origine et date du statut ci-dessus. Absent tant que le stock est inconnu. */
  stockFrom?: Provenance;
  /** Rend le produit consommable tel quel (sert au mode dépannage). */
  readyToEat?: boolean;
  /** Code-barres, quand il est connu, pour l'enrichissement Open Food Facts. */
  ean?: string;
}

/** Le catalogue tel que chargé, avec sa provenance. */
export interface Catalog {
  products: Product[];
  source: CatalogSourceId;
  /** Date de dernière mise à jour des prix, ISO 8601. */
  updatedAt: string;
  /** Nom du magasin auquel ces prix se rapportent, si connu. */
  storeLabel?: string;
}

export type CatalogSourceId = "seed" | "csv" | "openfoodfacts" | "custom";

// ---------------------------------------------------------------------------
// Entrées utilisateur
// ---------------------------------------------------------------------------

/** Le curseur plaisir : 0 = strictement équilibré, 100 = gros porc assumé. */
export type IndulgenceLevel = number;

/** Niveau de cuisine, du débutant au cuisinier confirmé. */
export type SkillLevel = 1 | 2 | 3;

export interface PlanRequest {
  /** Budget total en euros pour l'ensemble des courses. */
  budget: number;
  /** Nombre de repas à couvrir. */
  meals: number;
  /** Nombre de couverts par repas. */
  servingsPerMeal: number;
  skill: SkillLevel;
  /** 0 → 100. Voir IndulgenceLevel. */
  indulgence: IndulgenceLevel;
  equipment: Equipment[];
  diet: DietTag[];
  /** Ingrédients à bannir, en texte libre (allergies, dégoûts). */
  exclusions: string[];
  /** Temps de préparation maximum par repas, en minutes. */
  maxPrepMinutes: number;
  /** Produits déjà présents dans les placards, à ne pas racheter. */
  pantry: PantryItem[];
}

export interface PantryItem {
  productId: string;
  /** Quantité disponible, dans l'unité du produit. */
  quantity: number;
}

// ---------------------------------------------------------------------------
// Sortie du planificateur
// ---------------------------------------------------------------------------

/** Un ingrédient d'une recette, lié à un produit réel du catalogue. */
export interface RecipeIngredient {
  productId: string;
  /** Quantité nécessaire pour la recette entière, dans l'unité du produit. */
  quantity: number;
  /** Libellé tel qu'il apparaît dans la recette (« 2 oignons émincés »). */
  label: string;
  /** Un ingrédient optionnel n'est pas ajouté à la liste de courses. */
  optional?: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  /** Une phrase qui donne envie, pas un résumé technique. */
  description: string;
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  skill: SkillLevel;
  equipment: Equipment[];
  ingredients: RecipeIngredient[];
  /** Étapes détaillées, rédigées à l'impératif. */
  steps: string[];
  /** Astuces, variantes, conseils de conservation. */
  tips: string[];
  diet: DietTag[];
  /** Classement sur l'axe équilibre / plaisir, 0 → 100. */
  indulgence: IndulgenceLevel;
}

/** Une ligne de la liste de courses : un produit, un nombre de paquets. */
export interface ShoppingLine {
  product: Product;
  /** Nombre de conditionnements à acheter. */
  packs: number;
  /** Quantité réellement consommée par les recettes. */
  neededQuantity: number;
  /** Quantité achetée mais non utilisée (packs * packSize - needed). */
  leftoverQuantity: number;
  /** Coût de la ligne : packs * price. */
  cost: number;
  /** Recettes qui consomment ce produit. */
  usedBy: string[];
  /** Quantité couverte par les placards, donc non achetée. */
  fromPantry: number;
  /**
   * Ligne facturée au prorata parce qu'elle relève du fond de placard.
   * Elle compte dans le budget mais ne se met pas au panier telle quelle :
   * on n'achète pas 0,17 € d'huile.
   */
  prorated?: boolean;
}

export interface ShoppingList {
  lines: ShoppingLine[];
  total: number;
  /** Lignes groupées par rayon, dans l'ordre de parcours du magasin. */
  byRayon: { rayon: Rayon; lines: ShoppingLine[]; subtotal: number }[];
}

/** Bilan nutritionnel moyen d'un plan, par portion. */
export interface NutritionSummary {
  kcalPerServing: number;
  proteinPerServing: number;
  carbsPerServing: number;
  fatPerServing: number;
  fiberPerServing: number;
  saltPerServing: number;
  /**
   * Conformité 0 → 100 au profil demandé, calculée par lib/planner/scoring.ts.
   * Ce n'est pas une note de santé : un plan volontairement riche peut y
   * atteindre 100 parce qu'il fait exactement ce qu'on lui a demandé.
   */
  balanceScore: number;
}

export interface MealPlan {
  recipes: Recipe[];
  shoppingList: ShoppingList;
  nutrition: NutritionSummary;
  request: PlanRequest;
  /** Écarts constatés entre la demande et ce qui a pu être produit. */
  warnings: string[];
  /**
   * Produits proposés pour employer le budget restant. Un plan qui rend la
   * moitié du budget n'a pas répondu à la demande : autant le dire et proposer
   * quoi en faire, plutôt que de laisser l'utilisateur croire que c'est tout.
   */
  suggestions: Product[];
  /** Décrit comment le plan a été obtenu (IA, hors-ligne, réparé…). */
  provenance: {
    engine: "gemini" | "offline";
    model?: string;
    repairs: string[];
  };
}
