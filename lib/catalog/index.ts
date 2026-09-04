import rawCatalog from "@/data/catalog.json";
import type {
  Catalog, DietTag, Product, Rayon, Unit,
} from "@/lib/types";
import { RAYONS } from "@/lib/types";

/** Le catalogue livré avec l'application, servant de repli permanent. */
export const seedCatalog = rawCatalog as unknown as Catalog;

/** Index produit par identifiant, construit une fois par catalogue. */
export function indexById(catalog: Catalog): Map<string, Product> {
  return new Map(catalog.products.map((p) => [p.id, p]));
}

/**
 * Poids moyen d'une pièce, par catégorie.
 *
 * Approximation assumée, mais indispensable : sans elle, « 300 g de légumes »
 * appliqué à un concombre vendu à la pièce donne 300 concombres. Toute
 * conversion entre une quantité de recette et un produit vendu à l'unité
 * passe par ici.
 */
export function averagePieceWeight(product: Product): number {
  switch (product.category) {
    case "oeuf": return 55;
    case "pain": return normalize(product.name).includes("baguette") ? 250 : 60;
    case "viennoiserie": return 60;
    case "herbe": return 20;
    case "aromate": return 60;
    case "agrume": return 100;
    case "fruit": return 130;
    case "legume": return 250;
    default: return 150;
  }
}

/**
 * Prix ramené au kilo pour TOUS les produits, pièces comprises.
 * C'est la seule comparaison honnête entre un concombre à la pièce et des
 * carottes au kilo ; `unitPrice` compare des choses différentes.
 */
export function comparablePrice(product: Product): number {
  if (product.unit !== "piece") return unitPrice(product);
  return (product.price / product.packSize) * (1000 / averagePieceWeight(product));
}

/**
 * Convertit une quantité de recette exprimée en grammes vers l'unité réelle
 * du produit. Un produit au poids garde ses grammes ; un produit à la pièce
 * est converti en nombre de pièces, avec un minimum de une.
 */
export function gramsToProductQuantity(grams: number, product: Product): number {
  if (product.unit !== "piece") return grams;
  return Math.max(1, Math.round(grams / averagePieceWeight(product)));
}

/** Prix ramené à l'unité de référence : 1 kg, 1 L, ou 1 pièce. */
export function unitPrice(product: Product): number {
  const perUnit = product.price / product.packSize;
  return product.unit === "piece" ? perUnit : perUnit * 1000;
}

/** Libellé lisible du conditionnement (« 500 g », « 1,5 L », « x6 »). */
export function packLabel(product: Product): string {
  const { unit, packSize } = product;
  if (unit === "piece") return `x${packSize}`;
  if (unit === "ml") {
    return packSize >= 1000
      ? `${formatNumber(packSize / 1000)} L`
      : `${formatNumber(packSize)} ml`;
  }
  return packSize >= 1000
    ? `${formatNumber(packSize / 1000)} kg`
    : `${formatNumber(packSize)} g`;
}

/** Quantité lisible dans l'unité du produit (« 350 g », « 2 pièces »). */
export function quantityLabel(quantity: number, unit: Unit): string {
  if (unit === "piece") {
    const n = Math.round(quantity * 100) / 100;
    return `${formatNumber(n)} ${n > 1 ? "pièces" : "pièce"}`;
  }
  if (quantity >= 1000) {
    return `${formatNumber(Math.round(quantity / 10) / 100)} ${unit === "ml" ? "L" : "kg"}`;
  }
  return `${formatNumber(Math.round(quantity))} ${unit}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
}

export function formatPrice(euros: number): string {
  return euros.toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  });
}

/** Ordre de parcours du magasin, pour trier la liste de courses. */
const RAYON_ORDER = new Map<Rayon, number>(RAYONS.map((r, i) => [r, i]));

export function rayonRank(rayon: Rayon): number {
  return RAYON_ORDER.get(rayon) ?? RAYONS.length;
}

export interface CatalogFilter {
  diet?: DietTag[];
  /** Termes libres à bannir, comparés au nom et à la catégorie. */
  exclusions?: string[];
  /** Exclut les produits marqués en rupture dans le magasin de l'utilisateur. */
  excludeOutOfStock?: boolean;
}

/**
 * Restreint le catalogue à ce que l'utilisateur peut réellement acheter.
 * C'est ce sous-ensemble, et lui seul, qui est envoyé au générateur de recettes :
 * un produit absent d'ici ne peut pas apparaître dans un plan.
 */
export function filterCatalog(products: Product[], filter: CatalogFilter): Product[] {
  const terms = (filter.exclusions ?? [])
    .map((t) => normalize(t))
    .filter((t) => t.length >= 2);

  return products.filter((product) => {
    if (filter.excludeOutOfStock && product.stock === "rupture") return false;

    for (const tag of filter.diet ?? []) {
      if (!product.diet.includes(tag)) return false;
    }

    if (terms.length > 0) {
      const haystack = `${normalize(product.name)} ${normalize(product.category)}`;
      if (terms.some((t) => haystack.includes(t))) return false;
    }

    return true;
  });
}

/** Minuscules sans accents, pour comparer « Épinard » et « epinards ». */
export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Produits interchangeables avec `product` : même catégorie, mêmes régimes
 * couverts au moins. Sert au moteur de réparation budgétaire, qui remplace
 * un produit trop cher par son équivalent le moins cher.
 */
export function substitutesFor(
  product: Product,
  pool: Product[],
  requiredDiet: DietTag[] = [],
): Product[] {
  return pool
    .filter(
      (candidate) =>
        candidate.id !== product.id &&
        candidate.category === product.category &&
        candidate.unit === product.unit &&
        candidate.stock !== "rupture" &&
        requiredDiet.every((tag) => candidate.diet.includes(tag)),
    )
    .sort((a, b) => unitPrice(a) - unitPrice(b));
}

/**
 * Recherche tolérante utilisée par l'import CSV et par le rattrapage des
 * ingrédients que l'IA n'aurait pas su relier à un identifiant du catalogue.
 */
export function findProduct(query: string, pool: Product[]): Product | undefined {
  const q = normalize(query);
  if (!q) return undefined;

  const exact = pool.find((p) => p.id === query || normalize(p.name) === q);
  if (exact) return exact;

  const scored = pool
    .map((p) => ({ product: p, score: similarity(q, normalize(p.name)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  return best && best.score >= 0.5 ? best.product : undefined;
}

/** Score de recouvrement des mots, suffisant pour du rapprochement de libellés. */
function similarity(query: string, candidate: string): number {
  if (candidate.includes(query) || query.includes(candidate)) return 1;
  const queryWords = new Set(query.split(/\s+/).filter((w) => w.length > 2));
  if (queryWords.size === 0) return 0;
  const candidateWords = candidate.split(/\s+/);
  let hits = 0;
  for (const word of queryWords) {
    if (candidateWords.some((c) => c.startsWith(word) || word.startsWith(c))) hits++;
  }
  return hits / queryWords.size;
}

/** Applique les surcharges magasin de l'utilisateur (prix relevés, ruptures). */
export interface StoreOverride {
  productId: string;
  price?: number;
  stock?: Product["stock"];
}

export function applyOverrides(catalog: Catalog, overrides: StoreOverride[]): Catalog {
  if (overrides.length === 0) return catalog;
  const byId = new Map(overrides.map((o) => [o.productId, o]));

  return {
    ...catalog,
    products: catalog.products.map((product) => {
      const override = byId.get(product.id);
      if (!override) return product;
      return {
        ...product,
        ...(override.price !== undefined ? { price: override.price } : {}),
        ...(override.stock !== undefined ? { stock: override.stock } : {}),
      };
    }),
  };
}
