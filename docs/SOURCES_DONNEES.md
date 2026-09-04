# D'où viennent les prix, et pourquoi pas du scraping

Tu as demandé « du scraping Auchan avec un moyen qui ne se ferait pas détecter,
ou trouver un autre moyen — comment font les comparateurs ? ». Ce document
répond aux deux moitiés de la question.

## La distinction qui compte : robot furtif ≠ ton propre navigateur

Il n'y a pas de collecte conçue pour échapper à la détection : pas de rotation
de proxies résidentiels, pas de falsification d'empreinte navigateur, pas de
résolution de CAPTCHA, pas de cadence calquée sur un humain.

Il y a en revanche un **collecteur qui s'exécute dans ton navigateur**
(`public/auchan-collect.user.js`), et c'est une chose entièrement différente.
Il ne fait aucune requête au site : il lit le contenu des pages que **tu**
ouvres, dans **ta** session, à **ta** vitesse. Aucun trafic supplémentaire
n'est généré, aucun identifiant n'est stocké, aucune protection n'est
contournée — techniquement, la seule chose qui se passe est que le texte
affiché à l'écran est aussi lu par un script au lieu de l'être uniquement par
tes yeux.

C'est le mode de fonctionnement des extensions de suivi de prix. C'est ce qui
donne le prix exact de ton magasin **et** sa disponibilité, les deux seules
données qu'aucune source publique ne contient.

Ce qui reste écarté, c'est le robot autonome qui parcourt le site sans toi. La
partie « indétectable » est précisément celle qui fait basculer une collecte
vers quelque chose que tu ne veux pas porter :

- **Les CGU d'Auchan interdisent l'extraction automatisée.** S'en affranchir
  t'expose à la fermeture de ton compte client — celui-là même qui te sert à
  commander.
- **Contourner une mesure technique de protection est une infraction
  distincte** en droit français (article 323-1 du code pénal, atteinte à un
  système de traitement automatisé de données). Le scraping de données
  publiques est une zone grise ; le contournement d'un dispositif anti-bot en
  sort.
- **Ça ne marche pas longtemps.** Les protections type Datadome ou Cloudflare
  Bot Management évoluent en continu. Un collecteur furtif demande une
  maintenance permanente, et il casse toujours au pire moment — le jour où tu
  fais tes courses.

Le résultat concret : une application fragile, illégitime, qui tombe en panne
sans prévenir. Le collecteur navigateur obtient la même donnée sans aucun de
ces inconvénients, parce qu'il ne prétend jamais être autre chose que toi.

## Comment font vraiment les comparateurs

C'est la partie intéressante de ta question, et la réponse surprend souvent :
**les comparateurs sérieux ne scrapent pas, ou très peu.** Ils obtiennent les
données à la source, avec l'accord des enseignes.

### 0. La réponse courte, si tu ne lis que ça

Un comparateur te donne le prix d'**un** magasin, pas de **ton** magasin — et
aucun ne connaît le stock. Les prix varient réellement d'un Auchan à l'autre
selon le format et la région. C'est pourquoi le collecteur navigateur reste la
source de référence de cette application, et Open Prices un complément.

### 1. Les flux produits fournis par les enseignes

C'est le mécanisme dominant. Une enseigne qui veut être visible sur un
comparateur lui transmet un **flux produits** : un fichier XML ou CSV
régénéré plusieurs fois par jour, contenant référence, EAN, libellé, prix,
disponibilité, catégorie, URL. Les formats standards sont ceux de Google
Merchant Center, et les réseaux d'affiliation (Awin, Effiliation, Rakuten
Advertising, TradeDoubler) distribuent ces flux à leurs éditeurs.

Le modèle économique est simple : l'enseigne paie au clic ou à la commande, le
comparateur reçoit les données gratuitement et proprement. Personne ne scrape
parce que personne n'en a besoin.

**Ce que ça implique pour toi :** ces flux sont accessibles à un éditeur
inscrit sur une plateforme d'affiliation, pas à un particulier. C'est la voie
royale si ce projet devait devenir public ; elle est disproportionnée pour un
outil personnel.

### 2. Les API des enseignes elles-mêmes

Certaines enseignes exposent une API partenaire sous contrat. Auchan n'a pas
d'API publique de catalogue ou de prix. Son site Drive consomme bien des
endpoints JSON internes, mais ce sont des interfaces privées : non
documentées, non contractuelles, modifiables sans préavis, et couvertes par
les mêmes CGU que le reste du site. Les appeler, c'est du scraping avec des
étapes supplémentaires.

### 3. Le relevé humain

Angle mort du grand public : une partie des données de prix en France provient
encore de **relevés manuels en magasin**. L'UFC-Que Choisir, l'INSEE pour
l'indice des prix, et plusieurs observatoires emploient ou mandatent des
releveurs. C'est lent, c'est cher, c'est irréprochable juridiquement.

C'est aussi, à ton échelle, la source la plus exacte qui existe : personne ne
connaît les prix de *ton* magasin mieux que toi qui y vas.

### 4. Les données ouvertes

- **Open Food Facts** — base collaborative sous licence ouverte : EAN,
  ingrédients, allergènes, Nutri-Score, catégories. C'est la meilleure source
  publique pour la partie nutritionnelle, et son API est faite pour être
  appelée.
- **Open Prices** (`prices.openfoodfacts.org`) — le volet prix du même projet,
  sous licence ouverte. C'est le seul « comparateur » réellement exploitable
  par un particulier, et sa particularité est décisive : **chaque prix est
  rattaché à un magasin identifié** par OpenStreetMap, pas à une moyenne
  nationale. Il est branché dans l'application (`lib/catalog/openprices.ts`,
  relayé par `app/api/openprices/`).

  Ses limites sont structurelles et l'interface les annonce : la couverture
  dépend des contributeurs — pour beaucoup de magasins la base est vide — et
  **il n'y a aucune donnée de stock**. Un prix qui en vient ne remplace donc
  jamais un relevé personnel : il ne comble que les estimations.
- **prix-carburants.gouv.fr** — souvent cité comme précédent d'open data prix,
  mais il n'a aucun équivalent pour l'alimentaire : il n'existe pas
  d'obligation légale de publication des prix en grande distribution.

### 5. Tes propres données

L'historique de commandes de ton compte Auchan, tes tickets de caisse
dématérialisés, un panier Drive constitué : ce sont **tes** données. Les
exporter et les réutiliser ne pose aucun problème — ni juridique, ni
technique, ni de détection. C'est le meilleur rapport exactitude/effort
disponible pour un usage personnel.

## Ce que fait cette application

L'architecture sépare la source de données du moteur. Quatre sources sont
branchées :

| Source | Produits | Prix | Stock | Nutrition | Statut |
|---|---|---|---|---|---|
| Catalogue embarqué | oui | estimés | **inconnu** | oui | repli par défaut |
| **Collecteur navigateur** | oui | **exacts** | **exact** | héritée | actif |
| Mode rayon (étiquette) | — | **exacts** | **exact** | — | actif |
| Import CSV | oui | **exacts** | oui | héritée | actif |
| Open Prices | oui | réels, d'un tiers | **aucun** | héritée | actif |

### Chaque donnée porte sa provenance

C'est le point qui rend le reste utilisable. Tout prix et tout statut de stock
transporte sa source et sa date (`Provenance` dans `lib/types.ts`) :

- `estimation` — le relevé indicatif embarqué. Bon ordre de grandeur, pas un
  montant de caisse.
- `collecte` — lu sur auchan.fr, dans ton navigateur, pour ton magasin.
- `communaute` — saisi par un contributeur d'Open Prices, dans un magasin
  identifié, à une date connue. Un prix réel, mais ni le tien ni forcément
  celui de ton magasin : le libellé affiché précise lequel et quand.
- `saisie` — relevé par toi en rayon, devant l'étiquette.
- `import` — venu de ton fichier CSV.

L'interface affiche cette provenance sur **chaque ligne** de la liste de
courses, et le plan annonce en tête le pourcentage du panier chiffré sur des
prix réels. Un total calculé à 100 % sur des estimations le dit ; il ne se
présente pas comme un montant exact.

En cas de conflit, **la donnée la plus récente gagne** entre sources de même
rang : une correction saisie il y a trois semaines n'écrase pas un prix relevé
ce matin. Et **un prix communautaire ne prime jamais sur un relevé
personnel**, même plus ancien — ce que tu as constaté de tes yeux dans ton
magasin vaut mieux que la contribution d'un inconnu.

### Le stock par défaut est « inconnu », pas « en rayon »

Le catalogue embarqué ne sait rien de la disponibilité d'un magasin donné.
Afficher « en rayon » par défaut serait inventer une information. Tant que
rien n'a été constaté, le stock est `inconnu` et aucune pastille n'est
affichée — seul un constat réel mérite un signe à l'écran.

Un produit marqué en rupture est exclu de la planification : aucune recette ne
sera bâtie dessus.

**Le catalogue embarqué** (`data/catalog.json`, 220 produits) est un relevé
indicatif couvrant tous les rayons. Il permet à l'application de fonctionner
immédiatement et hors-ligne. Ses prix sont plausibles, pas exacts.

**L'import CSV** est le chemin qui donne des prix justes. Tu exportes le
modèle depuis les réglages, tu le remplis — à la main, depuis ton historique
de commandes, ou depuis un panier Drive — et tu l'importes. Une ligne dont
l'identifiant correspond à un produit connu ne fait que corriger son prix : la
fiche nutritionnelle est conservée.

**Les corrections ponctuelles** permettent de rectifier un prix ou de signaler
une rupture depuis l'écran de réglages, sans repasser par un fichier. Elles
sont conservées et s'appliquent à toutes les listes suivantes.

## Comment relever, en pratique

**Le plus rapide : coller une commande.** Ouvre *Mes commandes* sur ton compte,
copie le détail d'une commande, colle-le dans **Réglages → Prix & stock**.
Ce sont tes propres données, les prix réellement payés, et rien n'est collecté
nulle part. C'est le meilleur rapport effort/exactitude qui existe.

**Pour le drive (prix + stock, le plus complet).** Installe Violentmonkey ou
Tampermonkey, colle `public/auchan-collect.user.js`, va sur auchan.fr,
sélectionne ton magasin, puis ouvre une page à fort rendement — *Mes
commandes*, une liste enregistrée, ou un rayon entier. Clique sur **« Dérouler
la page »** : le script fait défiler cette page jusqu'au bout pour que tous ses
produits se chargent, puis les relève d'un coup. Sur une page de rayon, cela
donne plusieurs dizaines de produits en un clic. Ensuite « Copier le relevé »,
et colle-le dans l'application.

Ce bouton ne navigue pas : il fait défiler la page que tu as ouverte, comme ton
doigt le ferait. Aucun lien n'est suivi, aucune page n'est ouverte à ta place.

Le collecteur lit d'abord le JSON-LD (`schema.org/Product`) que le site publie
pour les moteurs de recherche : c'est la source la plus stable, normalisée, et
elle contient `offers.price` et `offers.availability`. À défaut il lit l'état
applicatif de la page, puis en dernier recours le texte affiché — chaque
stratégie est annoncée dans l'encart, pour que tu saches ce qui a servi.

**Pour le magasin physique.** Le mode rayon (Réglages → Mode rayon) sert à
corriger un prix devant l'étiquette : recherche par nom ou scan du code-barres
quand le navigateur le sait faire, saisie du prix, validation. Deux boutons
permettent de signaler une rupture ou un stock faible en un geste.

## Si tu veux quand même un robot autonome

Une position défendable existe, et elle n'a rien à voir avec la furtivité :

1. **Lis `https://www.auchan.fr/robots.txt`** et respecte-le. C'est
   l'expression explicite de ce que le site autorise aux robots.
2. **Identifie-toi** par un User-Agent honnête, avec un moyen de te contacter.
   Un collecteur identifié qui se comporte bien se fait rarement bloquer.
3. **Une requête toutes les quelques secondes au maximum**, sur les seules
   références qui te concernent — quelques dizaines, pas tout le catalogue.
4. **Mets en cache agressivement.** Les prix bougent d'une semaine à l'autre,
   pas d'une minute à l'autre.
5. **Arrête-toi au premier signe de refus** : 403, 429, page de challenge.
   C'est une réponse, pas un obstacle à franchir.

Un tel robot se brancherait sans toucher au moteur. Je ne le fournis pas : il
resterait contraire aux CGU, et je ne veux pas te vendre comme sûr quelque
chose qui ne l'est pas.

Il n'apporterait d'ailleurs rien de plus. Le collecteur navigateur donne
exactement la même donnée — prix de ton magasin et disponibilité — sans risque
pour ton compte et sans maintenance à chaque refonte du site.
