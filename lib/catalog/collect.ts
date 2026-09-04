import type { Catalog, Product, Provenance, Rayon, StockStatus } from "@/lib/types";
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
  /** Code-barres public (EAN/GTIN), quand la source en fournit un. */
  ean?: string;
  /**
   * Référence interne Auchan (« cug » ou « ref_fo »).
   *
   * Ce n'est pas un code-barres et il ne faut surtout pas la confondre avec :
   * elle est stable et parfaite pour réapparier un relevé au suivant, mais
   * elle n'a aucun sens pour les bases publiques comme Open Prices.
   */
  ref?: string;
  /** Rayon tel que le site le classe, à traduire vers nos propres rayons. */
  rayon?: string;
  prix?: number;
  stock?: string;
  marque?: string;
  magasin?: string;
  url?: string;
  releveLe?: string;
}

/**
 * Traduction de l'arborescence de rayons d'Auchan vers la nôtre.
 *
 * Le site classe sur cinq niveaux, en majuscules pour les niveaux internes
 * (« CREMERIE », « CHARCUTERIE LS ») et en libellés lisibles dans ses filtres
 * (« Épicerie salée »). On accepte les deux formes.
 */
const RAYONS_AUCHAN: { motif: RegExp; rayon: Rayon }[] = [
  { motif: /fruits?\s*(et|,)?\s*legumes?|f\s*&\s*l/, rayon: "Fruits & Légumes" },
  { motif: /boucherie|viande|volaille/, rayon: "Boucherie" },
  { motif: /poissonnerie|maree|poisson/, rayon: "Poissonnerie" },
  { motif: /charcuterie|traiteur/, rayon: "Charcuterie & Traiteur" },
  { motif: /cremerie|fromage|produits laitiers|oeufs|ultra frais/, rayon: "Crémerie" },
  { motif: /boulangerie|patisserie|viennoiserie|pain/, rayon: "Boulangerie" },
  { motif: /surgel/, rayon: "Surgelés" },
  { motif: /epicerie sucree|biscuit|confiserie|chocolat/, rayon: "Épicerie sucrée" },
  { motif: /epicerie salee|epicerie|conserve/, rayon: "Épicerie salée" },
  { motif: /boisson|eaux|jus|soda|vins?|bieres?|alcool/, rayon: "Boissons" },
  { motif: /apero|monde|snacking/, rayon: "Monde & Apéritif" },
];

/**
 * Rayons dont rien ne doit entrer dans un catalogue alimentaire.
 *
 * Un relevé de rayon Auchan ramène aussi la lessive, le dentifrice, les
 * couches et les croquettes pour chat. Sans ce filtre, tout cela atterrissait
 * dans le rayon par défaut « Épicerie salée » — et « Croquettes à la volaille
 * pour chat » devenait une source de protéine que le planificateur pouvait
 * choisir. Un produit d'un de ces rayons est écarté, même s'il ressemble à un
 * produit connu : « Lait nettoyant pour bébé » n'est pas du lait.
 */
const RAYONS_NON_ALIMENTAIRES = [
  /entretien/,
  /hygiene/,
  /beaute|parfumerie/,
  /animalerie/,
  /bebe|puericulture/,
  /arts de la table|bazar|vaisselle/,
  /jardin/,
  /textile|papeterie|culture|bricolage|auto/,
];

export function estNonAlimentaire(rayon: unknown): boolean {
  const texte = normalize(String(rayon ?? ""));
  if (!texte) return false;
  return RAYONS_NON_ALIMENTAIRES.some((motif) => motif.test(texte));
}

function parseRayon(value: unknown): Rayon | undefined {
  const texte = normalize(String(value ?? ""));
  if (!texte) return undefined;
  return RAYONS_AUCHAN.find((entree) => entree.motif.test(texte))?.rayon;
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
  /** Produits écartés parce qu'ils viennent d'un rayon non alimentaire. */
  nonFood: number;
  /**
   * Rayons rencontrés que la table de correspondance ne connaît pas.
   *
   * Leurs produits sont conservés dans un rayon par défaut, mais les nommer
   * permet d'enrichir la table plutôt que de laisser le classement dériver
   * en silence.
   */
  unknownAisles: string[];
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

  return mergeEntries(entries, base);
}

/**
 * Fusionne des relevés dans le catalogue, quelle que soit leur origine :
 * collecteur navigateur, ticket de caisse ou commande collée.
 */
export function mergeEntries(
  entries: ReleveEntry[],
  base: Catalog = seedCatalog,
): CollectResult {
  const products = base.products.map((p) => ({ ...p }));
  const byId = new Map(products.map((p) => [p.id, p]));

  /**
   * Le rapprochement de libellés ne s'applique qu'au catalogue de départ.
   *
   * Sans cette précaution, un produit ajouté en début d'import devient une
   * cible pour les suivants : « Yaourt nature 4x125g » et « Yaourt nature
   * 12x125g » fusionneraient en un seul, et le second prix écraserait le
   * premier. L'appariement exact par référence ou code-barres, lui, reste
   * valable sur les nouveaux produits — c'est justement son rôle.
   */
  const fuzzyPool = products.slice();

  /**
   * Un produit du catalogue ne peut être réclamé qu'une fois par
   * rapprochement de libellé.
   *
   * Trois conditionnements d'un même yaourt ressemblent tous au produit
   * générique du catalogue : sans cette règle, les trois s'y écrasaient l'un
   * après l'autre et seul le dernier prix survivait. Le premier le prend, les
   * suivants deviennent des produits à part entière. L'appariement exact par
   * référence reste, lui, toujours autorisé : il ne se trompe pas.
   */
  const reclames = new Set<string>();
  const byEan = new Map(
    products.filter((p) => p.ean).map((p) => [p.ean as string, p]),
  );
  // La référence interne du magasin est l'appariement le plus fiable d'un
  // relevé au suivant : elle ne bouge pas, contrairement aux libellés.
  const byRef = new Map(
    products.filter((p) => p.storeRef).map((p) => [p.storeRef as string, p]),
  );

  const rejected: CollectResult["rejected"] = [];
  let matched = 0;
  let added = 0;
  let stockUpdated = 0;
  let nonFood = 0;
  const unknownAisles = new Set<string>();
  const stores = new Map<string, number>();

  for (const entry of entries) {
    const name = String(entry.nom ?? "").trim();
    if (name.length < 2) {
      rejected.push({ label: entry.ean ?? "(sans nom)", reason: "Libellé manquant." });
      continue;
    }

    // Le filtre s'applique avant tout appariement : un produit d'entretien ne
    // doit pas non plus venir écraser le prix d'un produit alimentaire par
    // ressemblance de libellé.
    if (estNonAlimentaire(entry.rayon)) {
      nonFood++;
      continue;
    }
    if (entry.rayon && !parseRayon(entry.rayon)) {
      unknownAisles.add(String(entry.rayon));
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

    // Par ordre de fiabilité décroissante : référence magasin, code-barres,
    // puis rapprochement de libellé — ce dernier une seule fois par produit.
    const exact = (entry.ref ? byRef.get(entry.ref) : undefined)
      ?? (entry.ean ? byEan.get(entry.ean) : undefined);

    let approche: Product | undefined;
    if (!exact) {
      const candidat = findProduct(name, fuzzyPool);
      if (candidat && !reclames.has(candidat.id)) approche = candidat;
    }

    const target = exact ?? approche;
    if (approche) reclames.add(approche.id);

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
      if (entry.ref && !target.storeRef) {
        target.storeRef = entry.ref;
        byRef.set(entry.ref, target);
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
      // Le rayon annoncé par le site est traduit quand on le reconnaît ;
      // sinon le produit atterrit en épicerie salée, à corriger à la main.
      rayon: parseRayon(entry.rayon) ?? "Épicerie salée",
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
      ...(entry.ref ? { storeRef: entry.ref } : {}),
    };

    products.push(product);
    byId.set(product.id, product);
    if (product.ean) byEan.set(product.ean, product);
    if (product.storeRef) byRef.set(product.storeRef, product);
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
    nonFood,
    unknownAisles: [...unknownAisles],
    rejected,
    storeLabel,
  };
}

function empty(base: Catalog, reason: string): CollectResult {
  return {
    catalog: base, matched: 0, added: 0, stockUpdated: 0,
    nonFood: 0, unknownAisles: [],
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

// ---------------------------------------------------------------------------
// Lecture d'une commande ou d'un ticket collé
// ---------------------------------------------------------------------------

/**
 * Extrait des lignes « produit + prix » d'un texte collé.
 *
 * C'est la source la plus rentable de toutes : l'historique de commandes d'un
 * compte Auchan, ou un ticket dématérialisé, contient les prix réellement
 * payés pour les produits réellement achetés. Ce sont les données de
 * l'utilisateur, sur son propre compte — rien à collecter nulle part.
 *
 * L'analyse est délibérément prudente : un faux prix contaminerait le budget
 * en silence, alors qu'une ligne manquée se rattrape en un instant.
 */

/** Mentions qui identifient une ligne de pied de ticket, jamais un produit. */
const LIGNES_NON_PRODUIT =
  /\b(total|sous-?total|montant|tva|remise|reduction|fidelit|carte|especes|espèces|cb\b|rendu|monnaie|nombre d'articles|articles?\s*:|panier|livraison|frais de port|consigne|eco-?part|dont|net a payer|net à payer|ticket|facture|commande n|date|heure|magasin|drive|merci)\b/i;

/**
 * Un prix en fin de ligne : « 1,15 € », « 1.15 EUR », « 1,15 ».
 * L'ancrage en fin de ligne évite de confondre un prix avec un grammage.
 */
const PRIX_FIN_DE_LIGNE = /(\d{1,3})[.,](\d{2})\s*(?:€|eur|euros?)?\s*$/i;

/** Quantité en tête de ligne : « 2 x », « x2 », « 3 » suivi du libellé. */
const QUANTITE_EN_TETE = /^\s*(?:(\d{1,2})\s*[x×]\s*|[x×]\s*(\d{1,2})\s+)/i;

export interface ReceiptParseResult {
  entries: ReleveEntry[];
  /** Lignes écartées, avec la raison, pour que l'utilisateur puisse corriger. */
  ignored: { line: string; reason: string }[];
}

export function parseReceiptText(text: string): ReceiptParseResult {
  const entries: ReleveEntry[] = [];
  const ignored: ReceiptParseResult["ignored"] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\.{2,}/g, " ").replace(/\s+/g, " ").trim();
    if (line.length < 4) continue;

    if (LIGNES_NON_PRODUIT.test(line)) {
      ignored.push({ line, reason: "Ligne de pied de ticket, pas un produit." });
      continue;
    }

    const prix = line.match(PRIX_FIN_DE_LIGNE);
    if (!prix) continue;

    const montant = Number(`${prix[1]}.${prix[2]}`);
    if (!(montant >= MIN_PRICE && montant <= MAX_PRICE)) {
      ignored.push({ line, reason: `Montant hors des bornes plausibles : ${montant}.` });
      continue;
    }

    let libelle = line.slice(0, prix.index).trim();

    // Une quantité en tête signifie que le montant est un total de ligne :
    // c'est le prix unitaire qui nous intéresse.
    const quantite = libelle.match(QUANTITE_EN_TETE);
    const multiple = Number(quantite?.[1] ?? quantite?.[2] ?? 1);
    if (quantite) libelle = libelle.slice(quantite[0].length).trim();

    // Codes article, références et poids résiduels ne sont pas des libellés.
    libelle = libelle
      .replace(/^\d{6,}\s*/, "")
      .replace(/[\s.·–—-]+$/, "")
      .trim();

    if (libelle.length < 3 || !/[a-zà-ÿ]{3}/i.test(libelle)) {
      ignored.push({ line, reason: "Aucun libellé de produit lisible." });
      continue;
    }

    const unitaire = multiple > 1 ? montant / multiple : montant;
    entries.push({
      nom: libelle,
      prix: Math.round(unitaire * 100) / 100,
      // Un ticket prouve que le produit était disponible ce jour-là.
      stock: "en_rayon",
      releveLe: today,
    });
  }

  return { entries, ignored };
}
