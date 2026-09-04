import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  applyOverrides, coverage, isEstimate, provenanceLabel, seedCatalog,
} from "@/lib/catalog";
import {
  importReleve, mergeEntries, parseReceiptText,
} from "@/lib/catalog/collect";
import type { Catalog } from "@/lib/types";

const today = new Date().toISOString().slice(0, 10);

function releve(produits: unknown[]): string {
  return JSON.stringify({ version: 1, produits });
}

describe("import d'un relevé magasin", () => {
  it("remplace un prix estimé par le prix relevé, avec sa provenance", () => {
    const result = importReleve(releve([
      { nom: "Penne", prix: 1.42, stock: "en_rayon", magasin: "Auchan Villars", releveLe: today },
    ]));

    assert.equal(result.matched, 1);
    const penne = result.catalog.products.find((p) => p.id === "es-penne")!;
    assert.equal(penne.price, 1.42);
    assert.equal(penne.priceFrom.source, "collecte");
    assert.equal(penne.priceFrom.store, "Auchan Villars");
    assert.equal(penne.stock, "en_rayon");
    assert.equal(result.storeLabel, "Auchan Villars");
  });

  it("apparie par code-barres en priorité sur le libellé", () => {
    const base: Catalog = {
      ...seedCatalog,
      products: seedCatalog.products.map((p) =>
        p.id === "es-penne" ? { ...p, ean: "3245390000001" } : p,
      ),
    };

    const result = importReleve(
      releve([{ nom: "Libellé du site totalement différent", ean: "3245390000001", prix: 2.1 }]),
      base,
    );

    assert.equal(result.added, 0, "le code-barres doit éviter la création d'un doublon");
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.price, 2.1);
  });

  it("enregistre une rupture même sans prix", () => {
    const result = importReleve(releve([{ nom: "Penne", stock: "rupture" }]));
    assert.equal(result.stockUpdated, 1);
    assert.equal(result.catalog.products.find((p) => p.id === "es-penne")!.stock, "rupture");
  });

  it("rejette un prix invraisemblable plutôt que de fausser le budget", () => {
    const result = importReleve(releve([{ nom: "Penne", prix: 9999 }]));
    assert.equal(result.matched, 0);
    assert.ok(result.rejected.some((r) => r.reason.includes("invraisemblable")));
    assert.equal(
      result.catalog.products.find((p) => p.id === "es-penne")!.price,
      seedCatalog.products.find((p) => p.id === "es-penne")!.price,
      "le prix d'origine doit être intact",
    );
  });

  it("écarte une entrée sans nom ni disponibilité exploitable", () => {
    const result = importReleve(releve([{ prix: 2 }, { nom: "X" }]));
    assert.equal(result.matched, 0);
    assert.equal(result.added, 0);
    assert.equal(result.rejected.length, 2);
  });

  it("refuse un contenu qui n'est pas un relevé", () => {
    const result = importReleve("ceci n'est pas du JSON");
    assert.equal(result.catalog, seedCatalog, "le catalogue ne doit pas être touché");
    assert.ok(result.rejected[0].reason.includes("JSON"));
  });

  it("ajoute un produit inconnu quand il a un prix", () => {
    const result = importReleve(releve([
      { nom: "Yaourt de brebis bio", ean: "3256540000000", prix: 3.2, stock: "en_rayon" },
    ]));
    assert.equal(result.added, 1);
    const ajoute = result.catalog.products.find((p) => p.name === "Yaourt de brebis bio")!;
    assert.equal(ajoute.priceFrom.source, "collecte");
    assert.equal(ajoute.ean, "3256540000000");
  });
});

describe("fiabilité affichée", () => {
  it("compte le catalogue embarqué comme entièrement estimé", () => {
    const stats = coverage(seedCatalog.products);
    assert.equal(stats.realPrices, 0, "aucun prix du catalogue n'est un relevé");
    assert.equal(stats.knownStock, 0, "le stock d'un magasin n'est pas connu d'avance");
    assert.ok(seedCatalog.products.every(isEstimate));
  });

  it("distingue un prix relevé d'un prix estimé", () => {
    const result = importReleve(releve([{ nom: "Penne", prix: 1.42, releveLe: today }]));
    const stats = coverage(result.catalog.products);
    assert.equal(stats.realPrices, 1);
    assert.ok(provenanceLabel(
      result.catalog.products.find((p) => p.id === "es-penne")!.priceFrom,
    ).includes("relevé"));
  });

  it("signale un relevé périmé", () => {
    const result = importReleve(releve([{ nom: "Penne", prix: 1.42, releveLe: "2020-01-01" }]));
    assert.equal(coverage(result.catalog.products).stale, 1);
  });
});

describe("priorité entre sources", () => {
  it("laisse le relevé du jour l'emporter sur une correction ancienne", () => {
    const collecte = importReleve(
      releve([{ nom: "Penne", prix: 1.42, releveLe: today }]),
    ).catalog;

    const avec = applyOverrides(collecte, [
      { productId: "es-penne", price: 9.99, at: "2020-01-01" },
    ]);

    assert.equal(
      avec.products.find((p) => p.id === "es-penne")!.price,
      1.42,
      "une saisie de 2020 ne doit pas écraser un relevé d'aujourd'hui",
    );
  });

  it("laisse une correction du jour l'emporter sur un relevé ancien", () => {
    const collecte = importReleve(
      releve([{ nom: "Penne", prix: 1.42, releveLe: "2020-01-01" }]),
    ).catalog;

    const avec = applyOverrides(collecte, [
      { productId: "es-penne", price: 2.05, at: today },
    ]);

    const penne = avec.products.find((p) => p.id === "es-penne")!;
    assert.equal(penne.price, 2.05);
    assert.equal(penne.priceFrom.source, "saisie");
  });

  it("applique toujours une correction sur un prix seulement estimé", () => {
    const avec = applyOverrides(seedCatalog, [
      { productId: "es-penne", price: 2.05, at: "2020-01-01" },
    ]);
    assert.equal(avec.products.find((p) => p.id === "es-penne")!.price, 2.05);
  });
});

describe("lecture d'une commande ou d'un ticket collé", () => {
  it("lit un ticket de caisse classique", () => {
    const { entries } = parseReceiptText(`
AUCHAN VILLARS
Ticket du 04/09/2026

PENNE 500G                 1,15 €
FILETS DE POULET 1KG       8,99 €
TOMATES PELEES 400G        0,85 €

TOTAL                     10,99 €
CB                        10,99 €
    `);

    assert.equal(entries.length, 3, "les trois produits, et rien d'autre");
    assert.deepEqual(entries.map((e) => e.prix), [1.15, 8.99, 0.85]);
    assert.ok(entries[0].nom?.includes("PENNE"));
  });

  it("ramène un lot au prix unitaire", () => {
    const { entries } = parseReceiptText("3 x Yaourt nature 4,50 €");
    assert.equal(entries[0].prix, 1.5, "4,50 € pour 3 font 1,50 € pièce");
  });

  it("accepte la notation x2 et les points de conduite", () => {
    const { entries } = parseReceiptText("x2 Mozzarella ............ 2,18");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prix, 1.09);
    assert.equal(entries[0].nom, "Mozzarella");
  });

  it("écarte les totaux, la TVA et les moyens de paiement", () => {
    const { entries, ignored } = parseReceiptText(`
Sous-total    12,00 €
TVA 5,5%       0,66 €
Remise        -1,00 €
Carte fidélité 2,00 €
Net à payer   11,66 €
Frais de livraison 3,90 €
    `);
    assert.equal(entries.length, 0, "aucune de ces lignes n'est un produit");
    assert.ok(ignored.length >= 5);
  });

  it("ne prend pas un grammage pour un prix", () => {
    const { entries } = parseReceiptText("Farine T55 1,00 kg");
    assert.equal(entries.length, 0, "« 1,00 kg » n'est pas un montant");
  });

  it("écarte une ligne sans libellé exploitable", () => {
    const { entries } = parseReceiptText("3901234567890   2,50 €\n****   1,00 €");
    assert.equal(entries.length, 0);
  });

  it("écarte un montant invraisemblable", () => {
    const { ignored } = parseReceiptText("Produit fantaisiste 999,00 €");
    assert.ok(ignored.some((i) => i.reason.includes("bornes")));
  });

  it("alimente le catalogue comme n'importe quelle autre source", () => {
    const { entries } = parseReceiptText("PENNE 500G   1,42 €");
    const result = mergeEntries(entries);
    assert.equal(result.matched, 1);
    const penne = result.catalog.products.find((p) => p.id === "es-penne")!;
    assert.equal(penne.price, 1.42);
    assert.equal(penne.priceFrom.source, "collecte");
  });
});

describe("relevé issu des données de page Auchan", () => {
  /** Reproduit fidèlement ce que le collecteur extrait d'une page de rayon. */
  const releveAuchan = releve([
    { nom: "Lait demi-écrémé UHT", ref: "14460", rayon: "CREMERIE", prix: 5.85,
      stock: "en_rayon", marque: "POUCE", magasin: "CLICK-AND-COLLECT CORTE" },
    { nom: "Noix de cajou grillées", ref: "848499", rayon: "FRUITS ET LEGUMES NEGOCE LS",
      prix: 5.29, stock: "rupture", magasin: "CLICK-AND-COLLECT CORTE" },
    { nom: "Lardons fumés", ref: "321576", rayon: "CHARCUTERIE LS", prix: 1.22,
      stock: "en_rayon", magasin: "CLICK-AND-COLLECT CORTE" },
    { nom: "Panés au poisson", ref: "303915", rayon: "POISSONNERIE LS", prix: 3.1,
      stock: "en_rayon", magasin: "CLICK-AND-COLLECT CORTE" },
  ]);

  it("applique prix et disponibilité aux produits reconnus", () => {
    const result = importReleve(releveAuchan);
    assert.ok(result.matched >= 2, `${result.matched} appariements`);
    assert.equal(result.storeLabel, "CLICK-AND-COLLECT CORTE");

    const lardons = result.catalog.products.find((p) => p.id === "bo-lardon")!;
    assert.equal(lardons.price, 1.22);
    assert.equal(lardons.stock, "en_rayon");
    assert.equal(lardons.priceFrom.store, "CLICK-AND-COLLECT CORTE");
  });

  it("traduit l'arborescence de rayons d'Auchan vers la nôtre", () => {
    const result = importReleve(releve([
      { nom: "Produit inédit crémerie", ref: "z1", rayon: "CREMERIE", prix: 2 },
      { nom: "Produit inédit charcuterie", ref: "z2", rayon: "CHARCUTERIE LS", prix: 3 },
      { nom: "Produit inédit poisson", ref: "z3", rayon: "POISSONNERIE LS", prix: 4 },
      { nom: "Produit inédit primeur", ref: "z4", rayon: "FRUITS ET LEGUMES NEGOCE LS", prix: 5 },
      { nom: "Produit inédit surgelé", ref: "z5", rayon: "Surgelés", prix: 6 },
    ]));

    const rayonDe = (nom: string) =>
      result.catalog.products.find((p) => p.name === nom)!.rayon;

    assert.equal(rayonDe("Produit inédit crémerie"), "Crémerie");
    assert.equal(rayonDe("Produit inédit charcuterie"), "Charcuterie & Traiteur");
    assert.equal(rayonDe("Produit inédit poisson"), "Poissonnerie");
    assert.equal(rayonDe("Produit inédit primeur"), "Fruits & Légumes");
    assert.equal(rayonDe("Produit inédit surgelé"), "Surgelés");
  });

  it("mémorise la référence magasin pour réapparier le relevé suivant", () => {
    const premier = importReleve(releve([
      { nom: "Lardons fumés", ref: "321576", prix: 1.22 },
    ])).catalog;

    // Le site change le libellé : seule la référence permet de retrouver le produit.
    const second = importReleve(
      releve([{ nom: "Allumettes de lardons fumés Pouce", ref: "321576", prix: 1.35 }]),
      premier,
    );

    assert.equal(second.added, 0, "la référence doit éviter un doublon");
    assert.equal(second.catalog.products.find((p) => p.id === "bo-lardon")!.price, 1.35);
  });

  it("ne range jamais une référence interne dans le champ code-barres", () => {
    const result = importReleve(releve([{ nom: "Lardons fumés", ref: "321576", prix: 1.22 }]));
    const lardons = result.catalog.products.find((p) => p.id === "bo-lardon")!;
    assert.equal(lardons.storeRef, "321576");
    assert.equal(lardons.ean, undefined, "un cug n'est pas un EAN et ne doit pas polluer Open Prices");
  });
});

describe("intégrité d'un import volumineux", () => {
  it("ne fusionne pas deux nouveaux produits aux libellés voisins", () => {
    // Le défaut d'origine : le premier produit ajouté servait de cible au
    // rapprochement de libellés pour les suivants, et les conditionnements
    // d'un même produit se confondaient.
    const result = importReleve(releve([
      { nom: "Yaourt nature brebis 4x125g", ref: "a1", prix: 2.4 },
      { nom: "Yaourt nature brebis 12x125g", ref: "a2", prix: 5.9 },
      { nom: "Yaourt nature brebis 16x125g", ref: "a3", prix: 7.2 },
    ]));

    // Le premier peut légitimement se rattacher au yaourt générique du
    // catalogue ; ce qui compte, c'est que les trois prix survivent sur trois
    // produits distincts au lieu de s'écraser sur un seul.
    const porteurs = result.catalog.products.filter((p) =>
      [2.4, 5.9, 7.2].includes(p.price),
    );
    assert.equal(porteurs.length, 3, "chaque conditionnement doit garder son prix");
    assert.equal(
      new Set(porteurs.map((p) => p.id)).size,
      3,
      "les trois prix doivent porter sur trois produits différents",
    );
  });

  it("dédoublonne malgré tout sur la référence, au sein d'un même import", () => {
    const result = importReleve(releve([
      { nom: "Produit vu deux fois", ref: "b1", prix: 2 },
      { nom: "Produit vu deux fois", ref: "b1", prix: 2.5 },
    ]));
    assert.equal(result.added, 1, "la même référence ne crée qu'un produit");
  });
});

describe("rapprochement de libellés, sur des cas réels du site", () => {
  it("ne confond pas un ingrédient avec un plat qui le contient", () => {
    // Défaut d'origine : « Sardines à l'huile d'olive » contient le texte
    // « huile d'olive », et le prix de la bouteille écrasait celui de la boîte.
    const result = importReleve(releve([
      { nom: "Huile d'olive", ref: "861991", prix: 7.02 },
    ]));

    assert.equal(
      result.catalog.products.find((p) => p.id === "es-huile-olive")!.price,
      7.02,
    );
    assert.equal(
      result.catalog.products.find((p) => p.id === "es-sardine")!.price,
      seedCatalog.products.find((p) => p.id === "es-sardine")!.price,
      "les sardines ne doivent pas hériter du prix de l'huile",
    );
  });

  it("refuse un rapprochement fondé sur un seul mot générique", () => {
    // « Huile de friture » et « Huile d'olive » ne partagent que « huile ».
    const result = importReleve(releve([
      { nom: "Huile de friture", ref: "763372", prix: 2.36 },
    ]));

    assert.equal(result.added, 1, "ce doit être un nouveau produit");
    assert.equal(
      result.catalog.products.find((p) => p.id === "es-huile-olive")!.price,
      seedCatalog.products.find((p) => p.id === "es-huile-olive")!.price,
    );
  });

  it("accepte un libellé qui précise le produit du catalogue", () => {
    const result = importReleve(releve([
      { nom: "Saumon fumé de l'Atlantique", ref: "15972", prix: 4.84 },
      { nom: "Rôti de porc cuit", ref: "943251", prix: 1.39 },
      { nom: "Double concentré de tomates", ref: "15934", prix: 1.37 },
    ]));

    assert.equal(result.matched, 3, "ces trois libellés précisent un produit connu");
    assert.equal(result.catalog.products.find((p) => p.id === "po-saumon-fume")!.price, 4.84);
    assert.equal(result.catalog.products.find((p) => p.id === "es-concentre")!.price, 1.37);
  });
});

describe("rayons non alimentaires", () => {
  const nonAlimentaires = releve([
    { nom: "Croquettes à la volaille pour chat", ref: "309258", rayon: "ANIMALERIE ALIMENTATION", prix: 2.51 },
    { nom: "Liquide vaisselle citron", ref: "39268", rayon: "ENTRETIEN DE LA MAISON", prix: 0.74 },
    { nom: "Dentifrice goût menthe", ref: "347480", rayon: "HYGIENE", prix: 0.53 },
    { nom: "Couches taille 4 (7-18kg)", ref: "25798", rayon: "BEBE ALIMENTS ET PUERICULTURE", prix: 8.07 },
    { nom: "Crème hydratante visage et corps", ref: "429344", rayon: "BEAUTE PARFUMERIE", prix: 1.67 },
    { nom: "Adoucissant liquide concentré", ref: "439419", rayon: "ENTRETIEN DU LINGE", prix: 2.3 },
    { nom: "FOIN", ref: "262163", rayon: "ANIMALERIE ACCESSOIRES", prix: 1.87 },
    { nom: "Bougies chauffe plats", ref: "545495", rayon: "ARTS DE LA TABLE", prix: 3.99 },
    { nom: "Allume feux liquide", ref: "460745", rayon: "JARDIN LS", prix: 3.79 },
  ]);

  it("n'en laisse entrer aucun dans un catalogue alimentaire", () => {
    const result = importReleve(nonAlimentaires);
    assert.equal(result.nonFood, 9);
    assert.equal(result.added, 0);
    assert.equal(result.matched, 0);
    assert.equal(
      result.catalog.products.length,
      seedCatalog.products.length,
      "le catalogue ne doit pas grossir d'un seul produit",
    );
  });

  it("écarte aussi un produit d'entretien qui ressemble à un aliment", () => {
    // « Lait nettoyant pour bébé » n'est pas du lait : le filtre passe avant
    // tout rapprochement de libellé.
    const result = importReleve(releve([
      { nom: "Lait nettoyant pour bébé", ref: "522582", rayon: "BEBE ALIMENTS ET PUERICULTURE", prix: 1.14 },
    ]));
    assert.equal(result.nonFood, 1);
    assert.equal(
      result.catalog.products.find((p) => p.id === "cr-lait-demi")!.price,
      seedCatalog.products.find((p) => p.id === "cr-lait-demi")!.price,
    );
  });

  it("signale un rayon inconnu au lieu de le classer en silence", () => {
    const result = importReleve(releve([
      { nom: "Cassoulet", ref: "749206", rayon: "SELF-DISCOUNT", prix: 1.99 },
    ]));
    assert.deepEqual(result.unknownAisles, ["SELF-DISCOUNT"]);
    assert.equal(result.added, 1, "le produit est conservé, seul son rayon est incertain");
  });

  it("laisse passer un relevé sans rayon, comme celui d'un ticket", () => {
    const { entries } = parseReceiptText("PENNE 500G   1,42 €");
    const result = mergeEntries(entries);
    assert.equal(result.nonFood, 0);
    assert.equal(result.matched, 1);
  });
});
