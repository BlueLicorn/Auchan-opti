import rawCatalog from "@/data/catalog.json";
import type {
  Catalog, DietTag, Product, Provenance, Rayon, Unit,
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
  /**
   * Ne garde que les produits dont le prix a été relevé — collecte sur le site,
   * import CSV, saisie manuelle — et écarte les estimations du catalogue
   * embarqué.
   */
  verifiedPriceOnly?: boolean;
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
    if (filter.verifiedPriceOnly && isEstimate(product)) return false;

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

/**
 * Minuscules, sans accents, espaces réduits : « Épinard » et « epinards »
 * se comparent, comme « Auchan  Villars » et « auchan villars ». Les libellés
 * venus d'OpenStreetMap ou du site marchand ont une ponctuation irrégulière
 * qu'il faut absorber avant toute comparaison.
 */
export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
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
  return best && best.score >= FUZZY_THRESHOLD ? best.product : undefined;
}

/**
 * Seuil au-delà duquel deux libellés désignent le même produit.
 *
 * Calibré pour laisser passer les prolongements de nom (« Huile d'olive » et
 * « Huile d'olive vierge extra ») tout en refusant les simples cousinages :
 * « Huile de friture » et « Huile d'olive » ne partagent qu'un mot générique.
 */
const FUZZY_THRESHOLD = 0.62;

/**
 * Proximité de deux libellés de produit, entre 0 et 1.
 *
 * La règle naïve — un libellé qui contient l'autre vaut 1 — se trompait
 * lourdement : « Sardines à l'huile d'olive » contient « Huile d'olive », et
 * le prix de la bouteille venait écraser celui de la boîte. Ce qui compte
 * n'est pas la présence du texte n'importe où, mais que l'un des deux
 * libellés soit un prolongement ou une précision de l'autre.
 */
function similarity(query: string, candidate: string): number {
  if (query === candidate) return 1;

  // « Huile d'olive » → « Huile d'olive vierge extra » : même produit précisé.
  if (candidate.startsWith(query) || query.startsWith(candidate)) return 0.9;

  const queryWords = words(query);
  const candidateWords = words(candidate);
  if (queryWords.length === 0 || candidateWords.length === 0) return 0;

  // Tous les mots du candidat figurent dans la requête : celle-ci en est une
  // version plus détaillée. « Saumon fumé » ⊂ « Saumon fumé de l'Atlantique ».
  if (candidateWords.every((word) => matchesAny(word, queryWords))) return 0.85;

  // Sinon, part des mots de la requête retrouvés — plafonnée sous les cas
  // précédents, car un recouvrement partiel reste une conjecture.
  const hits = queryWords.filter((word) => matchesAny(word, candidateWords)).length;
  return (hits / queryWords.length) * 0.8;
}

/** Mots porteurs de sens : les particules de deux lettres n'en sont pas. */
function words(value: string): string[] {
  return value.split(/\s+/).filter((word) => word.length > 2);
}

function matchesAny(word: string, pool: string[]): boolean {
  return pool.some((other) => other.startsWith(word) || word.startsWith(other));
}

/** Applique les surcharges magasin de l'utilisateur (prix relevés, ruptures). */
export interface StoreOverride {
  productId: string;
  price?: number;
  stock?: Product["stock"];
  /** Date de la correction, ISO court. Conservée pour dater la provenance. */
  at?: string;
}

export function applyOverrides(catalog: Catalog, overrides: StoreOverride[]): Catalog {
  if (overrides.length === 0) return catalog;
  const byId = new Map(overrides.map((o) => [o.productId, o]));

  return {
    ...catalog,
    products: catalog.products.map((product) => {
      const override = byId.get(product.id);
      if (!override) return product;

      // Une correction saisie à la main est un relevé : elle porte sa date,
      // sinon l'interface ne saurait pas la distinguer d'une estimation.
      const provenance: Provenance = {
        source: "saisie",
        at: override.at ?? new Date().toISOString().slice(0, 10),
      };

      // La donnée la plus récente gagne. Sans cette règle, une correction
      // saisie il y a trois semaines écraserait le prix relevé ce matin.
      const priceWins = override.price !== undefined
        && !isOlder(provenance, product.priceFrom);
      const stockWins = override.stock !== undefined
        && !isOlder(provenance, product.stockFrom);

      return {
        ...product,
        ...(priceWins ? { price: override.price, priceFrom: provenance } : {}),
        ...(stockWins ? { stock: override.stock, stockFrom: provenance } : {}),
      };
    }),
  };
}

/** Vrai si `candidate` est antérieur à `existing`. Une absence ne prime jamais. */
function isOlder(candidate: Provenance, existing: Provenance | undefined): boolean {
  if (!existing || existing.source === "estimation") return false;
  return Date.parse(candidate.at) < Date.parse(existing.at);
}

// ---------------------------------------------------------------------------
// Fiabilité des données affichées
// ---------------------------------------------------------------------------

/** Un prix relevé n'est fiable qu'un temps : les prix bougent. */
export const PRICE_FRESH_DAYS = 30;

export function isEstimate(product: Product): boolean {
  return product.priceFrom.source === "estimation";
}

/** Jours écoulés depuis un relevé, ou undefined si la date est illisible. */
export function daysSince(provenance: Provenance | undefined): number | undefined {
  if (!provenance) return undefined;
  const then = Date.parse(provenance.at);
  if (Number.isNaN(then)) return undefined;
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
}

/** Libellé court de la provenance, pour l'afficher à côté d'un prix. */
export function provenanceLabel(provenance: Provenance | undefined): string {
  if (!provenance) return "inconnu";
  const age = daysSince(provenance);
  const quand = age === undefined ? ""
    : age === 0 ? " aujourd'hui"
    : age === 1 ? " hier"
    : ` il y a ${age} j`;

  switch (provenance.source) {
    case "estimation": return "prix estimé";
    case "collecte": return `relevé sur auchan.fr${quand}`;
    case "communaute": return `Open Prices${provenance.store ? ` · ${provenance.store}` : ""}${quand}`;
    case "import": return `importé${quand}`;
    case "saisie": return `saisi${quand}`;
  }
}

export interface CatalogCoverage {
  /** Produits dont le prix vient d'un relevé réel, et non d'une estimation. */
  realPrices: number;
  /** Produits dont la disponibilité a été constatée. */
  knownStock: number;
  total: number;
  /** Relevés de prix datant de plus de PRICE_FRESH_DAYS jours. */
  stale: number;
}

/** Ce que l'application sait réellement, pour pouvoir le dire à l'utilisateur. */
export function coverage(products: Product[]): CatalogCoverage {
  let realPrices = 0;
  let knownStock = 0;
  let stale = 0;

  for (const product of products) {
    if (!isEstimate(product)) {
      realPrices++;
      const age = daysSince(product.priceFrom);
      if (age !== undefined && age > PRICE_FRESH_DAYS) stale++;
    }
    if (product.stock !== "inconnu") knownStock++;
  }

  return { realPrices, knownStock, stale, total: products.length };
}
