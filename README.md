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

## Les prix

Le catalogue embarqué (220 produits, tous rayons) contient des **relevés
indicatifs**, pas les prix en direct de ton magasin — Auchan ne publie pas
d'API de prix.

Pour un chiffrage exact, importe les tiens : **Réglages → Télécharger le
modèle**, tu le remplis, **Importer mes prix**. Tu peux aussi corriger un prix
ou signaler une rupture à l'unité depuis la recherche produit, ce qui est
conservé pour toutes tes listes suivantes.

Le raisonnement complet — y compris pourquoi je n'ai pas écrit de scraper
furtif, et comment les comparateurs obtiennent réellement leurs données — est
dans [`docs/SOURCES_DONNEES.md`](docs/SOURCES_DONNEES.md).

## Architecture

```
data/catalog.json          Catalogue embarqué, généré par scripts/build-catalog.mjs
lib/types.ts               Modèle de données
lib/catalog/               Chargement, filtrage, substitutions, import/export CSV
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

47 tests couvrent le chiffrage au conditionnement, la réparation budgétaire,
la validation des réponses du modèle, le score nutritionnel et l'import CSV.

## Régénérer le catalogue

```bash
node scripts/build-catalog.mjs
```

La source lisible est dans le script ; le JSON est un artefact.

## Limites connues

- **Les prix embarqués sont indicatifs.** Vérifie-les en rayon, ou importe les
  tiens.
- **Le stock n'est pas connu en temps réel.** Aucune source publique ne
  l'expose. Tu peux marquer manuellement les ruptures que tu constates.
- **Le planificateur hors-ligne n'épuise pas le budget** : il minimise le coût.
  Quand il reste plus de 12 % du budget, l'application le dit et propose des
  compléments.
- **Les poids à la pièce sont des moyennes** (un œuf 55 g, un oignon 60 g).
  Le bilan nutritionnel en hérite l'approximation.

Cette application n'est pas affiliée à Auchan.
