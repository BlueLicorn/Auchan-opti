# D'où viennent les prix, et pourquoi pas du scraping

Tu as demandé « du scraping Auchan avec un moyen qui ne se ferait pas détecter,
ou trouver un autre moyen — comment font les comparateurs ? ». Ce document
répond aux deux moitiés de la question.

## Ce que je n'ai pas fait, et pourquoi

Je n'ai pas implémenté de collecte conçue pour échapper à la détection :
rotation de proxies résidentiels, falsification d'empreinte navigateur,
résolution de CAPTCHA, cadence calquée sur un humain.

Ce n'est pas une objection de principe au scraping. C'est que la partie
« indétectable » est précisément celle qui fait basculer une collecte de
données publiques vers quelque chose que tu ne veux pas porter :

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

Le résultat concret : tu aurais une application fragile, illégitime, et qui
tombe en panne sans prévenir. C'est un mauvais échange contre les quelques
euros de précision que ça apporte.

## Comment font vraiment les comparateurs

C'est la partie intéressante de ta question, et la réponse surprend souvent :
**les comparateurs sérieux ne scrapent pas, ou très peu.** Ils obtiennent les
données à la source, avec l'accord des enseignes.

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
  ingrédients, allergènes, Nutri-Score, catégories. Aucune donnée de prix,
  mais c'est la meilleure source publique pour la partie nutritionnelle, et
  son API est faite pour être appelée.
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

L'architecture sépare la source de données du moteur, via l'interface
`CatalogSource` (`lib/catalog/sources.ts`). Trois sources sont branchées :

| Source | Produits | Prix | Stock | Nutrition | Statut |
|---|---|---|---|---|---|
| Catalogue embarqué | oui | indicatifs | non | oui | actif par défaut |
| Import CSV | oui | **exacts** | oui | héritée | actif |
| Corrections en magasin | — | **exacts** | oui | — | actif |

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

## Si tu veux quand même automatiser la collecte

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

Un tel collecteur se brancherait comme une `CatalogSource` supplémentaire sans
toucher au moteur. Je ne le fournis pas : il resterait contraire aux CGU, et
je ne veux pas te vendre comme sûr quelque chose qui ne l'est pas.

Le chemin que je te recommande reste l'import CSV. Vingt minutes une fois pour
tes cinquante produits habituels, et le chiffrage devient exact — plus exact
que n'importe quel scraper, parce qu'il porte sur ton magasin et pas sur une
moyenne nationale.
