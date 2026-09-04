# Auchan-Opti

Tu donnes un budget, un nombre de repas et tes contraintes. L'application
compose les plats, écrit les recettes détaillées, et sort une liste de courses
chiffrée, triée dans l'ordre de parcours du magasin.

Application web Next.js, sans compte et sans serveur de données : tout vit
dans ton navigateur.

## Ce qu'elle fait

- **Un plan qui tient dans le budget.** Le coût n'est jamais estimé par l'IA :
  il est calculé à partir des conditionnements réels. 350 g de pâtes coûtent
  le prix d'un paquet de 500 g, et les 150 g restants sont affichés comme
  surplus.
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
Google ; elles ne transitent par aucun serveur de cette application, qui n'a
d'ailleurs aucune route d'API. C'est la seule architecture où cette promesse
est vérifiable.

## Les prix réels et le stock de ton magasin

Auchan ne publie ni API de prix ni API de stock. La seule source qui contient
les deux est le site Drive, ton magasin sélectionné — et le moyen légitime d'y
accéder est **ton propre navigateur**.

### Le collecteur

`public/auchan-collect.user.js` est un script utilisateur qui s'exécute sur
les pages Auchan **que tu ouvres toi-même**. Il ne fait aucune requête au
site, ne suit aucun lien, ne stocke aucun identifiant : il lit le contenu déjà
affiché à ton écran et l'accumule localement. Rien n'en sort tant que tu ne
cliques pas sur « Copier le relevé ».

1. Installe [Violentmonkey](https://violentmonkey.github.io/) ou Tampermonkey.
2. Colle le contenu de `public/auchan-collect.user.js` dans un nouveau script.
3. Va sur auchan.fr, **sélectionne ton magasin**, navigue dans tes rayons.
4. « Copier le relevé », puis colle-le dans **Réglages → Prix & stock**.

Il lit en priorité le JSON-LD `schema.org/Product` publié par le site pour les
moteurs de recherche — format normalisé et stable, qui porte le prix et la
disponibilité. Deux stratégies de repli suivent, et l'encart affiche toujours
celle qui a servi.

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
lib/types.ts               Modèle de données, dont la provenance de chaque donnée
lib/catalog/
  index.ts                 Chargement, filtrage, substitutions, fiabilité
  sources.ts               Import/export CSV
  collect.ts               Import du relevé navigateur
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

60 tests couvrent le chiffrage au conditionnement, la réparation budgétaire,
la validation des réponses du modèle, le score nutritionnel, l'import CSV,
l'import d'un relevé magasin et l'arbitrage entre sources de prix.

## Régénérer le catalogue

```bash
node scripts/build-catalog.mjs
```

La source lisible est dans le script ; le JSON est un artefact.

## Limites connues

- **Les prix embarqués sont des estimations**, et l'application le dit sur
  chaque ligne. Ils ne deviennent exacts qu'une fois relevés.
- **Le stock n'est connu que de ce que tu as relevé.** Il n'existe aucun flux
  temps réel : le collecteur capture la disponibilité affichée au moment où tu
  consultes la page, le mode rayon ce que tu constates devant le linéaire.
- **Le collecteur dépend de la structure des pages Auchan.** Il essaie trois
  stratégies et annonce laquelle a fonctionné ; si le site change en
  profondeur, les sélecteurs devront être ajustés.
- **Le planificateur hors-ligne n'épuise pas le budget** : il minimise le coût.
  Quand il reste plus de 12 % du budget, l'application le dit et propose des
  compléments.
- **Les poids à la pièce sont des moyennes** (un œuf 55 g, un oignon 60 g).
  Le bilan nutritionnel en hérite l'approximation.

Cette application n'est pas affiliée à Auchan.
