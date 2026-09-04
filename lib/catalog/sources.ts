import type { Catalog, Product, Provenance, Rayon } from "@/lib/types";
import { RAYONS } from "@/lib/types";
import { normalize, seedCatalog } from "@/lib/catalog";

/**
 * Une source de catalogue fournit des produits, des prix et une disponibilité.
 *
 * L'application n'en connaît qu'une interface : ajouter une source ne demande
 * pas de toucher au moteur de planification. Les sources livrées sont décrites
 * dans docs/SOURCES_DONNEES.md, y compris celles écartées et pourquoi.
 */
export interface CatalogSource {
  id: string;
  label: string;
  /** Ce que la source apporte réellement, affiché dans l'interface. */
  provides: { products: boolean; prices: boolean; stock: boolean; nutrition: boolean };
  /** Une source indisponible est listée mais grisée, avec sa raison. */
  available: boolean;
  unavailableReason?: string;
  load(): Promise<Catalog>;
}

/** Source par défaut : le relevé embarqué. Fonctionne hors-ligne, toujours. */
export const seedSource: CatalogSource = {
  id: "seed",
  label: "Catalogue embarqué",
  provides: { products: true, prices: true, stock: false, nutrition: true },
  available: true,
  async load() {
    return seedCatalog;
  },
};

// ---------------------------------------------------------------------------
// Import CSV : la source la plus juste, parce qu'elle vient de ton magasin
// ---------------------------------------------------------------------------

/** Colonnes attendues par l'import. Seules `nom` et `prix` sont obligatoires. */
export const CSV_COLUMNS = [
  "id", "nom", "rayon", "categorie", "unite", "contenance", "prix", "stock", "ean",
] as const;

export const CSV_TEMPLATE = [
  CSV_COLUMNS.join(";"),
  "es-penne;Penne;Épicerie salée;pates;g;500;1.15;en_rayon;",
  "vo-filet-poulet;Filets de poulet;Volaille;poulet;g;1000;8.99;stock_faible;",
  ";Yaourt de brebis;Crémerie;yaourt;g;500;3.20;en_rayon;3256540000000",
].join("\n");

export interface CsvImportResult {
  catalog: Catalog;
  /** Produits du catalogue embarqué dont le prix a été recalé. */
  updated: number;
  /** Produits absents du catalogue embarqué et ajoutés. */
  added: number;
  /** Lignes rejetées, avec la raison, pour affichage à l'utilisateur. */
  rejected: { line: number; reason: string }[];
}

/**
 * Fusionne un CSV utilisateur avec le catalogue embarqué.
 *
 * Une ligne dont l'`id` correspond à un produit connu ne fait que corriger son
 * prix et sa disponibilité : on garde la fiche nutritionnelle existante. Une
 * ligne inconnue crée un produit, sans nutrition — le moteur le chiffrera mais
 * ne le comptera pas dans le score d'équilibre.
 */
export function importCsv(text: string, base: Catalog = seedCatalog): CsvImportResult {
  const today = new Date().toISOString().slice(0, 10);
  const provenance: Provenance = { source: "import", at: today };
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rejected: CsvImportResult["rejected"] = [];

  if (lines.length < 2) {
    return { catalog: base, updated: 0, added: 0, rejected: [{ line: 1, reason: "Fichier vide ou sans ligne de données." }] };
  }

  const delimiter = detectDelimiter(lines[0]);
  const header = splitRow(lines[0], delimiter).map((h) => normalize(h));
  const col = (name: string) => header.indexOf(name);

  const iName = col("nom") >= 0 ? col("nom") : col("name");
  const iPrice = col("prix") >= 0 ? col("prix") : col("price");
  if (iName < 0 || iPrice < 0) {
    return {
      catalog: base,
      updated: 0,
      added: 0,
      rejected: [{ line: 1, reason: "En-tête invalide : les colonnes « nom » et « prix » sont obligatoires." }],
    };
  }

  const idx = {
    id: col("id"),
    rayon: col("rayon"),
    category: col("categorie"),
    unit: col("unite"),
    packSize: col("contenance"),
    stock: col("stock"),
    ean: col("ean"),
  };

  const byId = new Map(base.products.map((p) => [p.id, { ...p }]));
  const byName = new Map(base.products.map((p) => [normalize(p.name), p.id]));
  let updated = 0;
  let added = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i], delimiter);
    const name = cells[iName]?.trim();
    const price = parsePrice(cells[iPrice]);

    if (!name) {
      rejected.push({ line: i + 1, reason: "Nom manquant." });
      continue;
    }
    if (price === undefined) {
      rejected.push({ line: i + 1, reason: `Prix illisible : « ${cells[iPrice] ?? ""} ».` });
      continue;
    }

    const rawId = idx.id >= 0 ? cells[idx.id]?.trim() : "";
    const existingId = rawId && byId.has(rawId) ? rawId : byName.get(normalize(name));

    if (existingId) {
      const product = byId.get(existingId)!;
      product.price = price;
      product.priceFrom = provenance;
      const stock = idx.stock >= 0 ? parseStock(cells[idx.stock]) : undefined;
      if (stock) {
        product.stock = stock;
        product.stockFrom = provenance;
      }
      const packSize = idx.packSize >= 0 ? Number(cells[idx.packSize]?.replace(",", ".")) : NaN;
      if (Number.isFinite(packSize) && packSize > 0) product.packSize = packSize;
      updated++;
      continue;
    }

    const packSize = idx.packSize >= 0 ? Number(cells[idx.packSize]?.replace(",", ".")) : NaN;
    const unit = idx.unit >= 0 ? parseUnit(cells[idx.unit]) : "piece";
    const product: Product = {
      id: rawId || `csv-${slug(name)}`,
      name,
      rayon: (idx.rayon >= 0 ? parseRayon(cells[idx.rayon]) : undefined) ?? "Épicerie salée",
      category: (idx.category >= 0 ? cells[idx.category]?.trim() : "") || "divers",
      brandTier: "national",
      unit,
      packSize: Number.isFinite(packSize) && packSize > 0 ? packSize : 1,
      price,
      priceFrom: provenance,
      // Sans information, on n'exclut le produit d'aucun régime : c'est à
      // l'utilisateur de compléter, et l'interface le signale.
      diet: [],
      shelfLifeDays: 30,
      stock: (idx.stock >= 0 ? parseStock(cells[idx.stock]) : undefined) ?? "inconnu",
      ...(idx.stock >= 0 && parseStock(cells[idx.stock])
        ? { stockFrom: provenance }
        : {}),
      ...(idx.ean >= 0 && cells[idx.ean]?.trim() ? { ean: cells[idx.ean].trim() } : {}),
    };
    byId.set(product.id, product);
    added++;
  }

  return {
    catalog: {
      products: [...byId.values()],
      source: "csv",
      updatedAt: new Date().toISOString().slice(0, 10),
      storeLabel: base.storeLabel,
    },
    updated,
    added,
    rejected,
  };
}

function detectDelimiter(headerLine: string): string {
  const counts = [";", ",", "\t"].map((d) => ({ d, n: headerLine.split(d).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 1 ? counts[0].d : ";";
}

/** Découpe une ligne CSV en respectant les guillemets doublés. */
function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  // Le nettoyage retire le symbole monétaire et les espaces. Attention :
  // Number("") vaut 0, donc une cellule non numérique passerait pour gratuite.
  const cleaned = raw.replace(/[^0-9.,-]/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return value > 0 ? Math.round(value * 100) / 100 : undefined;
}

function parseStock(raw: string | undefined): Product["stock"] | undefined {
  const value = normalize(raw ?? "");
  if (!value || value === "inconnu") return undefined;
  if (/rupture|indispo|0/.test(value)) return "rupture";
  if (/faible|limite|bas/.test(value)) return "stock_faible";
  return "en_rayon";
}

function parseUnit(raw: string | undefined): Product["unit"] {
  const value = normalize(raw ?? "");
  if (value === "ml" || value === "l" || value === "cl") return "ml";
  if (value === "g" || value === "kg") return "g";
  return "piece";
}

function parseRayon(raw: string | undefined): Rayon | undefined {
  const value = normalize(raw ?? "");
  return RAYONS.find((r) => normalize(r) === value)
    ?? RAYONS.find((r) => normalize(r).startsWith(value.slice(0, 6)));
}

function slug(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** Sérialise un catalogue au format d'import, pour l'export « mes prix ». */
export function exportCsv(catalog: Catalog): string {
  const rows = [CSV_COLUMNS.join(";")];
  for (const p of catalog.products) {
    rows.push([
      p.id, escapeCell(p.name), p.rayon, p.category, p.unit,
      String(p.packSize), p.price.toFixed(2), p.stock, p.ean ?? "",
    ].join(";"));
  }
  return rows.join("\n");
}

function escapeCell(value: string): string {
  return /[;"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
