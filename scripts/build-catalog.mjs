/**
 * Génère data/catalog.json à partir d'une source compacte et relisible.
 *
 * Chaque produit est une ligne :
 *   [id, nom, catégorie, gamme, unité, contenance, prix, kcal, prot, gluc, lip,
 *    fibres, sel, conservation(j), refus, options]
 *
 * `refus` liste les régimes que le produit NE satisfait PAS ; tous les autres
 * sont accordés automatiquement. Un produit sans refus convient à tout le monde.
 * Les prix sont des relevés indicatifs Auchan métropole ; ils se recalent sur
 * ton magasin via l'import CSV (voir docs/SOURCES_DONNEES.md).
 *
 * Usage : node scripts/build-catalog.mjs
 */
import { writeFileSync } from "node:fs";

const ALL_DIETS = [
  "vegetarien", "vegan", "sans_porc", "sans_gluten",
  "sans_lactose", "sans_fruits_a_coque", "halal_compatible",
];

// Raccourcis pour les refus les plus fréquents.
const VIANDE = "vegetarien vegan";
const PORC = "vegetarien vegan sans_porc halal_compatible";
const LAIT = "vegan sans_lactose";
const GLUTEN = "sans_gluten";
const ALCOOL = "halal_compatible";

/** @type {Record<string, Array<any[]>>} */
const RAYONS = {
  "Fruits & Légumes": [
    ["fl-pomme-gala", "Pommes Gala", "fruit", "national", "g", 1000, 2.49, 52, 0.3, 14, 0.2, 2.4, 0, 12, ""],
    ["fl-banane", "Bananes", "fruit", "national", "g", 1000, 1.99, 89, 1.1, 23, 0.3, 2.6, 0, 7, ""],
    ["fl-orange", "Oranges à jus", "fruit", "national", "g", 2000, 3.49, 47, 0.9, 12, 0.1, 2.4, 0, 14, ""],
    ["fl-clementine", "Clémentines", "fruit", "national", "g", 1000, 2.99, 53, 0.8, 13, 0.2, 1.7, 0, 10, ""],
    ["fl-poire", "Poires Conférence", "fruit", "national", "g", 1000, 2.79, 57, 0.4, 15, 0.1, 3.1, 0, 10, ""],
    ["fl-kiwi", "Kiwis", "fruit", "national", "piece", 6, 2.49, 61, 1.1, 15, 0.5, 3, 0, 14, ""],
    ["fl-citron", "Citrons jaunes", "agrume", "national", "piece", 4, 1.79, 29, 1.1, 9, 0.3, 2.8, 0, 21, ""],
    ["fl-citron-vert", "Citrons verts", "agrume", "national", "piece", 3, 1.49, 30, 0.7, 11, 0.2, 2.8, 0, 21, ""],
    ["fl-fraise", "Fraises", "fruit", "national", "g", 250, 3.49, 32, 0.7, 8, 0.3, 2, 0, 4, ""],
    ["fl-raisin", "Raisin blanc", "fruit", "national", "g", 500, 2.99, 69, 0.7, 18, 0.2, 0.9, 0, 8, ""],
    ["fl-ananas", "Ananas", "fruit", "national", "piece", 1, 2.49, 50, 0.5, 13, 0.1, 1.4, 0, 7, ""],
    ["fl-avocat", "Avocats", "fruit", "national", "piece", 2, 2.99, 160, 2, 9, 15, 7, 0, 6, ""],
    ["fl-pdt", "Pommes de terre à chair ferme", "feculent-frais", "mdd", "g", 2500, 3.29, 77, 2, 17, 0.1, 2.2, 0, 30, ""],
    ["fl-patate-douce", "Patates douces", "feculent-frais", "national", "g", 1000, 3.29, 86, 1.6, 20, 0.1, 3, 0.06, 21, ""],
    ["fl-carotte", "Carottes", "legume", "mdd", "g", 1000, 1.29, 41, 0.9, 10, 0.2, 2.8, 0.07, 18, ""],
    ["fl-oignon", "Oignons jaunes", "aromate", "mdd", "g", 1000, 1.59, 40, 1.1, 9, 0.1, 1.7, 0, 90, ""],
    ["fl-echalote", "Échalotes", "aromate", "national", "g", 500, 2.49, 72, 2.5, 17, 0.1, 3.2, 0, 90, ""],
    ["fl-ail", "Ail", "aromate", "national", "piece", 3, 1.49, 149, 6.4, 33, 0.5, 2.1, 0, 120, ""],
    ["fl-gingembre", "Gingembre frais", "aromate", "national", "g", 150, 1.49, 80, 1.8, 18, 0.8, 2, 0, 21, ""],
    ["fl-courgette", "Courgettes", "legume", "national", "g", 1000, 2.29, 17, 1.2, 3.1, 0.3, 1, 0, 8, ""],
    ["fl-aubergine", "Aubergines", "legume", "national", "g", 1000, 2.99, 25, 1, 6, 0.2, 3, 0, 8, ""],
    ["fl-poivron", "Poivrons rouges", "legume", "national", "piece", 2, 2.49, 31, 1, 6, 0.3, 2.1, 0, 10, ""],
    ["fl-tomate", "Tomates grappe", "legume", "national", "g", 1000, 2.99, 18, 0.9, 3.9, 0.2, 1.2, 0, 7, ""],
    ["fl-tomate-cerise", "Tomates cerises", "legume", "national", "g", 500, 2.79, 18, 0.9, 3.9, 0.2, 1.2, 0, 7, "cru"],
    ["fl-concombre", "Concombre", "legume", "national", "piece", 1, 1.19, 15, 0.7, 3.6, 0.1, 0.5, 0, 7, "cru"],
    ["fl-salade", "Salade batavia", "legume", "national", "piece", 1, 1.29, 15, 1.4, 2.9, 0.2, 1.3, 0, 5, "cru"],
    ["fl-epinard", "Pousses d'épinard", "legume", "national", "g", 300, 2.49, 23, 2.9, 3.6, 0.4, 2.2, 0.08, 5, "cru"],
    ["fl-brocoli", "Brocoli", "legume", "national", "g", 500, 2.29, 34, 2.8, 7, 0.4, 2.6, 0.03, 8, ""],
    ["fl-chou-fleur", "Chou-fleur", "legume", "national", "piece", 1, 2.49, 25, 1.9, 5, 0.3, 2, 0.03, 8, ""],
    ["fl-haricot-vert", "Haricots verts frais", "legume", "national", "g", 500, 3.49, 31, 1.8, 7, 0.1, 2.7, 0, 6, ""],
    ["fl-champignon", "Champignons de Paris", "legume", "national", "g", 500, 2.79, 22, 3.1, 3.3, 0.3, 1, 0, 6, ""],
    ["fl-poireau", "Poireaux", "legume", "national", "g", 1000, 2.49, 61, 1.5, 14, 0.3, 1.8, 0, 10, ""],
    ["fl-celeri", "Céleri branche", "legume", "national", "piece", 1, 1.79, 16, 0.7, 3, 0.2, 1.6, 0.08, 10, "cru"],
    ["fl-butternut", "Courge butternut", "legume", "national", "piece", 1, 2.99, 45, 1, 12, 0.1, 2, 0, 30, ""],
    ["fl-betterave", "Betteraves cuites", "legume", "mdd", "g", 500, 2.19, 43, 1.6, 10, 0.2, 2.8, 0.1, 12, "cru"],
    ["fl-radis", "Radis", "legume", "national", "piece", 1, 1.29, 16, 0.7, 3.4, 0.1, 1.6, 0.04, 6, "cru"],
    ["fl-endive", "Endives", "legume", "national", "g", 1000, 2.99, 17, 1, 4, 0.1, 3.1, 0, 8, "cru"],
    ["fl-persil", "Persil plat", "herbe", "national", "g", 30, 0.99, 36, 3, 6, 0.8, 3.3, 0.06, 5, ""],
    ["fl-basilic", "Basilic en pot", "herbe", "national", "g", 40, 2.49, 23, 3.2, 2.7, 0.6, 1.6, 0, 10, ""],
    ["fl-coriandre", "Coriandre fraîche", "herbe", "national", "g", 30, 1.19, 23, 2.1, 3.7, 0.5, 2.8, 0, 5, ""],
  ],
  "Boucherie": [
    ["bo-hache-5", "Steaks hachés 5% MG", "boeuf", "mdd", "g", 250, 3.99, 130, 21, 0, 5, 0, 0.15, 3, VIANDE],
    ["bo-hache-15", "Steaks hachés 15% MG", "boeuf", "mdd", "g", 500, 5.49, 220, 19, 0, 15, 0, 0.15, 3, VIANDE],
    ["bo-bourguignon", "Bœuf à braiser (bourguignon)", "boeuf", "national", "g", 800, 11.9, 180, 20, 0, 11, 0, 0.1, 3, VIANDE],
    ["bo-entrecote", "Entrecôte de bœuf", "boeuf", "national", "g", 300, 8.99, 240, 20, 0, 18, 0, 0.1, 3, VIANDE],
    ["bo-roti-boeuf", "Rôti de bœuf", "boeuf", "national", "g", 800, 14.9, 175, 21, 0, 10, 0, 0.1, 3, VIANDE],
    ["bo-cote-porc", "Côtes de porc", "porc", "mdd", "g", 700, 6.49, 210, 22, 0, 14, 0, 0.1, 3, PORC],
    ["bo-echine", "Échine de porc", "porc", "mdd", "g", 1000, 7.99, 250, 19, 0, 20, 0, 0.1, 3, PORC],
    ["bo-roti-porc", "Rôti de porc", "porc", "national", "g", 900, 8.49, 200, 21, 0, 13, 0, 0.12, 3, PORC],
    ["bo-jarret", "Jarret de porc demi-sel", "porc", "national", "g", 800, 5.49, 230, 20, 0, 17, 0, 1.4, 4, PORC],
    ["bo-lardon", "Lardons fumés", "porc", "mdd", "g", 200, 2.79, 250, 16, 1, 20, 0, 2.2, 8, PORC],
    ["bo-toulouse", "Saucisses de Toulouse", "porc", "national", "g", 400, 4.99, 290, 16, 1, 25, 0, 1.5, 4, PORC],
    ["bo-merguez", "Merguez", "agneau", "national", "g", 400, 4.79, 300, 15, 1, 26, 0, 1.7, 4, VIANDE],
    ["bo-agneau", "Épaule d'agneau", "agneau", "national", "g", 1000, 13.9, 235, 18, 0, 18, 0, 0.15, 3, VIANDE],
    ["bo-veau", "Escalopes de veau", "veau", "national", "g", 300, 6.99, 120, 21, 0, 4, 0, 0.1, 3, VIANDE],
  ],
  "Volaille": [
    ["vo-filet-poulet", "Filets de poulet", "poulet", "mdd", "g", 1000, 8.99, 110, 23, 0, 1.5, 0, 0.1, 3, VIANDE],
    ["vo-aiguillette", "Aiguillettes de poulet", "poulet", "mdd", "g", 400, 4.99, 110, 23, 0, 1.5, 0, 0.1, 3, VIANDE],
    ["vo-cuisse-poulet", "Cuisses de poulet", "poulet", "mdd", "g", 900, 4.99, 180, 19, 0, 11, 0, 0.12, 3, VIANDE],
    ["vo-poulet-entier", "Poulet fermier entier", "poulet", "national", "g", 1400, 7.49, 165, 20, 0, 9, 0, 0.1, 4, VIANDE],
    ["vo-escalope-dinde", "Escalopes de dinde", "dinde", "mdd", "g", 500, 5.49, 105, 24, 0, 1, 0, 0.1, 3, VIANDE],
    ["vo-magret", "Magret de canard", "canard", "national", "g", 350, 9.99, 200, 19, 0, 14, 0, 0.15, 4, VIANDE],
  ],
  "Poissonnerie": [
    ["po-saumon", "Pavés de saumon", "poisson-gras", "national", "g", 250, 6.99, 208, 20, 0, 13, 0, 0.1, 2, VIANDE],
    ["po-cabillaud", "Dos de cabillaud", "poisson-blanc", "national", "g", 300, 6.49, 82, 18, 0, 0.7, 0, 0.2, 2, VIANDE],
    ["po-lieu", "Filets de lieu noir", "poisson-blanc", "mdd", "g", 400, 5.49, 90, 19, 0, 1, 0, 0.25, 2, VIANDE],
    ["po-truite", "Filets de truite", "poisson-gras", "national", "g", 250, 5.49, 145, 20, 0, 7, 0, 0.1, 2, VIANDE],
    ["po-crevette", "Crevettes roses cuites", "fruits-de-mer", "mdd", "g", 200, 5.99, 99, 24, 0.2, 0.3, 0, 1.5, 2, VIANDE],
    ["po-moule", "Moules de bouchot", "fruits-de-mer", "national", "g", 1000, 4.99, 86, 12, 3.7, 2.2, 0, 0.6, 2, VIANDE],
    ["po-saumon-fume", "Saumon fumé", "poisson-gras", "mdd", "g", 140, 5.99, 180, 23, 0.5, 10, 0, 3, 7, VIANDE + " cru"],
    ["po-sardine-fraiche", "Sardines fraîches", "poisson-gras", "national", "g", 500, 4.99, 165, 21, 0, 9, 0, 0.15, 2, VIANDE],
  ],
  "Charcuterie & Traiteur": [
    ["ch-jambon", "Jambon blanc découenné", "charcuterie", "mdd", "g", 160, 2.49, 110, 20, 1, 3, 0, 2, 6, PORC + " cru"],
    ["ch-jambon-dinde", "Jambon de dinde", "charcuterie", "mdd", "g", 160, 1.99, 100, 19, 1.5, 2, 0, 2, 6, VIANDE + " cru"],
    ["ch-chorizo", "Chorizo doux", "charcuterie", "national", "g", 100, 2.79, 380, 24, 2, 30, 0, 3.5, 21, PORC + " cru"],
    ["ch-saucisson", "Saucisson sec", "charcuterie", "national", "g", 200, 3.49, 420, 25, 2, 35, 0, 4.5, 30, PORC + " cru"],
    ["ch-coppa", "Coppa", "charcuterie", "national", "g", 80, 3.49, 340, 27, 1, 26, 0, 3.8, 14, PORC + " cru"],
    ["ch-bacon", "Bacon en tranches", "charcuterie", "mdd", "g", 150, 2.29, 210, 22, 1, 13, 0, 2.8, 8, PORC],
    ["ch-rillettes", "Rillettes du Mans", "charcuterie", "national", "g", 220, 2.49, 420, 17, 0.5, 39, 0, 1.6, 14, PORC + " cru"],
    ["ch-pate", "Pâté de campagne", "charcuterie", "mdd", "g", 180, 2.19, 330, 14, 2, 29, 0, 1.8, 14, PORC + " cru"],
    ["ch-poulet-roti", "Poulet rôti prêt à manger", "traiteur", "national", "g", 1100, 8.99, 190, 22, 1, 11, 0, 0.9, 2, VIANDE + " cru"],
  ],
  "Crémerie": [
    ["cr-lait-demi", "Lait demi-écrémé UHT", "lait", "mdd", "ml", 6000, 6.29, 46, 3.2, 4.8, 1.5, 0, 0.1, 90, LAIT],
    ["cr-lait-entier", "Lait entier UHT", "lait", "mdd", "ml", 1000, 1.19, 64, 3.2, 4.8, 3.6, 0, 0.1, 90, LAIT],
    ["cr-creme-epaisse", "Crème fraîche épaisse 30%", "creme", "mdd", "ml", 200, 1.49, 300, 2.4, 3, 30, 0, 0.1, 21, LAIT],
    ["cr-creme-liquide", "Crème liquide entière", "creme", "mdd", "ml", 200, 1.09, 300, 2.3, 3.2, 30, 0, 0.1, 60, LAIT],
    ["cr-beurre", "Beurre doux", "beurre", "mdd", "g", 250, 2.79, 745, 0.7, 0.7, 82, 0, 0.02, 45, LAIT],
    ["cr-beurre-sale", "Beurre demi-sel", "beurre", "mdd", "g", 250, 2.89, 740, 0.7, 0.7, 81, 0, 1.7, 45, LAIT],
    ["cr-oeuf", "Œufs plein air", "oeuf", "mdd", "piece", 12, 3.49, 143, 12.6, 0.7, 9.5, 0, 0.35, 21, "vegan"],
    ["cr-oeuf-bio", "Œufs bio", "oeuf", "bio", "piece", 6, 2.99, 143, 12.6, 0.7, 9.5, 0, 0.35, 21, "vegan"],
    ["cr-emmental", "Emmental râpé", "fromage", "mdd", "g", 200, 2.29, 380, 28, 1, 29, 0, 1, 21, LAIT],
    ["cr-comte", "Comté 12 mois", "fromage", "national", "g", 200, 4.49, 410, 27, 0.5, 33, 0, 0.8, 30, LAIT],
    ["cr-mozzarella", "Mozzarella", "fromage", "mdd", "g", 125, 1.09, 280, 18, 1, 22, 0, 1.2, 21, LAIT + " cru"],
    ["cr-parmesan", "Parmesan râpé", "fromage", "national", "g", 100, 2.99, 400, 32, 0.5, 29, 0, 1.6, 60, LAIT],
    ["cr-chevre", "Bûche de chèvre", "fromage", "national", "g", 180, 2.79, 290, 18, 1, 23, 0, 1.4, 21, LAIT + " cru"],
    ["cr-camembert", "Camembert", "fromage", "mdd", "g", 250, 2.19, 300, 20, 0.5, 24, 0, 1.6, 21, LAIT + " cru"],
    ["cr-reblochon", "Reblochon", "fromage", "national", "g", 450, 6.49, 330, 21, 0.5, 27, 0, 1.2, 21, LAIT + " cru"],
    ["cr-raclette", "Fromage à raclette en tranches", "fromage", "mdd", "g", 400, 4.99, 350, 23, 1, 28, 0, 1.5, 21, LAIT],
    ["cr-boursin", "Fromage ail & fines herbes", "fromage", "national", "g", 150, 2.49, 400, 7, 2, 39, 0, 1.4, 30, LAIT + " cru"],
    ["cr-ricotta", "Ricotta", "fromage", "national", "g", 250, 2.29, 150, 9, 3, 11, 0, 0.3, 14, LAIT + " cru"],
    ["cr-yaourt-nature", "Yaourts nature", "yaourt", "mdd", "g", 1500, 2.49, 60, 4, 5, 2.5, 0, 0.1, 21, LAIT + " cru"],
    ["cr-yaourt-grec", "Yaourts à la grecque", "yaourt", "national", "g", 600, 2.79, 115, 4.5, 4, 9, 0, 0.1, 21, LAIT + " cru"],
    ["cr-fromage-blanc", "Fromage blanc 3,2%", "yaourt", "mdd", "g", 1000, 2.49, 75, 7.5, 4, 3.2, 0, 0.1, 21, LAIT + " cru"],
    ["cr-skyr", "Skyr nature", "yaourt", "national", "g", 450, 2.99, 60, 11, 4, 0.2, 0, 0.1, 21, LAIT + " cru"],
    ["cr-petit-suisse", "Petits-suisses", "yaourt", "mdd", "g", 720, 2.19, 145, 9, 3, 10, 0, 0.1, 21, LAIT + " cru"],
    ["cr-pate-feuilletee", "Pâte feuilletée", "pate", "mdd", "g", 230, 1.49, 380, 5, 35, 24, 1.5, 1, 14, LAIT + " " + GLUTEN],
    ["cr-pate-brisee", "Pâte brisée", "pate", "mdd", "g", 230, 1.39, 375, 5.5, 40, 21, 1.8, 1.1, 14, LAIT + " " + GLUTEN],
    ["cr-pate-pizza", "Pâte à pizza", "pate", "mdd", "g", 260, 1.59, 270, 7, 45, 6, 2, 1.2, 14, GLUTEN],
    ["cr-tofu", "Tofu nature", "vegetal", "national", "g", 200, 2.49, 130, 14, 2, 8, 1, 0.02, 14, ""],
  ],
  "Boulangerie": [
    ["bl-baguette", "Baguette", "pain", "mdd", "piece", 1, 0.95, 270, 9, 55, 1, 3, 1.3, 1, GLUTEN],
    ["bl-campagne", "Pain de campagne", "pain", "mdd", "g", 400, 2.19, 260, 8.5, 52, 1.2, 3.5, 1.3, 3, GLUTEN],
    ["bl-mie-complet", "Pain de mie complet", "pain", "mdd", "g", 500, 1.79, 250, 9, 44, 4, 5, 1, 8, GLUTEN],
    ["bl-cereales", "Pain aux céréales", "pain", "mdd", "g", 400, 2.49, 265, 9.5, 45, 4.5, 6, 1.2, 4, GLUTEN],
    ["bl-buns", "Buns à burger", "pain", "mdd", "piece", 4, 1.79, 280, 8, 48, 5.5, 2.5, 1, 8, GLUTEN],
    ["bl-wrap", "Galettes wrap", "pain", "mdd", "piece", 6, 1.89, 300, 8, 50, 7, 3, 1.2, 20, GLUTEN],
    ["bl-pita", "Pains pita", "pain", "mdd", "piece", 6, 1.59, 275, 9, 53, 1.5, 2.5, 1.1, 10, GLUTEN],
    ["bl-croissant", "Croissants pur beurre", "viennoiserie", "mdd", "piece", 6, 2.99, 420, 7, 45, 23, 2, 0.9, 3, LAIT + " " + GLUTEN],
    ["bl-biscotte", "Biscottes", "pain", "mdd", "g", 300, 1.49, 390, 12, 72, 5, 4, 1.5, 90, GLUTEN],
  ],
  "Épicerie salée": [
    ["es-penne", "Penne", "pates", "mdd", "g", 500, 1.15, 350, 12, 70, 1.5, 3, 0, 400, GLUTEN],
    ["es-spaghetti", "Spaghetti", "pates", "mdd", "g", 500, 1.15, 350, 12, 70, 1.5, 3, 0, 400, GLUTEN],
    ["es-coquillette", "Coquillettes", "pates", "mdd", "g", 1000, 1.99, 350, 12, 70, 1.5, 3, 0, 400, GLUTEN],
    ["es-tagliatelle", "Tagliatelles fraîches", "pates", "national", "g", 400, 2.79, 270, 10, 50, 2.5, 2.5, 0.5, 20, GLUTEN + " " + LAIT],
    ["es-lasagne", "Plaques à lasagnes", "pates", "mdd", "g", 500, 1.99, 350, 12, 70, 1.5, 3, 0, 400, GLUTEN],
    ["es-riz-long", "Riz long grain", "riz", "mdd", "g", 1000, 2.49, 350, 7, 78, 0.6, 1.4, 0, 500, ""],
    ["es-basmati", "Riz basmati", "riz", "national", "g", 1000, 3.49, 350, 8, 77, 0.9, 1.5, 0, 500, ""],
    ["es-arborio", "Riz à risotto", "riz", "national", "g", 500, 2.49, 350, 7, 78, 0.6, 1.4, 0, 500, ""],
    ["es-quinoa", "Quinoa", "graine", "national", "g", 500, 3.99, 368, 14, 58, 6, 7, 0, 500, ""],
    ["es-boulgour", "Boulgour", "graine", "mdd", "g", 500, 1.99, 350, 12, 69, 1.5, 8, 0, 400, GLUTEN],
    ["es-semoule", "Semoule de blé moyenne", "graine", "mdd", "g", 1000, 2.29, 350, 12, 71, 1.3, 3.5, 0, 400, GLUTEN],
    ["es-lentille", "Lentilles vertes", "legumineuse", "mdd", "g", 500, 2.29, 336, 24, 50, 1.5, 11, 0, 500, ""],
    ["es-pois-chiche-sec", "Pois chiches secs", "legumineuse", "mdd", "g", 500, 1.99, 350, 19, 55, 5, 12, 0, 500, ""],
    ["es-pois-chiche", "Pois chiches cuisinés", "legumineuse", "mdd", "g", 400, 0.99, 120, 7, 16, 2, 6, 0.4, 500, "cru"],
    ["es-haricot-rouge", "Haricots rouges", "legumineuse", "mdd", "g", 400, 0.99, 115, 8, 15, 0.6, 7, 0.4, 500, "cru"],
    ["es-haricot-blanc", "Haricots blancs", "legumineuse", "mdd", "g", 400, 0.95, 110, 7, 15, 0.5, 6.5, 0.4, 500, "cru"],
    ["es-lentille-boite", "Lentilles cuisinées", "legumineuse", "mdd", "g", 400, 1.19, 105, 7, 15, 0.5, 6, 0.5, 500, "cru"],
    ["es-tomate-pelee", "Tomates pelées", "conserve-legume", "mdd", "g", 400, 0.85, 20, 1, 3.5, 0.2, 1.2, 0.1, 500, ""],
    ["es-tomate-concassee", "Tomates concassées", "conserve-legume", "mdd", "g", 400, 0.89, 22, 1.1, 3.8, 0.2, 1.3, 0.1, 500, ""],
    ["es-passata", "Purée de tomates", "conserve-legume", "national", "g", 690, 1.59, 32, 1.4, 5.5, 0.3, 1.5, 0.1, 500, ""],
    ["es-concentre", "Concentré de tomates", "conserve-legume", "mdd", "g", 210, 1.09, 90, 4.5, 15, 0.5, 3.5, 0.2, 500, ""],
    ["es-mais", "Maïs doux", "conserve-legume", "mdd", "g", 300, 1.19, 90, 3, 16, 1.2, 3, 0.4, 500, "cru"],
    ["es-champignon-boite", "Champignons émincés", "conserve-legume", "mdd", "g", 230, 1.09, 20, 2.5, 1, 0.3, 2, 0.5, 500, "cru"],
    ["es-artichaut", "Cœurs d'artichauts", "conserve-legume", "national", "g", 390, 2.49, 45, 2.5, 4, 1.5, 4, 0.7, 500, "cru"],
    ["es-olive", "Olives vertes dénoyautées", "conserve-legume", "mdd", "g", 200, 1.79, 145, 1, 1, 15, 3, 2.5, 500, "cru"],
    ["es-cornichon", "Cornichons", "conserve-legume", "mdd", "g", 350, 1.99, 20, 1, 2, 0.2, 1.5, 2, 500, "cru"],
    ["es-thon", "Thon au naturel", "conserve-poisson", "mdd", "g", 240, 3.49, 110, 25, 0, 1, 0, 0.9, 700, VIANDE + " cru"],
    ["es-sardine", "Sardines à l'huile d'olive", "conserve-poisson", "national", "g", 120, 1.49, 230, 22, 0, 16, 0, 1.1, 700, VIANDE + " cru"],
    ["es-huile-olive", "Huile d'olive vierge extra", "matiere-grasse", "mdd", "ml", 1000, 8.99, 900, 0, 0, 100, 0, 0, 500, ""],
    ["es-huile-tournesol", "Huile de tournesol", "matiere-grasse", "mdd", "ml", 1000, 2.49, 900, 0, 0, 100, 0, 0, 500, ""],
    ["es-balsamique", "Vinaigre balsamique", "condiment", "mdd", "ml", 250, 2.19, 110, 0.5, 25, 0, 0, 0.1, 700, ""],
    ["es-vinaigre-vin", "Vinaigre de vin rouge", "condiment", "mdd", "ml", 750, 1.09, 20, 0, 1, 0, 0, 0, 700, ""],
    ["es-moutarde", "Moutarde de Dijon", "condiment", "mdd", "g", 370, 1.79, 150, 8, 4, 11, 4, 6, 300, "cru"],
    ["es-ketchup", "Ketchup", "condiment", "national", "g", 560, 2.29, 100, 1.2, 22, 0.1, 1, 2, 300, "cru"],
    ["es-mayonnaise", "Mayonnaise", "condiment", "national", "g", 475, 2.79, 690, 1, 1.5, 75, 0, 1.3, 200, "vegan cru"],
    ["es-sauce-soja", "Sauce soja", "condiment", "national", "ml", 150, 1.99, 60, 6, 6, 0, 0, 16, 500, GLUTEN + " cru"],
    ["es-lait-coco", "Lait de coco", "condiment", "mdd", "ml", 400, 1.49, 190, 2, 3, 19, 0, 0.03, 500, ""],
    ["es-curry-pate", "Pâte de curry rouge", "condiment", "national", "g", 114, 2.29, 110, 2, 12, 5, 3, 6, 400, "cru"],
    ["es-harissa", "Harissa", "condiment", "national", "g", 70, 1.49, 150, 4, 10, 10, 5, 4, 400, "cru"],
    ["es-cacahuete-pate", "Beurre de cacahuète", "condiment", "national", "g", 350, 2.99, 600, 25, 12, 50, 6, 0.5, 300, "sans_fruits_a_coque cru"],
    ["es-curry", "Curry en poudre", "epice", "mdd", "g", 40, 1.29, 325, 13, 45, 14, 33, 0.1, 700, ""],
    ["es-paprika", "Paprika doux", "epice", "mdd", "g", 45, 1.19, 280, 14, 34, 13, 35, 0.1, 700, ""],
    ["es-cumin", "Cumin moulu", "epice", "mdd", "g", 40, 1.29, 375, 18, 44, 22, 11, 0.4, 700, ""],
    ["es-herbes", "Herbes de Provence", "epice", "mdd", "g", 20, 1.09, 260, 9, 45, 7, 30, 0.1, 700, ""],
    ["es-sel", "Sel fin", "epice", "mdd", "g", 1000, 0.55, 0, 0, 0, 0, 0, 100, 900, ""],
    ["es-poivre", "Poivre noir moulu", "epice", "mdd", "g", 50, 2.29, 250, 10, 39, 3, 26, 0.1, 700, ""],
    ["es-bouillon", "Bouillon de volaille en cubes", "epice", "national", "g", 240, 1.49, 230, 10, 20, 12, 1, 45, 500, VIANDE],
    ["es-bouillon-legume", "Bouillon de légumes en cubes", "epice", "national", "g", 240, 1.49, 220, 8, 22, 11, 1, 44, 500, ""],
    ["es-farine", "Farine de blé T55", "farine", "mdd", "g", 1000, 0.89, 350, 10, 71, 1, 3, 0, 300, GLUTEN],
    ["es-levure", "Levure chimique", "farine", "mdd", "g", 88, 1.19, 100, 0, 25, 0, 0, 25, 500, ""],
    ["es-chapelure", "Chapelure", "farine", "mdd", "g", 250, 1.19, 370, 12, 70, 3, 4, 1.3, 200, GLUTEN],
    ["es-nouille", "Nouilles chinoises", "pates", "national", "g", 250, 1.79, 350, 11, 70, 2, 3, 0.5, 300, GLUTEN],
    ["es-galette-riz", "Galettes de riz", "graine", "mdd", "g", 100, 1.99, 380, 8, 81, 3, 3, 0.1, 200, "cru"],
  ],
  "Épicerie sucrée": [
    ["su-sucre", "Sucre en poudre", "sucre", "mdd", "g", 1000, 1.19, 400, 0, 100, 0, 0, 0, 900, ""],
    ["su-sucre-vanille", "Sucre vanillé", "sucre", "mdd", "g", 60, 0.79, 390, 0, 97, 0, 0, 0, 700, ""],
    ["su-miel", "Miel toutes fleurs", "sucre", "national", "g", 500, 4.49, 320, 0.4, 80, 0, 0, 0, 700, "vegan cru"],
    ["su-choco-patissier", "Chocolat noir pâtissier", "chocolat", "mdd", "g", 200, 1.79, 500, 6, 50, 32, 9, 0.02, 300, "cru"],
    ["su-choco-lait", "Chocolat au lait", "chocolat", "national", "g", 200, 1.99, 545, 7, 57, 31, 2, 0.2, 300, LAIT + " cru"],
    ["su-cacao", "Cacao en poudre non sucré", "chocolat", "national", "g", 250, 2.99, 350, 20, 12, 22, 30, 0.05, 500, ""],
    ["su-tartinade", "Pâte à tartiner noisettes", "chocolat", "national", "g", 400, 3.49, 540, 6, 57, 31, 3.5, 0.1, 300, LAIT + " sans_fruits_a_coque cru"],
    ["su-confiture", "Confiture de fraises", "sucre", "mdd", "g", 370, 1.99, 250, 0.4, 60, 0.1, 1, 0, 400, "cru"],
    ["su-compote", "Compotes pomme sans sucres ajoutés", "fruit-transforme", "mdd", "g", 1440, 2.99, 50, 0.3, 11, 0.1, 1.5, 0, 200, "cru"],
    ["su-sable", "Sablés pur beurre", "biscuit", "mdd", "g", 200, 1.49, 490, 6, 65, 22, 2, 0.6, 200, LAIT + " " + GLUTEN + " cru"],
    ["su-muesli", "Muesli aux fruits", "cereale", "mdd", "g", 750, 3.29, 380, 9, 62, 9, 8, 0.05, 200, GLUTEN + " sans_fruits_a_coque cru"],
    ["su-avoine", "Flocons d'avoine", "cereale", "mdd", "g", 500, 1.79, 370, 13, 58, 7, 10, 0, 300, GLUTEN],
    ["su-amande", "Amandes entières", "fruit-sec", "mdd", "g", 200, 3.49, 600, 21, 5, 50, 12, 0.01, 200, "sans_fruits_a_coque cru"],
    ["su-cajou", "Noix de cajou grillées", "fruit-sec", "national", "g", 200, 3.99, 580, 18, 27, 44, 3, 0.6, 200, "sans_fruits_a_coque cru"],
    ["su-raisin-sec", "Raisins secs", "fruit-sec", "mdd", "g", 250, 2.19, 300, 3, 66, 0.5, 4, 0.05, 300, "cru"],
    ["su-creme-marron", "Crème de marrons", "sucre", "national", "g", 500, 3.49, 280, 1.5, 68, 0.3, 2, 0.02, 400, "cru"],
  ],
  "Surgelés": [
    ["sg-epinard", "Épinards hachés surgelés", "legume-surgele", "mdd", "g", 750, 2.29, 25, 3, 1.5, 0.5, 3, 0.1, 300, ""],
    ["sg-haricot", "Haricots verts très fins surgelés", "legume-surgele", "mdd", "g", 1000, 2.79, 30, 2, 4, 0.2, 3.5, 0.01, 300, ""],
    ["sg-poelee", "Poêlée de légumes du soleil", "legume-surgele", "mdd", "g", 1000, 3.29, 45, 1.5, 6, 1.5, 2.5, 0.3, 300, ""],
    ["sg-petit-pois", "Petits pois surgelés", "legume-surgele", "mdd", "g", 1000, 2.49, 75, 5.5, 9, 0.5, 6, 0.01, 300, ""],
    ["sg-ratatouille", "Ratatouille surgelée", "legume-surgele", "mdd", "g", 1000, 3.49, 50, 1.2, 5, 2.5, 2, 0.5, 300, ""],
    ["sg-frite", "Frites surgelées", "feculent-surgele", "mdd", "g", 1000, 2.19, 160, 2.5, 25, 5, 3, 0.3, 300, ""],
    ["sg-potatoes", "Potatoes surgelées", "feculent-surgele", "mdd", "g", 750, 2.49, 175, 3, 26, 6.5, 3, 0.7, 300, GLUTEN],
    ["sg-colin", "Filets de colin surgelés", "poisson-surgele", "mdd", "g", 600, 5.99, 80, 17, 0, 1, 0, 0.3, 300, VIANDE],
    ["sg-crevette-crue", "Crevettes crues surgelées", "poisson-surgele", "mdd", "g", 400, 6.99, 85, 19, 0, 0.8, 0, 1.2, 300, VIANDE],
    ["sg-saumon-portion", "Portions de saumon surgelées", "poisson-surgele", "mdd", "g", 500, 8.49, 200, 20, 0, 13, 0, 0.2, 300, VIANDE],
    ["sg-nugget", "Nuggets de poulet", "plat-surgele", "mdd", "g", 500, 3.99, 250, 14, 18, 13, 1.5, 1.2, 300, VIANDE + " " + GLUTEN],
    ["sg-cordon-bleu", "Cordons bleus", "plat-surgele", "mdd", "g", 400, 3.49, 240, 15, 17, 13, 1, 1.4, 300, VIANDE + " " + GLUTEN + " " + LAIT],
    ["sg-pizza", "Pizza 4 fromages", "plat-surgele", "mdd", "g", 400, 3.29, 260, 11, 30, 10, 2, 1.3, 300, GLUTEN + " " + LAIT],
    ["sg-lasagne", "Lasagnes bolognaise surgelées", "plat-surgele", "national", "g", 1000, 5.49, 130, 7, 13, 5.5, 1.2, 0.7, 300, VIANDE + " " + GLUTEN + " " + LAIT],
    ["sg-glace", "Glace vanille", "dessert-surgele", "mdd", "ml", 1000, 3.49, 200, 3.5, 24, 10, 0, 0.15, 300, LAIT + " cru"],
    ["sg-fruit-rouge", "Fruits rouges surgelés", "fruit-surgele", "mdd", "g", 450, 3.99, 45, 1, 8, 0.4, 4, 0, 300, ""],
    ["sg-pain-ail", "Pains à l'ail", "plat-surgele", "mdd", "g", 350, 1.99, 320, 8, 42, 13, 2.5, 1.3, 300, GLUTEN + " " + LAIT],
  ],
  "Boissons": [
    ["bs-eau", "Eau de source", "eau", "mdd", "ml", 9000, 1.79, 0, 0, 0, 0, 0, 0, 700, "cru"],
    ["bs-eau-gaz", "Eau gazeuse", "eau", "mdd", "ml", 6000, 2.99, 0, 0, 0, 0, 0, 0.02, 700, "cru"],
    ["bs-jus-orange", "Jus d'orange sans pulpe", "jus", "mdd", "ml", 1000, 1.79, 45, 0.7, 10, 0.1, 0.2, 0, 200, "cru"],
    ["bs-jus-pomme", "Jus de pomme", "jus", "mdd", "ml", 1000, 1.49, 46, 0.1, 11, 0.1, 0.1, 0, 200, "cru"],
    ["bs-cola", "Cola", "soda", "national", "ml", 1980, 4.99, 42, 0, 10.6, 0, 0, 0, 300, "cru"],
    ["bs-limonade", "Limonade", "soda", "mdd", "ml", 1500, 1.19, 38, 0, 9.5, 0, 0, 0, 300, "cru"],
    ["bs-biere", "Bière blonde", "alcool", "national", "ml", 1500, 3.99, 40, 0.4, 3, 0, 0, 0, 400, ALCOOL + " cru"],
    ["bs-vin-rouge", "Vin rouge de Bordeaux", "alcool", "national", "ml", 750, 4.99, 80, 0.1, 2.6, 0, 0, 0, 900, ALCOOL + " cru"],
    ["bs-vin-blanc", "Vin blanc sec", "alcool", "national", "ml", 750, 3.99, 75, 0.1, 2.2, 0, 0, 0, 900, ALCOOL + " cru"],
    ["bs-cafe", "Café moulu", "chaud", "mdd", "g", 250, 3.49, 5, 0.2, 0, 0, 0, 0, 400, ""],
    ["bs-the", "Thé vert", "chaud", "mdd", "g", 45, 2.29, 2, 0, 0, 0, 0, 0, 500, ""],
    ["bs-sirop", "Sirop de menthe", "sirop", "national", "ml", 750, 2.49, 260, 0, 65, 0, 0, 0, 500, "cru"],
  ],
  "Monde & Apéritif": [
    ["ap-chips", "Chips nature", "apero", "mdd", "g", 150, 1.49, 540, 6, 50, 34, 4, 1.2, 150, "cru"],
    ["ap-chips-bbq", "Chips saveur barbecue", "apero", "national", "g", 150, 1.59, 520, 6, 52, 31, 4, 1.6, 150, "cru"],
    ["ap-cacahuete", "Cacahuètes grillées salées", "apero", "mdd", "g", 200, 1.79, 600, 26, 12, 49, 8, 1.2, 200, "sans_fruits_a_coque cru"],
    ["ap-tortilla", "Tortilla chips", "apero", "national", "g", 200, 1.99, 490, 7, 60, 24, 5, 1.1, 150, "cru"],
    ["ap-guacamole", "Guacamole", "dip", "national", "g", 200, 2.79, 180, 2, 5, 16, 4, 1.2, 14, "cru"],
    ["ap-houmous", "Houmous", "dip", "national", "g", 175, 2.29, 280, 8, 12, 22, 6, 1.1, 14, "cru"],
    ["ap-tzatziki", "Tzatziki", "dip", "national", "g", 175, 1.99, 130, 4, 4, 11, 0.5, 1, 14, LAIT + " cru"],
    ["ap-salsa", "Sauce salsa", "dip", "national", "g", 300, 2.19, 55, 1.5, 9, 1, 2, 1.4, 200, "cru"],
    ["ap-cracker", "Crackers apéritif", "apero", "mdd", "g", 100, 1.29, 480, 9, 60, 22, 3, 2.2, 150, GLUTEN + " cru"],
  ],
};

const products = [];
const seenIds = new Set();

for (const [rayon, rows] of Object.entries(RAYONS)) {
  for (const row of rows) {
    const [id, name, category, brandTier, unit, packSize, price,
           kcal, protein, carbs, fat, fiber, salt, shelfLifeDays, flags] = row;

    if (seenIds.has(id)) throw new Error(`Identifiant en double : ${id}`);
    seenIds.add(id);

    const tokens = String(flags).split(/\s+/).filter(Boolean);
    const readyToEat = tokens.includes("cru");
    const denied = new Set(tokens.filter((t) => t !== "cru"));

    for (const d of denied) {
      if (!ALL_DIETS.includes(d)) throw new Error(`Régime inconnu « ${d} » sur ${id}`);
    }
    // Cohérence : ce qui n'est pas végétarien ne peut pas être vegan.
    if (denied.has("vegetarien")) denied.add("vegan");

    products.push({
      id, name, rayon, category, brandTier, unit, packSize,
      price: Number(price.toFixed(2)),
      diet: ALL_DIETS.filter((d) => !denied.has(d)),
      nutrition: { kcal, protein, carbs, fat, fiber, salt },
      shelfLifeDays,
      stock: "en_rayon",
      ...(readyToEat ? { readyToEat: true } : {}),
    });
  }
}

const catalog = {
  products,
  source: "seed",
  updatedAt: new Date().toISOString().slice(0, 10),
  storeLabel: "Relevé indicatif Auchan métropole",
};

writeFileSync(
  new URL("../data/catalog.json", import.meta.url),
  JSON.stringify(catalog, null, 2) + "\n",
);

console.log(`${products.length} produits écrits dans data/catalog.json`);
const parRayon = {};
for (const p of products) parRayon[p.rayon] = (parRayon[p.rayon] ?? 0) + 1;
console.table(parRayon);
