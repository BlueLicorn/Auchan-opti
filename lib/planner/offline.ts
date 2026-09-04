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
   * L'emplacement part en cuisson : les produits qui se mangent froids en sont
   * écartés — concombre, radis, saucisson, saumon fumé. Sans ce garde-fou, le
   * planificateur met un concombre dans un gratin parce qu'il est bon marché,
   * et saisit un pâté de campagne trois minutes par face.
   */
  cooked?: boolean;
  /**
   * Nature de l'emplacement, qui détermine comment il réagit à un budget
   * serré. Manger à 1 € la portion, ce n'est pas manger la même assiette en
   * plus petit : c'est moins de protéine animale, plus de féculent, et
   * quasiment plus de fromage ni de crème.
   */
  kind?: "proteine" | "feculent" | "legume" | "extra";
  /**
   * L'emplacement supporte un légume sec. Il faut pour cela que le plat cuise
   * longtemps et à l'eau : un mijoté, une soupe. Partout ailleurs, des pois
   * chiches secs sont immangeables — ils finissaient pourtant en salade froide.
   */
  longCook?: boolean;
  /**
   * Interdit le repli sur les légumineuses quand le budget serre. Les étapes
   * de ce gabarit parlent de viande et n'ont aucun sens sans elle.
   */
  noFallback?: boolean;
}

/** Ce que le remplissage a réellement mis dans le plat, pour rédiger les étapes. */
interface StepContext {
  /** L'emplacement principal est-il tenu par une protéine animale ? */
  proteineAnimale: boolean;
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
  steps: (names: Record<string, string>, ctx: StepContext) => string[];
  tips: string[];
}

/** Catégories dont un produit se coupe, se saisit et se dore comme une viande. */
const CATEGORIES_ANIMALES = new Set([
  "boeuf", "porc", "agneau", "veau", "canard", "poulet", "dinde", "lapin",
  "poisson-blanc", "poisson-gras", "fruits-de-mer", "charcuterie",
  "poisson-surgele", "conserve-poisson", "viande-surgelee",
]);

/**
 * Ce qu'on accepte de payer, en euros, pour ne pas resservir un produit déjà
 * utilisé une fois de plus. Comparé à des coûts marginaux réels, donc exprimé
 * dans la même unité qu'eux.
 */
const PRIX_DE_LA_VARIETE = 0.5;

/**
 * Écart de prix à l'intérieur duquel deux produits sont tenus pour équivalents
 * et départagés au hasard, exprimé en part du budget d'un repas.
 *
 * Sans ce jeu, le planificateur est strictement déterministe : le produit le
 * moins cher de sa catégorie gagne toujours, et deux générations de suite
 * rendent la même liste au produit près. C'est ce qui donne l'impression que le
 * catalogue tient en vingt articles.
 *
 * En part du budget et non en euros fixes, parce qu'une marge de cinquante
 * centimes par emplacement ne veut pas dire la même chose à six euros le repas
 * qu'à deux : au forfait, elle faisait déraper les paniers serrés de moitié.
 * Elle s'annule en outre quand le budget serre, où il n'y a rien à arbitrer.
 */
const EQUIVALENCE_PART_DU_REPAS = 0.08;

/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 *
 * Déterministe et non pas `Math.random` : à graine égale, le plan est
 * reproductible — c'est indispensable pour les tests, et pour que le plancher
 * budgétaire annoncé à l'utilisateur ne change pas d'un affichage à l'autre.
 */
function melangeur(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  const elide = /^[aeiouyœæàâéèêëîïôöùûü]/.test(lower)
    || (lower.startsWith("h") && !H_ASPIRE.test(lower));
  return elide ? `d'${lower}` : `de ${lower}`;
}

/** Formulation standard d'un ingrédient : « 300 g de carottes », « 20 g d'ail ». */
const portion = (product: Product, quantity: number) =>
  `${grams(product, quantity)} ${de(product.name)}`;

const TEMPLATES: Template[] = [
  {
    id: "poelee",
    title: (main) => `Poêlée ${de(main.name)} aux légumes`,
    description: "Un plat complet à la poêle, prêt en une demi-heure, sans vaisselle inutile.",
    skill: 1,
    equipment: ["poele", "plaques"],
    prepMinutes: 10,
    cookMinutes: 20,
    indulgence: 25,
    slots: [
      { categories: ["poulet", "dinde", "boeuf", "veau", "poisson-blanc", "poisson-gras", "vegetal", "oeuf", "legumineuse"], perServing: 150, kind: "proteine", cooked: true, phrase: portion },
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
      `Pendant ce temps, cuire ${n.s1 ?? "le féculent"} à l'eau bouillante salée, puis égoutter.`,
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
      { categories: ["boeuf", "porc", "agneau", "veau", "canard", "poulet", "legumineuse"], perServing: 160, kind: "proteine", longCook: true, cooked: true, phrase: portion },
      { categories: ["legume"], perServing: 180, kind: "legume", cooked: true, phrase: portion },
      { categories: ["conserve-legume"], perServing: 120, phrase: portion },
      { categories: ["aromate"], perServing: 40, phrase: portion },
      { categories: ["epice"], perServing: 2, phrase: portion },
      { categories: ["feculent-frais", "riz", "pates"], perServing: 80, kind: "feculent", phrase: portion },
    ],
    steps: (n, ctx) => [
      ctx.proteineAnimale
        ? `Couper ${n.s0 ?? "la viande"} en gros cubes, puis faire dorer dans la cocotte sur toutes les faces, sans rien bouger trop tôt.`
        : `Égoutter et rincer ${n.s0 ?? "la légumineuse"}, puis réserver à part : l'ajout se fait en fin de cuisson, sinon tout s'écrase.`,
      `Émincer finement ${n.s3 ?? "les aromates"}, puis faire suer 5 minutes dans un filet d'huile chaude.`,
      ctx.proteineAnimale
        ? `Remettre la viande, puis ajouter ${n.s2 ?? "les tomates"} et ${n.s1 ?? "les légumes"}, en morceaux réguliers.`
        : `Ajouter ${n.s2 ?? "les tomates"} et ${n.s1 ?? "les légumes"}, en morceaux réguliers.`,
      `Assaisonner avec ${n.s4 ?? "les épices"}, couvrir d'eau à hauteur, porter à frémissement.`,
      ctx.proteineAnimale
        ? `Couvrir et laisser mijoter 1 heure à feu doux, en remuant toutes les 20 minutes.`
        : `Couvrir et laisser mijoter 45 minutes, puis ajouter ${n.s0 ?? "la légumineuse"} et poursuivre 15 minutes.`,
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
      `Verser ${n.s2 ?? "la crème"} sur l'ensemble, puis parsemer de ${n.s1 ?? "fromage"}.`,
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
      { categories: ["charcuterie", "boeuf", "poulet", "legumineuse", "vegetal", "conserve-poisson", "fruits-de-mer", "poisson-gras"], perServing: 100, kind: "proteine", phrase: portion },
      { categories: ["conserve-legume"], perServing: 150, phrase: portion },
      { categories: ["fromage"], perServing: 35, kind: "extra", phrase: portion },
      { categories: ["aromate"], perServing: 25, phrase: portion },
      { categories: ["herbe"], perServing: 4, phrase: portion, optional: true },
    ],
    steps: (n) => [
      `Porter une grande casserole d'eau généreusement salée à ébullition.`,
      `Hacher finement ${n.s4 ?? "l'aromate"}, puis faire revenir 3 minutes dans un filet d'huile, sans laisser brûler.`,
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
      { categories: ["poulet", "porc", "veau", "canard", "poisson-blanc", "poisson-gras", "vegetal"], perServing: 180, kind: "proteine", cooked: true, phrase: portion },
      { categories: ["feculent-frais", "feculent-surgele"], perServing: 200, kind: "feculent", phrase: portion },
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
      { categories: ["conserve-poisson", "charcuterie", "fromage", "legumineuse", "oeuf", "poisson-gras", "fruits-de-mer", "traiteur"], perServing: 90, kind: "proteine", phrase: portion },
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
      { categories: ["boeuf", "porc", "poulet", "canard", "veau", "charcuterie"], perServing: 200, kind: "proteine", noFallback: true, cooked: true, phrase: portion },
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
      `Hacher ${n.s4 ?? "l'échalote"} et faire suer dans la même poêle, puis déglacer avec un fond d'eau en grattant les sucs.`,
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
      { categories: ["legumineuse", "graine", "riz"], perServing: 60, kind: "proteine", longCook: true, phrase: portion },
      { categories: ["aromate"], perServing: 40, phrase: portion },
      { categories: ["epice"], perServing: 4, phrase: portion },
      { categories: ["creme", "lait"], perServing: 40, phrase: portion, optional: true },
      { categories: ["pain"], perServing: 60, kind: "feculent", phrase: portion },
    ],
    steps: (n) => [
      `Éplucher et couper ${n.s0 ?? "les légumes"} en morceaux grossiers, l'aspect final importe peu.`,
      `Faire revenir ${n.s2 ?? "l'oignon"} 5 minutes dans un filet d'huile au fond de la cocotte.`,
      `Rincer ${n.s1 ?? "la légumineuse"} à l'eau claire, puis ajouter aux légumes avec ${n.s3 ?? "les épices"} et couvrir d'eau à deux centimètres au-dessus.`,
      `Porter à ébullition puis laisser cuire 30 minutes à couvert, jusqu'à ce que tout s'écrase à la fourchette.`,
      `Mixer par à-coups pour garder un peu de texture, rectifier le sel.`,
      `Faire griller ${n.s5 ?? "le pain"} et servir avec la soupe.`,
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

export function planOffline(request: PlanRequest, pool: Product[], seed = 0): Recipe[] {
  const hasard = melangeur(seed);
  const budgetParRepas = request.budget / Math.max(1, request.meals);
  const pressure = budgetPressure(request);
  const usable = TEMPLATES.filter((template) =>
    template.equipment.every((e) => request.equipment.includes(e))
    && template.skill <= request.skill
    && template.prepMinutes + template.cookMinutes <= request.maxPrepMinutes,
  );

  const retenus = usable.length > 0 ? usable : TEMPLATES.filter((t) => t.equipment.length === 0);

  // Un plat « façon plaisir, sauce crémeuse » à un euro la portion n'existe
  // pas : il lui faut une viande, de la crème, du beurre et un fromage, soit
  // près de sept euros pour deux. Le servir quand même revenait à le dénaturer
  // — des pois chiches à la crème — ou à faire exploser le budget d'un
  // cinquième du panier. Sous contrainte, on cuisine simplement.
  const plafond = 100 - 45 * pressure;
  const abordables = retenus.filter((t) => t.indulgence <= plafond);

  const candidates = (abordables.length >= 3 ? abordables : retenus)
    .slice()
    .sort((a, b) => Math.abs(a.indulgence - request.indulgence) - Math.abs(b.indulgence - request.indulgence));

  if (candidates.length === 0) return [];

  // Le tri par proximité avec le curseur plaisir décide quels gabarits sont
  // pertinents ; il ne devrait pas décider qu'ils sortent toujours dans cet
  // ordre-là. On fait tourner le départ, sinon six repas donnent six fois le
  // même menu dans le même ordre, génération après génération.
  //
  // La rotation reste cantonnée aux gabarits les plus proches du curseur
  // plaisir : la varier sur toute la liste reviendrait à servir un plat de
  // fête à qui a demandé de l'équilibre.
  const pertinents = Math.min(candidates.length, Math.max(request.meals, 4));
  const depart = Math.floor(hasard() * pertinents);

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
    // Un gabarit peut se révéler impossible à remplir — sans gluten, il n'y a
    // pas de pâtes. Le repas était alors silencieusement perdu et l'on rendait
    // cinq recettes pour six demandées. On essaie les gabarits suivants.
    let recipe: Recipe | undefined;
    for (let essai = 0; essai < candidates.length && !recipe; essai++) {
      recipe = fillTemplate(
        candidates[(depart + i + essai) % candidates.length],
        i, request, byCategory, usedMains, usageCount, committed, pressure, hasard,
        budgetParRepas * EQUIVALENCE_PART_DU_REPAS * (1 - pressure),
      );
    }
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
  hasard: () => number,
  equivalence: number,
): Recipe | undefined {
  const ingredients: RecipeIngredient[] = [];
  const names: Record<string, string> = {};
  /** Produit qui donnera son nom au plat. */
  let mainProduct: Product | undefined;
  /** Produits déjà retenus ici : une liste d'ingrédients ne se répète pas. */
  const chosen = new Set<string>();
  /** Ce que le remplissage a réellement retenu, pour rédiger les étapes. */
  let proteineAnimale = false;
  /** Légumes secs à faire tremper la veille, s'il y en a. */
  const aTremper: Product[] = [];

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
      hasard,
      equivalence,
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
    if (slot.kind === "proteine" && CATEGORIES_ANIMALES.has(product.category)) {
      proteineAnimale = true;
    }
    if (product.needsSoaking) aTremper.push(product);

    const quantity = roundQuantity(gramsToProductQuantity(needed, product), product);
    const label = slot.phrase(product, quantity);
    // Les étapes reprennent l'ingrédient AVEC sa quantité — « 40 g d'ail »,
    // pas « ail ». C'est l'usage en cuisine, et surtout c'est la seule forme
    // qui reste correcte sans connaître le genre du produit : « arroser de
    // huile de tournesol » et « Émincer ail » ne veulent rien dire.
    names[`s${slotIndex}`] = label;
    ingredients.push({
      productId: product.id,
      quantity,
      label,
      ...(slot.optional ? { optional: true } : {}),
    });
  }

  if (!mainProduct || ingredients.length < 2) return undefined;

  // Le trempage est du temps d'attente, pas du travail : il n'entre pas dans
  // le temps de préparation, mais il doit être dit — et dit en premier, sinon
  // il est lu trop tard.
  const trempage = aTremper.map((product) => product.name.toLowerCase());
  const steps = template.steps(names, { proteineAnimale });
  const tips = [...template.tips];
  if (trempage.length > 0) {
    steps.unshift(
      `La veille : couvrir ${trempage.join(" et ")} de trois fois leur volume`
      + ` d'eau froide et laisser tremper une nuit, puis égoutter et rincer.`,
    );
    tips.push(
      "Sans trempage, un légume sec reste dur quelle que soit la durée de cuisson."
      + " À défaut, prendre la version en conserve, déjà cuite.",
    );
  }

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
    steps,
    tips,
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
  hasard: () => number,
  equivalence: number,
): Product | undefined {
  const notes: { product: Product; score: number }[] = [];

  // Sous forte contrainte, un emplacement protéiné peut se replier sur des
  // légumineuses même si le gabarit ne les listait pas : c'est ce qu'on fait
  // réellement quand la viande ne rentre pas dans le budget.
  const categories = slot.kind === "proteine" && pressure > 0.55 && !slot.noFallback
    ? [...slot.categories, ...REPLIS_PROTEINES.filter((c) => !slot.categories.includes(c))]
    : slot.categories;

  // Toutes les catégories acceptables sont évaluées, avec une légère prime à
  // celles listées en premier : mieux vaut une escalope de dinde bien
  // dimensionnée qu'un poulet dont on jettera les deux tiers.
  for (const [rank, category] of categories.entries()) {
    const bucket = byCategory.get(category);
    if (!bucket?.length) continue;

    for (const product of bucket) {
      if (slot.cooked && product.servedCold) continue;
      // Un légume sec demande une cuisson longue à l'eau. Ailleurs, il est
      // simplement immangeable : mieux vaut ne pas remplir l'emplacement.
      if (product.dryPulse && !slot.longCook) continue;
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

      // La variété se paie, et se paie en euros — pas en pourcentage.
      //
      // En facteur multiplicatif, cette pénalité était inerte : dès qu'un
      // paquet est ouvert, le coût marginal du produit tombe à zéro, et zéro
      // multiplié par n'importe quelle pénalité fait toujours zéro. Le produit
      // déjà entamé gagnait donc tous les emplacements suivants, quel que soit
      // le nombre de fois qu'il avait déjà servi : le menu se refermait sur une
      // poignée d'articles et la liste de courses paraissait minuscule.
      //
      // Ajoutée, elle pèse aussi sur un coût nul : reprendre un produit pour la
      // troisième fois doit valoir mieux qu'un article neuf à un euro. Elle
      // s'efface quand le budget serre, car c'est précisément la répétition qui
      // rend un panier contraint tenable.
      const dejaVu = usageCount.get(product.id) ?? 0;
      const variete = dejaVu * PRIX_DE_LA_VARIETE * (1 - pressure);

      const score = cost * (1 + (perishable ? wasteRatio : 0))
        * (1 + rank * 0.03)
        + variete
        + (avoid.has(product.id) ? 1000 : 0);

      notes.push({ product, score });
    }
  }

  if (notes.length === 0) return undefined;

  const meilleur = notes.reduce((a, b) => (b.score < a.score ? b : a));

  // Départager au hasard les produits que rien ne sépare vraiment. Le seuil est
  // un montant, pas une proportion : à budget large, deux protéines à moins de
  // quarante centimes d'écart se valent, et alterner entre elles ne coûte rien
  // qui se voie sur le ticket.
  const exaequo = notes.filter((note) => note.score <= meilleur.score + equivalence);
  return exaequo[Math.floor(hasard() * exaequo.length)]?.product ?? meilleur.product;
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
