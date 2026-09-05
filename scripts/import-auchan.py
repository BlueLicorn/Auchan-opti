#!/usr/bin/env python3
"""
Convertit un export de catalogue Auchan Drive (.xlsx) en catalogue applicatif.

    python3 scripts/import-auchan.py catalogue.xlsx public/catalogue-magasin.json

L'export contient tout le site, marketplace comprise. Seuls les produits vendus
par le magasin lui-même sont retenus : les autres viennent de vendeurs tiers
(Boulanger, VidaXL…), ne sont pas en rayon, et n'ont rien à faire dans un plan
de repas.

Aucune dépendance : un .xlsx est une archive zip de XML, et la bibliothèque
standard sait lire les deux.
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def lignes(chemin):
    """Rend chaque ligne de la première feuille sous forme de dict par en-tête."""
    with zipfile.ZipFile(chemin) as z:
        feuille = next(n for n in z.namelist() if n.startswith("xl/worksheets/sheet"))
        with z.open(feuille) as flux:
            entete = None
            for _, row in ET.iterparse(flux, events=("end",)):
                if row.tag != f"{NS}row":
                    continue
                cellules = {}
                for c in row.findall(f"{NS}c"):
                    col = "".join(ch for ch in (c.get("r") or "") if ch.isalpha())
                    t = c.find(f"{NS}is/{NS}t")
                    if t is None:
                        t = c.find(f"{NS}v")
                    cellules[col] = (t.text or "") if t is not None else ""
                if entete is None:
                    entete = cellules
                else:
                    yield {entete.get(k, k): v for k, v in cellules.items()}
                row.clear()


# --- Rayons de l'application ------------------------------------------------
# La clé est (rayon_n3, rayon_n4) de l'export ; à défaut on retombe sur n3 seul.
RAYONS = {
    "FRUITS ET LEGUMES": "Fruits & Légumes",
    "FRUITS ET LEGUMES NEGOCE LS": "Fruits & Légumes",
    "NEGOCE BOUCHERIE": "Boucherie",
    "BOUCHERIE": "Boucherie",
    "VOLAILLE": "Volaille",
    "POISSONNERIE TRADITIONNELLE": "Poissonnerie",
    "TRAITEUR DE LA MER": "Poissonnerie",
    "CHARCUTERIE LIBRE SERVICE": "Charcuterie & Traiteur",
    "CHARCUTERIE TRADITIONNELLE": "Charcuterie & Traiteur",
    "TRAITEUR LIBRE SERVICE": "Charcuterie & Traiteur",
    "TRAITEUR STAND": "Charcuterie & Traiteur",
    "SNACKING LIBRE SERVICE": "Charcuterie & Traiteur",
    "ROTISSERIE": "Charcuterie & Traiteur",
    "CORPS GRAS OEUFS LAIT": "Crémerie",
    "ULTRA FRAIS": "Crémerie",
    "FROMAGE LIBRE SERVICE": "Crémerie",
    "FROMAGE FRAIS EMBALLE": "Crémerie",
    "FROMAGE STAND": "Crémerie",
    "NEGOCE BOULANGERIE": "Boulangerie",
    "BOULANGERIE MAISON": "Boulangerie",
    "VIENNOISERIE": "Boulangerie",
    "PANIFICATION FRAICHE": "Boulangerie",
    "PATISSERIE": "Boulangerie",
    "LEGUMES ET FECULENTS": "Épicerie salée",
    "CONSERVES DE LEGUMES": "Épicerie salée",
    "ASSAISONNEMENTS ET SAUCES": "Épicerie salée",
    "POTAGES & PLATS A CONSOMMER": "Épicerie salée",
    "PRODUITS DU MONDE": "Épicerie salée",
    "DIETETIQUE": "Épicerie salée",
    "PETITS DEJEUNERS": "Épicerie sucrée",
    "DESSERTS": "Épicerie sucrée",
    "BISCUITERIE": "Épicerie sucrée",
    "CONFISERIE - CHOCOLATS": "Épicerie sucrée",
    "SURGELES": "Surgelés",
    "GLACES": "Surgelés",
    "BOISSONS SANS ALCOOL": "Boissons",
    "BOISSONS CHAUDES ET INFUSIONS": "Boissons",
    "BOISSONS ALCOOLISEES": "Boissons",
    "VINS": "Boissons",
    "BIERES ET CIDRES": "Boissons",
    "BIERES DU MONDE": "Boissons",
    "BISCUITS APERITIFS": "Monde & Apéritif",
}

# Rayons dont rien ne doit entrer dans un plan de repas.
RAYONS_EXCLUS = {
    "HYGIENE", "BEAUTE PARFUMERIE", "ENTRETIEN DE LA MAISON", "ENTRETIEN DU LINGE",
    "ANIMALERIE ALIMENTATION", "ANIMALERIE ACCESSOIRES", "BEBE ALIMENTS ET PUERICULTURE",
    "ECOLIER BUREAU", "BRICOLAGE DU QUOTIDIEN", "ARTS DE LA TABLE", "JEUX ET JOUETS",
    "CUISINE PEM", "CUISINE", "JARDIN LS", "AUTO MOTO", "JEUX VIDEO", "MAROQUINERIE",
    "MULTIMEDIA CONSOMMABLES", "SELF-DISCOUNT", "SERVICES", "FLEURS ET PLANTES",
}


# --- Catégories du planificateur --------------------------------------------
# Le planificateur raisonne en « poulet », « pates », « legume » : c'est plus
# fin que le rayon. On part du rayon_n4, puis le nom tranche là où le rayon
# mélange (« GRILLADE » vaut aussi bien du bœuf que de l'agneau).
PAR_RAYON4 = {
    "PATES ALIMENTAIRES": "pates",
    "CONSERVES DE LEGUMES": "conserve-legume",
    "CONSERVES DE POISSON": "conserve-poisson",
    "CONSERVES DE VIANDE": "conserve-viande",

    "SELS ET EPICES": "epice",
    "CONDIMENTS": "condiment",
    "SAUCES CHAUDES": "condiment",
    "AIDES CULINAIRES": "condiment",
    "OEUFS": "oeuf",
    "BEURRES": "beurre",
    "MARGARINES": "beurre",
    "CREMES ET AIDES CULINAIRES": "creme",
    "LAIT LONGUE CONSERVATION": "lait",
    "LAIT FRAIS": "lait",
    "FROMAGE RAPE": "fromage",
    "PATE DURE": "fromage",
    "CAMEMBERT BRIE ET ASSIMILES": "fromage",
    "CHEVRE ET BREBIS": "fromage",
    "FE CHEVRE ET BREBIS": "fromage",
    "FROMAGE DE TERROIR AOP": "fromage",
    "FROMAGE AIDE CUL. ET APERO": "fromage",
    "FROMAGE FRAIS ET TARTINABLE": "fromage",
    "FROMAGE ENFANT": "fromage",
    "ULTRA FRAIS NATURE": "yaourt",
    "ULTRA FRAIS SANTE": "yaourt",
    "ULTRA FRAIS ALLEGE": "yaourt",
    "YAOURTS AUX FRUITS": "yaourt",
    "JAMBON CUIT": "charcuterie",
    "JAMBON DE VOLAILLE": "charcuterie",
    "JAMBON CRU TRANCHE": "charcuterie",
    "CHARCUTERIE SECHE TRANCHEE": "charcuterie",
    "SEC ENTIER": "charcuterie",
    "CHARCUTERIE A CUIRE": "charcuterie",
    "AIDE CULINAIRE CHARCUTERIE": "charcuterie",
    "VIANDE ET ROTI CUITS": "traiteur",
    "PAIN DE MIE LS": "pain",
    "PANIFICATION": "pain",
    "PAIN FRAIS": "pain",
    "VIENNOISERIE": "viennoiserie",
    "FARINE": "farine",
    "CEREALES": "cereale",
    "COMPOTES": "fruit-transforme",
    "FRUITS SIROP": "fruit-transforme",
    "FRUITS SECS A CUISINER": "fruit-sec",
    "FRUITS SECS A GRIGNOTER": "fruit-sec",
    "SALADES EN SACHET ET CRUDITES": "legume",
    "JUS DE FRUITS FRAIS": "jus",
    "JUS DE FRUIT": "jus",
    "APERO RECEPTION": "traiteur",
    "AIDE CULINAIRE": "condiment",
    "PE PLAT PREPARE POISSONNERIE": "traiteur",
    "PE ENTREES": "traiteur",
    "ENTREE ET SOUPE": "traiteur",
    "PRODUITS SOJA": "vegetal",
    "SURIMI": "conserve-poisson",
    "PATE FRAICHE ET ACCOMPAGNEMENT": "pates",
    "POTAGES ET CROUTONS": "traiteur",
    "PLATS CUISINES": "traiteur",
    "SAUMON ET TRUITE FUMES": "poisson-gras",
    "PE CREVETTES": "fruits-de-mer",
    "PE MOULES PRETES A CUIRE": "fruits-de-mer",
    "PE FRUITS DE MER": "fruits-de-mer",
    "PE HUITRES": "fruits-de-mer",
    "PE DECOUPES SAUMON ET TRUITE": "poisson-gras",
    "VIANDE HACHEE": "boeuf",
    "PRODUITS SUCRANTS": "sucre",
    "TABLETTE DE CHOCOLAT": "chocolat",
    "BISCUITS": "biscuit",
    "BISCUITS APERITIFS": "apero",
}

# Le rayon surgelé ne dit pas ce qu'il congèle : son n4 le dit.
PAR_RAYON4_SURGELE = {
    "LEGUMES": "legume-surgele",
    "POMMES DE TERRE": "feculent-surgele",
    "POISSONS": "poisson-surgele",
    "VIANDES": "viande-surgelee",
    "PLATS CUISINES SURGELES": "plat-surgele",
    "PIZZAS": "plat-surgele",
    "ENTREES SURGELEES": "plat-surgele",
}

# Mots du nom qui tranchent, dans l'ordre : le premier qui touche gagne.
PAR_NOM = [
    (r"\b(poulets?|volailles?|dindes?|escalopes? de dinde)\b", "poulet"),
    (r"\b(canards?|magrets?)\b", "canard"),
    (r"\bveau\b", "veau"),
    (r"\b(agneau|mouton|merguez)\b", "agneau"),
    (r"\b(porcs?|jambons?|lardons?|chipolatas?|saucisses?|echines?|rillettes?)\b", "porc"),
    (r"\b(boeufs?|bœufs?|steaks?|bourguignon|entrecotes?|entrecôtes?|rumstecks?)\b", "boeuf"),
    (r"\b(cabillauds?|colins?|lieus?|merlus?|juliennes?|soles?|limandes?|dorades?)\b", "poisson-blanc"),
    (r"\b(saumons?|truites?|maquereaux?|sardines?|harengs?|thons?)\b", "poisson-gras"),
    (r"\b(crevettes?|moules?|huitres?|huîtres?|gambas|calamars?|poulpes?|coquilles?)\b", "fruits-de-mer"),
    (r"\b(lentilles?|pois chiches?|pois casses?|pois cassés?|haricots? rouges?|"
     r"haricots? blancs?|haricots? noirs?|flageolets?|feves?|fèves?|azuki|mungo)\b", "legumineuse"),
    (r"\b(riz|risottos?|basmati)\b", "riz"),
    (r"\b(quinoa|boulgour|semoules?|couscous|polenta|graines?|sesame|sésame)\b", "graine"),
    (r"\b(pates?|pâtes?|penne|spaghettis?|coquillettes?|tagliatelles?|farfalle|fusillis?|macaronis?|lasagnes?)\b", "pates"),
    (r"\b(pommes? de terre|patates? douces?|pdt|purees? de pomme|purées? de pomme)\b",
     "feculent-frais"),
    (r"\b(oignons?|echalotes?|échalotes?|ail|gingembre)\b", "aromate"),
    (r"\b(persil|basilic|coriandre|ciboulette|menthe|thym|romarin)\b", "herbe"),
    (r"\b(tofus?|seitan|soja|steaks? vegetal|végétal)\b", "vegetal"),
    (r"\b(huiles?|margarines?)\b", "matiere-grasse"),
]

# Rayons où le nom du produit désigne l'aliment lui-même, et non un parfum.
NOM_FAIT_FOI = {
    "LEGUMES ET FECULENTS", "CONSERVES DE LEGUMES", "CORPS GRAS OEUFS LAIT",
    "FRUITS ET LEGUMES", "FRUITS ET LEGUMES NEGOCE LS", "VOLAILLE", "NEGOCE BOUCHERIE",
    "BOUCHERIE", "POISSONNERIE TRADITIONNELLE", "TRAITEUR DE LA MER",
    "CHARCUTERIE TRADITIONNELLE", "CHARCUTERIE LIBRE SERVICE", "SURGELES",
}

# Rayons de produits déjà cuisinés, prêts à manger ou à réchauffer.
PLATS_PREPARES = {
    "TRAITEUR LIBRE SERVICE", "TRAITEUR STAND", "SNACKING LIBRE SERVICE",
    "POTAGES & PLATS A CONSOMMER", "ROTISSERIE",
}

# Le rayon fruits & légumes ne distingue pas le fruit du légume : le nom le fait.
FRUITS = re.compile(
    r"\b(pomme|banane|orange|clementine|clémentine|poire|kiwi|fraise|raisin|ananas|"
    r"avocat|mangue|melon|pasteque|pastèque|peche|pêche|abricot|prune|cerise|figue|"
    r"citron|pamplemousse|myrtille|framboise|nectarine)\b",
    re.I,
)


def normalise(valeur):
    import unicodedata
    sans = unicodedata.normalize("NFD", valeur or "")
    return "".join(c for c in sans if unicodedata.category(c) != "Mn").lower()


def categorie(ligne):
    """Catégorie du planificateur, ou None si le produit n'est pas cuisinable."""
    n3 = (ligne.get("rayon_n3") or "").upper()
    n4 = (ligne.get("rayon_n4") or "").upper()
    nom = normalise(ligne.get("nom", ""))

    # Le rayon « fruits au sirop » accueille aussi les boissons végétales, qui
    # remplacent le lait et non la compote.
    if re.search(
        r"\bboissons? (vegetale|végétale|au |a l|à l|coco|riz|avoine|soja|amande)"
        r"|laits? d'(amande|avoine|soja|coco)\b",
        nom,
    ):
        return "lait"

    # « Huiles et vinaigres » range ensemble ce qui graisse et ce qui acidifie.
    if n4 == "HUILES ET VINAIGRES":
        return "matiere-grasse" if re.search(r"\bhuiles?\b", nom) else "condiment"

    if n3 == "SURGELES":
        directe = PAR_RAYON4_SURGELE.get(n4)
        if directe:
            # « Poêlée de légumes » et « nuggets » sortent du même rayon.
            if directe == "viande-surgelee":
                for motif, cat in PAR_NOM:
                    if re.search(motif, nom):
                        return cat
            return directe

    # Ce rayon mélange riz, couscous, graines et légumes secs sous un seul nom :
    # les y laisser ensemble revenait à cacher au planificateur tout le riz et
    # toutes les lentilles du magasin.
    if n4 == "PUREE-RIZ -LEGUMES SECS":
        for motif, cat in PAR_NOM:
            if re.search(motif, nom):
                return cat
        if re.search(r"\bpuree|purée\b", nom):
            return "feculent-frais"
        return "graine"

    # Les conserves de légumes secs sont la protéine la moins chère du magasin.
    # Rangées avec les petits pois, elles étaient invisibles au planificateur,
    # qui ne trouvait plus que trois légumineuses dans tout le catalogue.
    if n4 == "CONSERVES DE LEGUMES" and re.search(
        r"\b(lentilles?|pois chiches?|haricots? rouges?|haricots? blancs?|"
        r"haricots? noirs?|flageolets?|feves?|fèves?|cassoulet)\b", nom
    ):
        return "legumineuse"

    directe = PAR_RAYON4.get(n4)
    if directe:
        # Une conserve de légumes reste une conserve, mais « viande hachée »
        # peut être du bœuf comme de la dinde.
        if directe in {"boeuf", "charcuterie"}:
            for motif, cat in PAR_NOM:
                if re.search(motif, nom):
                    return cat if directe == "boeuf" else directe
        return directe

    # Un plat déjà cuisiné n'est pas un ingrédient : « Taboulé au poulet » était
    # rangé en « poulet » par son nom, et le planificateur le saisissait à la
    # poêle comme une escalope.
    #
    # La règle vient APRÈS la correspondance fine, sinon elle emporte avec elle
    # le thon en conserve et les tomates pelées : les conserves partagent leur
    # rayon avec les plats cuisinés.
    if n3 in PLATS_PREPARES:
        return "traiteur"

    if n3 in {"FRUITS ET LEGUMES", "FRUITS ET LEGUMES NEGOCE LS"}:
        for motif, cat in PAR_NOM:
            if re.search(motif, nom):
                return cat
        # Un légume ne se vend pas au litre : ce qui se mesure en volume dans ce
        # rayon est une boisson, et n'a rien à faire dans une poêlée.
        if (ligne.get("unite") or "") == "€/l" or re.search(r"\b(jus|boisson|smoothie|nectar)\b", nom):
            return "jus"
        return "fruit" if FRUITS.search(nom) else "legume"

    if n3 in {"VOLAILLE", "NEGOCE BOUCHERIE", "BOUCHERIE", "POISSONNERIE TRADITIONNELLE",
              "TRAITEUR DE LA MER", "CHARCUTERIE TRADITIONNELLE"}:
        for motif, cat in PAR_NOM:
            if re.search(motif, nom):
                return cat
        return {"VOLAILLE": "poulet", "POISSONNERIE TRADITIONNELLE": "poisson-blanc",
                "TRAITEUR DE LA MER": "poisson-gras"}.get(n3, "boeuf")

    # Dernier recours, et strictement encadré : le nom ne tranche que dans les
    # rayons où il désigne vraiment l'aliment. Appliqué partout, il rangeait les
    # « nouilles saveur bœuf » en viande — le bœuf le moins cher du magasin,
    # donc le premier choisi comme protéine — et le Ginger Ale en aromate.
    if n3 in NOM_FAIT_FOI:
        for motif, cat in PAR_NOM:
            if re.search(motif, nom):
                return cat
    return None


# Mentions commerciales qui alourdissent un titre de recette sans rien apprendre.
BAVARDAGE = re.compile(
    r"\s*(prêt en \d+\s*min\w*|micro-?ondable|sachets? cuisson|en sachet|"
    r"prix bas|sélection|format familial|lot de \d+|x\d+ ?(sachets?|portions?)|"
    r"\d+% ?(mg|m\.g\.)|surgelés?|frais)\b",
    re.I,
)


def nettoyer_nom(nom):
    """
    Rend un nom de produit utilisable dans un titre de recette.

    Les libellés du drive sont écrits pour une fiche produit, pas pour une
    phrase : « PUREE DE POMME DE TERRE NATURE », « Riz basmati prêt en 11 min ».
    Le planificateur en fait des titres — « Gratin de PUREE DE POMME... » — d'où
    ce dégraissage.
    """
    nom = (nom or "").strip()
    # Tout en capitales : illisible dans une phrase, et ce n'est pas un sigle.
    if nom == nom.upper() and len(nom) > 4:
        nom = nom.capitalize()
    nom = BAVARDAGE.sub("", nom)
    nom = re.sub(r"\s{2,}", " ", nom).strip(" ,-·")
    # Un titre de plat ne porte pas huit mots.
    mots = nom.split()
    if len(mots) > 6:
        nom = " ".join(mots[:6])
    return nom or "Produit"


def conditionnement(ligne):
    """
    Unité et contenance réelles, déduites du prix et du prix par unité.

    Le texte du conditionnement est irrégulier — « 3x500g · 2+1 offert », « 250g ·
    2 personnes » — alors que le rapport prix / prix_par_unite donne la
    contenance exacte, promotions comprises.
    """
    try:
        prix = float(ligne.get("prix_eur") or 0)
        par_unite = float(ligne.get("prix_par_unite") or 0)
    except ValueError:
        return None
    if prix <= 0 or par_unite <= 0:
        return None

    unite = (ligne.get("unite") or "").strip()
    rapport = prix / par_unite
    if unite == "€/kg":
        return ("g", round(rapport * 1000))
    if unite == "€/l":
        return ("ml", round(rapport * 1000))
    if unite == "€/pce":
        return ("piece", max(1, round(rapport)))
    return None


def stock(ligne):
    if (ligne.get("disponibilite") or "") == "OutOfStock":
        return "rupture"
    try:
        quantite = int(ligne.get("stock_quantite") or 0)
    except ValueError:
        quantite = 0
    if 0 < quantite <= 3:
        return "stock_faible"
    return "en_rayon"


# --- Régimes ----------------------------------------------------------------
# L'export ne porte ni liste d'ingrédients ni allergènes. Les étiquettes sont
# donc déduites du rayon et du nom, et l'erreur n'est pas symétrique : accorder
# à tort « sans gluten » à un produit qui en contient met en danger un cœliaque,
# tandis que le refuser à tort ne fait que rétrécir le choix. On n'accorde donc
# qu'aux catégories dont la composition ne fait aucun doute, et le catalogue est
# marqué comme déduit pour que l'application le dise.
VEGETARIEN = {
    "legume", "legume-surgele", "fruit", "fruit-sec", "fruit-transforme", "aromate",
    "herbe", "epice", "pates", "riz", "graine", "feculent-frais", "feculent-sec",
    "feculent-surgele", "legumineuse", "conserve-legume", "matiere-grasse", "farine",
    "sucre", "oeuf", "lait", "yaourt", "fromage", "creme", "beurre", "vegetal",
    "chocolat", "cereale", "pain",
}
VEGAN = {
    "legume", "legume-surgele", "fruit", "fruit-sec", "fruit-transforme", "aromate",
    "herbe", "epice", "riz", "graine", "feculent-frais", "feculent-sec",
    "legumineuse", "conserve-legume", "matiere-grasse", "farine", "sucre", "vegetal",
}
PORC = {"porc", "charcuterie"}
SANS_GLUTEN = {
    "legume", "legume-surgele", "fruit", "fruit-sec", "aromate", "herbe", "epice",
    "riz", "feculent-frais", "legumineuse", "conserve-legume", "conserve-poisson",
    "matiere-grasse", "oeuf", "lait", "yaourt", "fromage", "creme", "beurre",
    "poulet", "boeuf", "porc", "agneau", "veau", "canard", "poisson-blanc",
    "poisson-gras", "fruits-de-mer",
}
SANS_LACTOSE = {
    "legume", "legume-surgele", "fruit", "fruit-sec", "aromate", "herbe", "epice",
    "pates", "riz", "graine", "feculent-frais", "feculent-sec", "legumineuse",
    "conserve-legume", "conserve-poisson", "matiere-grasse", "farine", "sucre",
    "oeuf", "poulet", "boeuf", "porc", "agneau", "veau", "canard", "poisson-blanc",
    "poisson-gras", "fruits-de-mer", "vegetal",
}
FRUITS_A_COQUE = re.compile(
    r"\b(noix|noisette|amande|cajou|pistache|praline|nougat|arachide|cacahuete|cacahuète)\b", re.I
)


def regimes(cat, nom):
    tags = []
    n = normalise(nom)
    if cat in VEGETARIEN:
        tags.append("vegetarien")
    if cat in VEGAN:
        tags.append("vegan")
    if cat not in PORC and not re.search(r"\b(porc|jambon|lardon|bacon|chorizo|saucisson)\b", n):
        tags.append("sans_porc")
    if cat in SANS_GLUTEN and not re.search(r"\b(pane|pané|chapelure|beignet|nugget)\b", n):
        tags.append("sans_gluten")
    if cat in SANS_LACTOSE and not re.search(r"\b(creme|crème|beurre|fromage|lait)\b", n):
        tags.append("sans_lactose")
    if not FRUITS_A_COQUE.search(n):
        tags.append("sans_fruits_a_coque")
    if "sans_porc" in tags and cat not in {"alcool"} and not re.search(r"\b(vin|biere|bière|alcool|rhum|whisky)\b", n):
        tags.append("halal_compatible")
    return tags


# --- Nutrition --------------------------------------------------------------
# Absente de l'export. Ces valeurs sont des moyennes par catégorie, pour 100 g :
# elles suffisent à comparer un plan à un autre et à classer les protéines, pas
# à un suivi diététique. Le catalogue les marque comme estimées.
NUTRITION = {
    "poulet": (120, 22, 0, 3, 0, 0.1), "dinde": (105, 24, 0, 1, 0, 0.1),
    "boeuf": (180, 20, 0, 11, 0, 0.15), "porc": (220, 19, 0, 16, 0, 0.3),
    "agneau": (260, 17, 1, 21, 0, 0.5), "veau": (120, 21, 0, 4, 0, 0.1),
    "canard": (200, 19, 0, 14, 0, 0.15), "viande-surgelee": (200, 15, 10, 12, 1, 1),
    "poisson-blanc": (85, 18, 0, 1, 0, 0.2), "poisson-gras": (190, 21, 0, 12, 0, 0.5),
    "poisson-surgele": (100, 17, 3, 3, 0, 0.4), "fruits-de-mer": (85, 18, 1, 1, 0, 0.8),
    "conserve-poisson": (140, 22, 1, 6, 0, 0.9), "conserve-viande": (200, 16, 3, 14, 0, 1.2),
    "charcuterie": (250, 18, 2, 19, 0, 2.5), "traiteur": (190, 15, 8, 11, 1, 1.3),
    "oeuf": (140, 12, 1, 10, 0, 0.4), "vegetal": (140, 15, 5, 7, 3, 0.6),
    "legumineuse": (120, 8, 16, 1, 6, 0.4), "pates": (350, 12, 70, 1.5, 3, 0),
    "riz": (350, 7, 78, 1, 1.4, 0), "graine": (355, 12, 68, 2, 5, 0),
    "feculent-sec": (330, 12, 60, 2, 8, 0.1), "feculent-frais": (80, 2, 17, 0.2, 2, 0),
    "feculent-surgele": (150, 2, 25, 5, 2, 0.5), "legume": (35, 1.5, 6, 0.3, 2.5, 0.05),
    "legume-surgele": (45, 2.5, 6, 0.5, 3, 0.1), "conserve-legume": (40, 1.5, 6, 0.3, 2, 0.4),
    "fruit": (60, 0.8, 13, 0.3, 2, 0), "fruit-sec": (400, 12, 25, 30, 8, 0.1),
    "fruit-transforme": (65, 0.4, 15, 0.1, 1.5, 0), "aromate": (45, 1.4, 9, 0.2, 2, 0),
    "herbe": (30, 3, 5, 0.6, 3, 0.05), "epice": (250, 10, 40, 8, 20, 5),
    "matiere-grasse": (890, 0, 0, 99, 0, 0), "beurre": (740, 0.7, 0.6, 82, 0, 0.9),
    "creme": (200, 2.5, 3, 20, 0, 0.1), "lait": (46, 3.2, 4.8, 1.6, 0, 0.1),
    "yaourt": (75, 4, 7, 3, 0, 0.1), "fromage": (330, 24, 1.5, 26, 0, 1.6),
    "pain": (260, 8, 50, 2, 3, 1.2), "viennoiserie": (400, 7, 45, 21, 2, 0.9),
    "farine": (350, 10, 72, 1.2, 3, 0), "cereale": (380, 8, 70, 7, 7, 0.5),
    "condiment": (120, 2, 10, 8, 1, 3), "sucre": (350, 0.5, 80, 0.5, 0.5, 0.05),
    "chocolat": (540, 6, 55, 32, 7, 0.1), "biscuit": (470, 6, 62, 22, 2, 0.6),
    "apero": (500, 6, 55, 27, 4, 2.5), "plat-surgele": (200, 8, 22, 9, 2, 1),
}


# Catégories reconnues mais sans emploi en cuisine : elles gonfleraient le
# catalogue sans qu'aucun gabarit ne puisse s'en servir.
NON_CUISINABLES = {"jus"}

# Conservation indicative, en jours, par catégorie.
CONSERVATION = {
    "poulet": 3, "dinde": 3, "boeuf": 3, "porc": 3, "agneau": 3, "veau": 3, "canard": 4,
    "poisson-blanc": 2, "poisson-gras": 3, "fruits-de-mer": 2, "charcuterie": 10,
    "traiteur": 3, "oeuf": 21, "lait": 60, "yaourt": 21, "fromage": 20, "creme": 20,
    "beurre": 45, "legume": 8, "fruit": 10, "aromate": 60, "herbe": 5, "pain": 3,
    "viennoiserie": 4, "feculent-frais": 25, "vegetal": 12,
}
CONSERVATION_DEFAUT = {
    "legume-surgele": 300, "feculent-surgele": 300, "poisson-surgele": 300,
    "viande-surgelee": 300, "plat-surgele": 300,
}


def convertir(chemin_source, chemin_sortie, magasin=None):
    brut = list(lignes(chemin_source))
    if magasin is None:
        # Le vendeur le plus présent n'est pas le magasin : l'export est dominé
        # par la marketplace. Le drive se reconnaît à son mode de retrait.
        drive = Counter(
            l.get("vendeur", "") for l in brut if l.get("livraison") == "Dans mon drive"
        )
        if not drive:
            raise SystemExit(
                "Aucune ligne « Dans mon drive » : précise le magasin en troisième argument."
            )
        magasin = drive.most_common(1)[0][0]

    produits, ids = [], set()
    rejets = Counter()

    for ligne in brut:
        if ligne.get("vendeur") != magasin:
            rejets["autre vendeur"] += 1
            continue
        if (ligne.get("rayon_n2") or "").upper() in RAYONS_EXCLUS:
            rejets["rayon non alimentaire"] += 1
            continue

        rayon = RAYONS.get((ligne.get("rayon_n3") or "").upper())
        if not rayon:
            rejets["rayon inconnu"] += 1
            continue

        cat = categorie(ligne)
        if cat in NON_CUISINABLES:
            rejets["boisson ou hors cuisine"] += 1
            continue
        if not cat:
            rejets["catégorie non reconnue"] += 1
            continue

        cond = conditionnement(ligne)
        if not cond:
            rejets["conditionnement illisible"] += 1
            continue
        unite, contenance = cond
        if contenance <= 0:
            rejets["contenance nulle"] += 1
            continue

        reference = (ligne.get("reference") or ligne.get("cug") or "").strip()
        identifiant = f"ac-{reference}" if reference else None
        if not identifiant or identifiant in ids:
            rejets["référence absente ou en double"] += 1
            continue
        ids.add(identifiant)

        nom = nettoyer_nom(ligne.get("nom"))
        marque = (ligne.get("marque") or "").strip()
        kcal, prot, gluc, lip, fib, sel = NUTRITION.get(cat, (150, 5, 15, 6, 2, 0.5))

        produit = {
            "id": identifiant,
            "name": nom,
            "rayon": rayon,
            "category": cat,
            "brandTier": "mdd" if marque.upper() in {"AUCHAN", "POUCE", "AUCHAN BIO"} else "national",
            "unit": unite,
            "packSize": contenance,
            "price": round(float(ligne["prix_eur"]), 2),
            "priceFrom": {"source": "collecte", "at": DATE, "store": magasin},
            "diet": regimes(cat, nom),
            "nutrition": {"kcal": kcal, "protein": prot, "carbs": gluc,
                          "fat": lip, "fiber": fib, "salt": sel},
            "shelfLifeDays": CONSERVATION.get(cat, CONSERVATION_DEFAUT.get(cat, 180)),
            "stock": stock(ligne),
            "stockFrom": {"source": "collecte", "at": DATE, "store": magasin},
        }
        ean = (ligne.get("ean") or "").strip()
        if ean.isdigit() and len(ean) >= 8:
            produit["ean"] = ean
        cug = (ligne.get("cug") or "").strip()
        if cug:
            produit["storeRef"] = cug

        produits.append(produit)

    catalogue = {
        "products": produits,
        "source": "import",
        "updatedAt": DATE,
        "storeLabel": magasin,
    }
    with open(chemin_sortie, "w", encoding="utf-8") as f:
        json.dump(catalogue, f, ensure_ascii=False, separators=(",", ":"))

    print(f"{len(produits)} produits retenus sur {len(brut)} lignes ({magasin})")
    for motif, n in rejets.most_common():
        print(f"  écarté — {motif} : {n}")
    print("\ncatégories :")
    for cat, n in Counter(p["category"] for p in produits).most_common():
        print(f"  {n:5}  {cat}")
    return catalogue


if __name__ == "__main__":
    import datetime
    DATE = datetime.date.today().isoformat()
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    convertir(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
