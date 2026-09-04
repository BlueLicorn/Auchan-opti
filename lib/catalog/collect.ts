import type { Catalog, Product, Provenance, StockStatus } from "@/lib/types";
import { findProduct, normalize, seedCatalog } from "@/lib/catalog";

/**
 * Import d'un relevé produit par le collecteur navigateur.
 *
 * Le collecteur (public/auchan-collect.user.js) lit les pages Auchan que
 * l'utilisateur consulte lui-même et produit ce format. C'est la seule source
 * qui apporte à la fois le prix exact de SON magasin et la disponibilité —
 * aucune donnée publique ne contient l'un ou l'autre.
 *
 * Comme pour la réponse d'un modèle, rien n'est cru sur parole : un prix
 * aberrant, un libellé vide ou un produit non rattachable est rejeté avec sa
 * raison plutôt que d'entrer silencieusement dans le catalogue.
 */

export interface ReleveEntry {
  nom?: string;
  ean?: string;
  prix?: number;
  stock?: string;
  marque?: string;
  magasin?: string;
  url?: string;
  releveLe?: string;
}

export interface ReleveFile {
  version?: number;
  produits?: ReleveEntry[];
}

export interface CollectResult {
  catalog: Catalog;
  /** Produits du catalogue dont le prix a été remplacé par un relevé. */
  matched: number;
  /** Produits relevés qui n'existaient pas au catalogue et ont été ajoutés. */
  added: number;
  /** Disponibilités renseignées, tous produits confondus. */
  stockUpdated: number;
  rejected: { label: string; reason: string }[];
  storeLabel?: string;
}

/** Bornes de vraisemblance d'un prix de produit alimentaire, en euros. */
const MIN_PRICE = 0.05;
const MAX_PRICE = 300;

export function importReleve(raw: string, base: Catalog = seedCatalog): CollectResult {
  let parsed: ReleveFile;
  try {
    parsed = JSON.parse(raw) as ReleveFile;
  } catch {
    return empty(base, "Le contenu collé n'est pas un relevé valide (JSON illisible).");
  }

  const entries = parsed?.produits;
  if (!Array.isArray(entries) || entries.length === 0) {
    return empty(base, "Relevé vide : aucun produit n'y figure.");
  }

  const products = base.products.map((p) => ({ ...p }));
  const byId = new Map(products.map((p) => [p.id, p]));
  const byEan = new Map(
    products.filter((p) => p.ean).map((p) => [p.ean as string, p]),
  );

  const rejected: CollectResult["rejected"] = [];
  let matched = 0;
  let added = 0;
  let stockUpdated = 0;
  const stores = new Map<string, number>();

  for (const entry of entries) {
    const name = String(entry.nom ?? "").trim();
    if (name.length < 2) {
      rejected.push({ label: entry.ean ?? "(sans nom)", reason: "Libellé manquant." });
      continue;
    }

    const price = Number(entry.prix);
    const priceGiven = entry.prix !== undefined && entry.prix !== null;
    const hasPrice = Number.isFinite(price) && price >= MIN_PRICE && price <= MAX_PRICE;
    const stock = parseStock(entry.stock);

    // Un prix fourni mais rejeté mérite sa propre explication : dire « ni prix
    // ni disponibilité » masquerait la vraie cause au moment de corriger.
    if (priceGiven && !hasPrice) {
      rejected.push({ label: name, reason: `Prix invraisemblable : ${entry.prix}.` });
    }

    if (!hasPrice && stock === "inconnu") {
      if (!priceGiven) {
        rejected.push({ label: name, reason: "Ni prix exploitable ni disponibilité." });
      }
      continue;
    }

    if (entry.magasin) stores.set(entry.magasin, (stores.get(entry.magasin) ?? 0) + 1);

    const at = isoDate(entry.releveLe);
    const provenance: Provenance = {
      source: "collecte",
      at,
      ...(entry.magasin ? { store: entry.magasin } : {}),
    };

    // Le code-barres est l'appariement sûr ; le libellé n'est qu'un repli.
    const target = (entry.ean ? byEan.get(entry.ean) : undefined)
      ?? findProduct(name, products);

    if (target) {
      if (hasPrice) {
        target.price = round2(price);
        target.priceFrom = provenance;
        matched++;
      }
      if (stock !== "inconnu") {
        target.stock = stock;
        target.stockFrom = provenance;
        stockUpdated++;
      }
      if (entry.ean && !target.ean) {
        target.ean = entry.ean;
        byEan.set(entry.ean, target);
      }
      continue;
    }

    if (!hasPrice) {
      rejected.push({ label: name, reason: "Produit inconnu et sans prix : rien à enregistrer." });
      continue;
    }

    const product: Product = {
      id: uniqueId(`col-${slug(name)}`, byId),
      name,
      // Sans classement fiable, le produit atterrit en épicerie salée et
      // l'interface signale qu'il demande d'être complété.
      rayon: "Épicerie salée",
      category: "divers",
      brandTier: "national",
      unit: "piece",
      packSize: 1,
      price: round2(price),
      priceFrom: provenance,
      diet: [],
      shelfLifeDays: 30,
      stock,
      ...(stock !== "inconnu" ? { stockFrom: provenance } : {}),
      ...(entry.ean ? { ean: entry.ean } : {}),
    };

    products.push(product);
    byId.set(product.id, product);
    if (product.ean) byEan.set(product.ean, product);
    added++;
    if (stock !== "inconnu") stockUpdated++;
  }

  const storeLabel = [...stores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    catalog: {
      products,
      source: "custom",
      updatedAt: new Date().toISOString().slice(0, 10),
      storeLabel: storeLabel ?? base.storeLabel,
    },
    matched,
    added,
    stockUpdated,
    rejected,
    storeLabel,
  };
}

function empty(base: Catalog, reason: string): CollectResult {
  return {
    catalog: base, matched: 0, added: 0, stockUpdated: 0,
    rejected: [{ label: "—", reason }],
  };
}

function parseStock(value: unknown): StockStatus {
  const text = normalize(String(value ?? ""));
  if (!text || text === "inconnu") return "inconnu";
  if (/rupture|indispo|epuise|outofstock/.test(text)) return "rupture";
  if (/faible|limite|dernieres/.test(text)) return "stock_faible";
  if (/rayon|dispo|instock/.test(text)) return "en_rayon";
  return "inconnu";
}

function isoDate(value: unknown): string {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date().toISOString().slice(0, 10);
}

function uniqueId(base: string, taken: Map<string, unknown>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function slug(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
