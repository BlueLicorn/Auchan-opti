import type { Catalog, Product, Provenance } from "@/lib/types";
import { findProduct, normalize, seedCatalog } from "@/lib/catalog";

/**
 * Open Prices — la base de prix ouverte d'Open Food Facts.
 *
 * C'est le seul « comparateur » exploitable par un particulier : API
 * documentée, licence ouverte (ODbL), et surtout des prix rattachés à un
 * magasin identifié via OpenStreetMap, pas à une moyenne nationale.
 *
 * Ses deux limites sont structurelles et l'interface doit les dire :
 *  - la couverture dépend des contributeurs, elle est inégale ;
 *  - il n'y a aucune donnée de stock, et il n'y en aura jamais.
 *
 * Un prix venu d'ici n'est donc jamais présenté comme un relevé personnel :
 * il porte la source « communaute », le magasin et la date d'origine.
 */

export const OPEN_PRICES_API = "https://prices.openfoodfacts.org/api/v1";

/** Un magasin, tel qu'Open Prices l'identifie (via OpenStreetMap). */
export interface StoreLocation {
  osmId: number;
  osmType: string;
  name: string;
  city?: string;
  /** Nombre de prix connus pour ce magasin, quand l'API le renseigne. */
  priceCount?: number;
}

/** Un prix relevé par un contributeur, une fois normalisé. */
export interface CommunityPrice {
  /** Code-barres du produit. C'est la clé d'appariement fiable. */
  code?: string;
  name?: string;
  brand?: string;
  /** Quantité du conditionnement telle qu'annoncée, ex. « 500 g ». */
  quantity?: string;
  price: number;
  currency: string;
  /** Date du relevé, ISO court. */
  date: string;
  store?: string;
}

// ---------------------------------------------------------------------------
// Normalisation des réponses
// ---------------------------------------------------------------------------

/**
 * L'API pagine sous une forme qui a déjà changé au fil des versions. Plutôt
 * que de coder en dur un nom de champ, on accepte les formes connues et on
 * échoue proprement sur les autres.
 */
function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["items", "results", "data", "prices", "locations"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function parseLocations(payload: unknown): StoreLocation[] {
  const locations: StoreLocation[] = [];

  for (const raw of extractItems(payload)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    const osmId = num(item.osm_id ?? item.id);
    const name = str(item.osm_name ?? item.name ?? item.osm_display_name);
    if (osmId === undefined || !name) continue;

    locations.push({
      osmId,
      osmType: (str(item.osm_type) ?? "NODE").toUpperCase(),
      name,
      city: str(item.osm_address_city ?? item.city),
      priceCount: num(item.price_count),
    });
  }

  return locations;
}

export function parsePrices(payload: unknown): CommunityPrice[] {
  const prices: CommunityPrice[] = [];

  for (const raw of extractItems(payload)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    const price = num(item.price);
    if (price === undefined || price <= 0) continue;

    // Le produit est parfois imbriqué, parfois à plat selon l'endpoint.
    const nested = (item.product ?? {}) as Record<string, unknown>;
    const location = (item.location ?? {}) as Record<string, unknown>;

    prices.push({
      code: str(item.product_code ?? nested.code),
      name: str(nested.product_name ?? item.product_name),
      brand: str(nested.brands ?? item.brands),
      quantity: str(nested.product_quantity ?? item.product_quantity),
      price,
      currency: (str(item.currency) ?? "EUR").toUpperCase(),
      date: isoDate(item.date ?? item.created),
      store: str(location.osm_name ?? item.location_osm_name),
    });
  }

  return prices;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isoDate(value: unknown): string {
  const text = String(value ?? "");
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fusion dans le catalogue
// ---------------------------------------------------------------------------

export interface MergeResult {
  catalog: Catalog;
  /** Produits dont le prix a été renseigné depuis Open Prices. */
  applied: number;
  /** Prix reçus qu'on n'a pas su rattacher à un produit du catalogue. */
  unmatched: number;
  /** Prix ignorés parce qu'une donnée plus récente ou plus proche existait. */
  skipped: number;
  /** Devises autres que l'euro, écartées. */
  foreign: number;
}

/**
 * Applique des prix communautaires au catalogue.
 *
 * Règle de priorité : un prix Open Prices ne remplace jamais un relevé
 * personnel (collecte, saisie, import). Il ne comble que les estimations, ou
 * remplace un prix communautaire plus ancien. Sans cette règle, une
 * contribution d'un inconnu écraserait ce que l'utilisateur a relevé lui-même.
 */
export function mergeCommunityPrices(
  prices: CommunityPrice[],
  base: Catalog = seedCatalog,
  options: { storeLabel?: string } = {},
): MergeResult {
  const products = base.products.map((p) => ({ ...p }));
  const byEan = new Map(products.filter((p) => p.ean).map((p) => [p.ean as string, p]));

  let applied = 0;
  let unmatched = 0;
  let skipped = 0;
  let foreign = 0;

  for (const price of prices) {
    if (price.currency !== "EUR") {
      foreign++;
      continue;
    }

    const target = (price.code ? byEan.get(price.code) : undefined)
      ?? (price.name ? findProduct(price.name, products) : undefined);

    if (!target) {
      unmatched++;
      continue;
    }

    if (!canOverride(target, price.date)) {
      skipped++;
      continue;
    }

    const provenance: Provenance = {
      source: "communaute",
      at: price.date,
      ...(price.store ?? options.storeLabel
        ? { store: price.store ?? options.storeLabel }
        : {}),
    };

    target.price = Math.round(price.price * 100) / 100;
    target.priceFrom = provenance;
    if (price.code && !target.ean) {
      target.ean = price.code;
      byEan.set(price.code, target);
    }
    applied++;
  }

  return {
    catalog: {
      ...base,
      products,
      source: "custom",
      updatedAt: new Date().toISOString().slice(0, 10),
    },
    applied,
    unmatched,
    skipped,
    foreign,
  };
}

/** Un relevé personnel prime toujours ; entre deux prix communautaires, le plus récent. */
function canOverride(product: Product, date: string): boolean {
  const current = product.priceFrom;
  if (current.source === "estimation") return true;
  if (current.source !== "communaute") return false;
  return Date.parse(date) >= Date.parse(current.at);
}

/**
 * Prix communautaires jugés trop vieux pour être proposés sans avertissement.
 * L'inflation alimentaire rend un prix d'il y a un an trompeur.
 */
export const COMMUNITY_STALE_DAYS = 120;

export function isStale(price: CommunityPrice): boolean {
  const age = (Date.now() - Date.parse(price.date)) / 86_400_000;
  return Number.isFinite(age) && age > COMMUNITY_STALE_DAYS;
}

/** Compare deux libellés de magasin, pour signaler un prix venu d'ailleurs. */
export function sameStore(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
}
