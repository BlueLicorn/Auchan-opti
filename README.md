# Auchan-Opti

Tu donnes un budget — au total ou par repas — un nombre de repas et tes
contraintes. L'application compose les plats, écrit les recettes détaillées, et
sort une liste de courses chiffrée, triée dans l'ordre de parcours du magasin.

Application web Next.js, sans compte et sans serveur de données : tout vit
dans ton navigateur.

## Ce qu'elle fait

- **Le budget se donne au total ou par repas.** « 4 € le repas » se saisit
  directement : changer le nombre de repas garde alors le coût unitaire et
  recalcule le total. Jusqu'à 60 repas par plan — au-delà de six, la
  génération part en lots successifs, avec la liste des plats déjà retenus
  passée à chaque lot pour éviter de servir deux fois le même.
- **Un plan qui tient dans le budget.** Le coût n'est jamais estimé par l'IA :
  il est calculé à partir des conditionnements réels. 350 g de pâtes coûtent
  le prix d'un paquet de 500 g, et les 150 g restants sont affichés comme
  surplus. Le budget pilote réellement la composition : quand il serre, la
  protéine animale recule, le féculent avance, et les paquets déjà ouverts
  sont réutilisés d'un repas à l'autre.
- **Quand le budget est intenable, l'application le dit** — avant de générer,
  et après. Elle nomme la cause (le conditionnement domine quand les portions
  sont peu nombreuses) et chiffre le minimum réellement atteignable.
- **Le curseur équilibré ↔ gros porc** déplace réellement les repères
  nutritionnels au lieu de maquiller la note. Un plan gourmand assumé est
  bien noté parce qu'il fait ce qu'on lui a demandé.
- **Le niveau de cuisine et l'équipement sont des contraintes dures.** Sans
  four coché, aucune recette au four.
- **Les régimes et allergies ne se négocient pas.** Une recette qui contient
  un ingrédient exclu est rejetée entièrement, jamais rafistolée en retirant
  discrètement la ligne.
- **Liste cochable en rayon**, exportable en texte, CSV, Markdown, ou
  imprimable en PDF. Un bouton copie les désignations une par ligne, format
  qui se colle directement dans la recherche d'un drive.

## Démarrer

```bash
npm install
npm run dev
```

L'application tourne sur http://localhost:3000 et fonctionne immédiatement,
sans clé API : un planificateur local compose alors les repas à partir de
gabarits. C'est correct et bien chiffré, mais peu varié.

### Ajouter ta clé Gemini

Pour des recettes réellement variées, ouvre **Réglages** et colle une clé
obtenue sur [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
(gratuite). Le bouton *Vérifier la clé* interroge l'API et remplit la liste
des modèles réellement accessibles avec ta clé — plutôt qu'un nom codé en dur
qui finit toujours par renvoyer un 404.

**La clé ne quitte pas ton navigateur.** Les requêtes partent directement vers
Google, sans passer par le serveur de cette application. La seule route
serveur qui existe (`/api/openprices`) relaie les requêtes vers la base de
prix ouverte d'Open Food Facts : elle ne voit ni ta clé, ni tes listes, ni
aucune donnée personnelle.

## Les prix réels et le stock de ton magasin

Auchan ne publie ni API de prix ni API de stock. La seule source qui contient
les deux est le site Drive, ton magasin sélectionné — et le moyen légitime d'y
accéder est **ton propre navigateur**.

### Le collecteur

`public/auchan-collect.user.js` est un script qui s'exécute sur les pages
Auchan **que tu ouvres toi-même** — soit par un favori (aucune installation),
soit via une extension de scripts utilisateur. Il ne fait aucune requête au
site, ne suit aucun lien, ne stocke aucun identifiant : il lit le contenu déjà
affiché à ton écran et l'accumule localement. Rien n'en sort tant que tu ne
cliques pas sur « Copier le relevé ».

1. Ouvre **Réglages → Prix & stock** et **fais glisser le bouton
   « Relever les prix Auchan » dans ta barre de favoris**. Rien à installer.
   *(Sur téléphone : copie le code et colle-le comme adresse d'un favori.
   Ou, si tu préfères l'automatisme, installe
   [Violentmonkey](https://violentmonkey.github.io/) et colle
   `public/auchan-collect.user.js` — le script se lancera alors tout seul.)*
2. Va sur auchan.fr et clique sur ce favori : un encart apparaît en bas à droite.
3. **Sélectionne ton magasin**, puis ouvre une page qui contient
   beaucoup de produits : *Mes commandes*, une liste enregistrée, ou un rayon
   entier.
4. Clique sur **« Dérouler la page »** : le script fait défiler la page
   jusqu'au bout pour que tous ses produits se chargent. Un rayon complet se
   relève en un clic, sans ouvrir la moindre fiche produit.
5. « Copier le relevé », puis colle-le dans **Réglages → Prix & stock**.

Le collecteur ne navigue jamais tout seul : il ne suit aucun lien et n'ouvre
aucune page. « Dérouler la page » fait défiler *la page que tu as ouverte*,
exactement comme si tu faisais glisser ton doigt.

Il lit en priorité les **données de page publiées par Auchan lui-même** :
le site pousse chaque produit dans `window.G.productSearchQueue` et annonce un
évènement `ProductSearchUpdate`, avec le prix TTC affiché, la **disponibilité**,
l'arborescence de rayon, la marque, la référence interne et le point de retrait.
Trois stratégies de repli suivent (JSON-LD, état applicatif, lecture d'écran),
et l'encart affiche toujours celle qui a servi ainsi que le nombre de produits
que contient le rayon — pour savoir s'il reste à dérouler.

### Open Prices, la base de prix ouverte

**Réglages → Prix & stock → Compléter avec Open Prices.** C'est le seul
« comparateur » exploitable par un particulier : API documentée, licence
ouverte, et des prix **rattachés à un magasin identifié** via OpenStreetMap
plutôt qu'à une moyenne nationale.

Cherche ton magasin, charge ses prix, applique-les. Deux limites structurelles,
annoncées à l'écran : la couverture dépend des contributeurs et reste souvent
partielle, et il n'y a **aucune donnée de stock**.

Un prix venu d'Open Prices ne remplace jamais un relevé que tu as fait
toi-même — il ne comble que les estimations.

### Ce qui n'entre pas au catalogue

Un relevé de rayon ramène aussi la lessive, le dentifrice, les couches et les
croquettes pour chat. Ces rayons sont écartés à l'import, et le rapport le
dit. Un rayon que la table de correspondance ne connaît pas est conservé mais
signalé, pour que le classement ne dérive pas en silence.

### Coller une commande ou un ticket

**Réglages → Prix & stock → Coller une commande ou un ticket.** Le meilleur
rapport effort/exactitude : copie le détail d'une commande depuis *Mes
commandes*, colle-le, et l'application en extrait les lignes « produit + prix ».
Ce sont les prix que tu as réellement payés, pour ce que tu achètes vraiment,
depuis ton propre compte.

L'analyse écarte d'elle-même les totaux, la TVA, les remises et les moyens de
paiement, ramène un lot au prix unitaire (« 3 x Yaourt 4,50 € » → 1,50 €), et
te montre ce qu'elle a compris avant d'appliquer quoi que ce soit.

### Le mode rayon

Pour le magasin physique, **Réglages → Mode rayon** relève un prix devant
l'étiquette : recherche par nom ou scan du code-barres (quand le navigateur
sait le faire), saisie, validation. Deux boutons signalent une rupture ou un
stock faible en un geste.

### Chaque prix dit d'où il vient

Tout prix et tout stock porte sa source et sa date. La liste de courses
affiche `prix estimé` ou `relevé sur auchan.fr il y a 2 j` sur chaque ligne, et
le plan annonce en tête quel pourcentage du panier repose sur des prix réels.
Le total ne se présente jamais comme exact quand il ne l'est pas.

**Le stock vaut « inconnu » par défaut, pas « en rayon »** : le catalogue
embarqué ne sait rien de ton magasin, et prétendre le contraire serait
inventer une information. Un produit relevé en rupture est exclu de la
planification.

En cas de conflit entre deux sources, la plus récente gagne.

Le raisonnement complet — pourquoi pas de robot furtif, en quoi le collecteur
navigateur en diffère, et comment les comparateurs obtiennent réellement leurs
données — est dans [`docs/SOURCES_DONNEES.md`](docs/SOURCES_DONNEES.md).

## Architecture

```
data/catalog.json          Catalogue embarqué, généré par scripts/build-catalog.mjs
public/auchan-collect.user.js  Collecteur de prix et de stock, exécuté dans TON navigateur
scripts/build-bookmarklet.mjs  En dérive la version « favori », sans extension
lib/types.ts               Modèle de données, dont la provenance de chaque donnée
app/api/openprices/        Relais vers Open Prices (aucune donnée personnelle)
lib/catalog/
  index.ts                 Chargement, filtrage, substitutions, fiabilité
  sources.ts               Import/export CSV
  collect.ts               Import du relevé navigateur
  openprices.ts            Base de prix ouverte Open Food Facts
lib/planner/
  cost.ts                  Chiffrage au conditionnement — le cœur du budget
  scoring.ts               Bilan nutritionnel et score d'équilibre
  validate.ts              Contrôle de la réponse du modèle, sans lui faire confiance
  repair.ts                Ajustement au budget par substitution
  offline.ts               Planificateur de repli par gabarits, sans IA
  index.ts                 Enchaînement complet
lib/ai/                    Client Gemini et construction du prompt
lib/export/                Texte, CSV, Markdown, impression
```

Le principe qui structure tout : **le modèle compose, l'application chiffre.**
L'IA choisit des identifiants dans un catalogue qu'on lui fournit et donne des
quantités. Elle ne voit jamais de total et n'en produit jamais. Un modèle qui
se trompe sur un prix ne peut donc pas fausser ton budget.

## Tests

```bash
npm test
```

109 tests couvrent le chiffrage au conditionnement, la réparation budgétaire,
la validation des réponses du modèle, le score nutritionnel, l'import CSV,
l'import d'un relevé magasin, la lecture des réponses Open Prices,
l'arbitrage entre sources de prix, la lecture d'un ticket de caisse, et le
respect du budget de bout en bout.

## Régénérer le catalogue

```bash
node scripts/build-catalog.mjs
```

La source lisible est dans le script ; le JSON est un artefact.

## Déployer

Le projet est relié à Vercel : `main` est la branche de production, tout push
y déclenche un déploiement. `npm run prebuild` régénère le favori avant chaque
build, pour que le collecteur livré ne diverge jamais du script source.

Un piège à connaître : Vercel ne construit qu'une fois un même commit. Pousser
d'abord la branche de travail puis la même révision sur `main` peut donc ne
produire aucun déploiement de production — le SHA a déjà été vu. Pousser
`main` en premier évite le problème ; sinon il faut promouvoir le
déploiement existant depuis le tableau de bord.

## Limites connues

- **Les prix embarqués sont des estimations**, et l'application le dit sur
  chaque ligne. Ils ne deviennent exacts qu'une fois relevés.
- **Le stock n'est connu que de ce que tu as relevé.** Il n'existe aucun flux
  temps réel : le collecteur capture la disponibilité affichée au moment où tu
  consultes la page, le mode rayon ce que tu constates devant le linéaire.
- **Le collecteur dépend de la structure des pages Auchan.** Il essaie trois
  stratégies et annonce laquelle a fonctionné ; si le site change en
  profondeur, les sélecteurs devront être ajustés. Le bouton **Diagnostic**
  produit alors un rapport de structure — types JSON-LD présents, scripts
  d'état, signatures des cartes produit, résultat de chaque stratégie — d'où
  les identifiants, adresses électroniques et suites de chiffres sont
  caviardés. C'est ce rapport qu'il faut transmettre, jamais le HTML de la
  page, qui contiendrait nom, adresse et historique de commandes.
- **La couverture d'Open Prices est inégale.** Pour beaucoup de magasins, la
  base est vide ou ancienne. C'est le propre d'une base participative, et
  l'interface le dit plutôt que de faire semblant.
- **Le planificateur hors-ligne n'épuise pas le budget** : il minimise le coût.
  Quand il reste plus de 12 % du budget, l'application le dit et propose des
  compléments.
- **Sous 10 portions, le conditionnement fixe un plancher.** Cinq repas pour
  une personne ne descendront pas à 1 € la portion : on achète un paquet de
  pâtes, pas 110 g. L'application annonce ce plancher au lieu de le subir.
  L'effet inverse joue en faveur des gros plans : à 1 € la portion demandée,
  quarante repas descendent à 1,04 € quand cinq plafonnent à 1,23 €, parce
  qu'un paquet de riz se partage entre quarante repas comme entre cinq.
- **Au-delà du budget nécessaire, le planificateur hors-ligne varie le menu
  plutôt que d'économiser.** Quarante repas à 3 € la portion coûtent plus
  cher par portion que cinq, non par gaspillage mais parce que le menu
  s'étend à 71 produits distincts au lieu de 18. C'est un choix : quand le
  budget ne contraint pas, la variété passe devant la dernière pièce.
- **Les poids à la pièce sont des moyennes** (un œuf 55 g, un oignon 60 g).
  Le bilan nutritionnel en hérite l'approximation.

Cette application n'est pas affiliée à Auchan.
