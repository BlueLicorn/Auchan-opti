// ==UserScript==
// @name         Auchan-Opti — relevé de prix et de stock
// @namespace    auchan-opti
// @version      1.0.0
// @description  Relève le prix et la disponibilité des produits Auchan que tu consultes, pour les importer dans Auchan-Opti.
// @match        https://www.auchan.fr/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Ce script ne robotise rien.
 *
 * Il lit la page que tu es en train de regarder, dans ta session, à ta vitesse.
 * Il n'envoie aucune requête au site, ne suit aucun lien, ne se fait passer
 * pour personne : il extrait ce que ton écran affiche déjà et l'accumule
 * localement, pour que tu puisses l'exporter vers Auchan-Opti.
 *
 * Rien ne sort de ton navigateur tant que tu ne cliques pas sur « Copier ».
 *
 * Installation : Tampermonkey / Violentmonkey → nouveau script → coller ceci.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "auchan-opti:releve";
  const PANEL_ID = "auchan-opti-panneau";

  // ---------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------

  /**
   * Trois stratégies, de la plus fiable à la plus fragile.
   *
   * Le JSON-LD est la source de vérité quand il existe : c'est le format que le
   * site publie lui-même pour les moteurs de recherche, il est stable et
   * normalisé (schema.org/Product). Les autres stratégies sont des filets.
   */
  function extraireProduits() {
    const parJsonLd = extraireJsonLd();
    if (parJsonLd.length > 0) return { produits: parJsonLd, methode: "JSON-LD" };

    const parEtatNext = extraireEtatNext();
    if (parEtatNext.length > 0) return { produits: parEtatNext, methode: "état de page" };

    const parDom = extraireDom();
    return { produits: parDom, methode: parDom.length > 0 ? "lecture d'écran" : "aucune" };
  }

  /** schema.org/Product embarqué dans les balises <script type="application/ld+json">. */
  function extraireJsonLd() {
    const trouves = [];

    for (const balise of document.querySelectorAll('script[type="application/ld+json"]')) {
      let donnees;
      try {
        donnees = JSON.parse(balise.textContent || "");
      } catch {
        continue; // Une balise malformée ne doit pas interrompre les autres.
      }

      for (const noeud of aplatir(donnees)) {
        const type = noeud["@type"];
        const estProduit = type === "Product"
          || (Array.isArray(type) && type.includes("Product"));
        if (!estProduit) continue;

        const offre = premiereOffre(noeud.offers);
        if (!offre) continue;

        const prix = nombre(offre.price ?? offre.lowPrice);
        if (prix === undefined) continue;

        trouves.push({
          nom: texte(noeud.name),
          ean: texte(noeud.gtin13 ?? noeud.gtin ?? noeud.gtin14 ?? noeud.sku),
          prix,
          dispo: normaliserDisponibilite(offre.availability),
          marque: texte(noeud.brand?.name ?? noeud.brand),
          url: texte(offre.url ?? noeud.url) || location.href,
        });
      }
    }

    return trouves;
  }

  /** État applicatif sérialisé, quand le site l'expose (__NEXT_DATA__ et consorts). */
  function extraireEtatNext() {
    const sources = [
      document.getElementById("__NEXT_DATA__"),
      ...document.querySelectorAll('script[id^="__NUXT"], script[type="application/json"]'),
    ].filter(Boolean);

    const trouves = [];

    for (const balise of sources) {
      let donnees;
      try {
        donnees = JSON.parse(balise.textContent || "");
      } catch {
        continue;
      }

      for (const noeud of aplatir(donnees)) {
        // On cherche un objet qui ressemble à un produit tarifé : un libellé,
        // un prix, et de préférence un code-barres.
        const nom = texte(noeud.name ?? noeud.label ?? noeud.title ?? noeud.productName);
        if (!nom || nom.length < 3) continue;

        const prix = nombre(
          noeud.price ?? noeud.currentPrice ?? noeud.unitPrice
          ?? noeud.priceValue ?? noeud.amount,
        );
        if (prix === undefined || prix <= 0 || prix > 500) continue;

        trouves.push({
          nom,
          ean: texte(noeud.ean ?? noeud.gtin ?? noeud.barcode ?? noeud.sku ?? noeud.id),
          prix,
          dispo: normaliserDisponibilite(
            noeud.availability ?? noeud.stockStatus ?? noeud.available ?? noeud.inStock,
          ),
          marque: texte(noeud.brand?.name ?? noeud.brand),
          url: location.href,
        });
      }
    }

    // Le même produit apparaît souvent plusieurs fois dans l'état : on
    // dédoublonne sur le couple nom + prix.
    const vus = new Set();
    return trouves.filter((p) => {
      const cle = `${p.nom}|${p.prix}`;
      if (vus.has(cle)) return false;
      vus.add(cle);
      return true;
    });
  }

  /**
   * Dernier recours : lire le texte affiché.
   *
   * Volontairement conservateur. Un faux prix est pire que pas de prix : il
   * fausserait silencieusement le budget. On n'accepte donc qu'un motif de
   * prix français sans ambiguïté, à proximité immédiate d'un libellé.
   */
  function extraireDom() {
    const trouves = [];
    const cartes = document.querySelectorAll(
      '[data-testid*="product"], article, li[class*="product"], div[class*="product-card"]',
    );

    for (const carte of cartes) {
      const contenu = (carte.textContent || "").replace(/\s+/g, " ").trim();
      if (contenu.length < 8 || contenu.length > 400) continue;

      const prix = contenu.match(/(\d{1,3})[,.](\d{2})\s*€/);
      if (!prix) continue;

      const titre = carte.querySelector('h1, h2, h3, [class*="title"], [class*="name"]');
      const nom = texte(titre?.textContent);
      if (!nom || nom.length < 3) continue;

      trouves.push({
        nom,
        ean: undefined,
        prix: Number(`${prix[1]}.${prix[2]}`),
        dispo: /rupture|indisponible|épuisé/i.test(contenu)
          ? "rupture"
          : /dernières|stock limité|bientôt épuisé/i.test(contenu)
            ? "stock_faible"
            : "en_rayon",
        marque: undefined,
        url: location.href,
      });
    }

    return trouves;
  }

  // ---------------------------------------------------------------------------
  // Normalisation
  // ---------------------------------------------------------------------------

  /** Traduit les nombreuses écritures de disponibilité vers nos trois états. */
  function normaliserDisponibilite(valeur) {
    if (valeur === true) return "en_rayon";
    if (valeur === false) return "rupture";

    const texteBrut = String(valeur ?? "").toLowerCase();
    if (!texteBrut) return "inconnu";
    if (/outofstock|out_of_stock|rupture|indisponible|unavailable|soldout|épuisé/.test(texteBrut)) {
      return "rupture";
    }
    if (/limitedavailability|lowstock|limité|dernières/.test(texteBrut)) return "stock_faible";
    if (/instock|in_stock|available|disponible|onlineonly|instoreonly/.test(texteBrut)) {
      return "en_rayon";
    }
    return "inconnu";
  }

  /** Parcourt récursivement un JSON en produisant chaque objet rencontré. */
  function aplatir(valeur, profondeur = 0) {
    if (profondeur > 12 || valeur === null || typeof valeur !== "object") return [];
    if (Array.isArray(valeur)) return valeur.flatMap((v) => aplatir(v, profondeur + 1));
    return [valeur, ...Object.values(valeur).flatMap((v) => aplatir(v, profondeur + 1))];
  }

  function premiereOffre(offers) {
    if (!offers) return undefined;
    const liste = Array.isArray(offers) ? offers : [offers];
    return liste.find((o) => o && (o.price !== undefined || o.lowPrice !== undefined));
  }

  function nombre(valeur) {
    if (typeof valeur === "number") return Number.isFinite(valeur) ? valeur : undefined;
    if (typeof valeur !== "string") return undefined;
    const nettoye = valeur.replace(/[^\d,.-]/g, "").replace(",", ".");
    const n = Number(nettoye);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  function texte(valeur) {
    if (typeof valeur !== "string") return undefined;
    const propre = valeur.replace(/\s+/g, " ").trim();
    return propre.length > 0 ? propre : undefined;
  }

  /** Nom du magasin sélectionné, s'il apparaît sur la page. */
  function detecterMagasin() {
    const candidats = document.querySelectorAll(
      '[class*="store"], [class*="magasin"], [data-testid*="store"], [class*="drive"]',
    );
    for (const noeud of candidats) {
      const contenu = texte(noeud.textContent);
      if (contenu && contenu.length > 4 && contenu.length < 60 && /auchan/i.test(contenu)) {
        return contenu;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Stockage local et interface
  // ---------------------------------------------------------------------------

  function lireReleve() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function ecrireReleve(releve) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(releve));
    } catch {
      /* quota atteint : le relevé en cours reste affiché, il n'est pas perdu */
    }
  }

  function enregistrer(produits, magasin) {
    const releve = lireReleve();
    const maintenant = new Date().toISOString().slice(0, 10);
    let nouveaux = 0;

    for (const produit of produits) {
      const cle = produit.ean || produit.nom.toLowerCase();
      if (!releve[cle]) nouveaux++;
      releve[cle] = {
        nom: produit.nom,
        ean: produit.ean,
        prix: produit.prix,
        stock: produit.dispo,
        marque: produit.marque,
        magasin,
        url: produit.url,
        releveLe: maintenant,
      };
    }

    ecrireReleve(releve);
    return { total: Object.keys(releve).length, nouveaux };
  }

  function construirePanneau() {
    const existant = document.getElementById(PANEL_ID);
    if (existant) return existant;

    const panneau = document.createElement("div");
    panneau.id = PANEL_ID;
    panneau.style.cssText = [
      "position:fixed", "bottom:16px", "right:16px", "z-index:2147483647",
      "background:#fff", "color:#1b1b1b", "border:1px solid #d8d4cf",
      "border-radius:14px", "box-shadow:0 6px 24px rgba(0,0,0,.18)",
      "padding:12px 14px", "width:250px",
      "font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    ].join(";");
    document.body.appendChild(panneau);
    return panneau;
  }

  function bouton(libelle, principal) {
    const b = document.createElement("button");
    b.textContent = libelle;
    b.style.cssText = [
      "flex:1 1 auto", "padding:7px 8px", "border-radius:9px", "cursor:pointer",
      "font:600 12px system-ui,sans-serif",
      principal ? "background:#c8102e;color:#fff;border:none"
                : "background:#fff;color:#444;border:1px solid #d8d4cf",
    ].join(";");
    return b;
  }

  function afficher(etat) {
    const panneau = construirePanneau();
    panneau.textContent = "";

    const titre = document.createElement("div");
    titre.style.cssText = "font-weight:700;margin-bottom:4px";
    titre.textContent = "Auchan-Opti";
    panneau.appendChild(titre);

    const info = document.createElement("div");
    info.style.cssText = "color:#666;margin-bottom:9px";
    info.textContent = etat.message;
    panneau.appendChild(info);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";

    // Dérouler la page en cours pour déclencher le chargement paresseux de
    // tous ses produits. C'est le défilement de l'utilisateur, automatisé, sur
    // une page qu'il a lui-même ouverte : aucune navigation, aucun lien suivi.
    // Un rayon complet passe ainsi de deux cents clics à un seul.
    const derouler = bouton("Dérouler la page", true);
    derouler.addEventListener("click", async () => {
      if (defilementEnCours) return;
      defilementEnCours = true;
      derouler.disabled = true;
      const avant = Object.keys(lireReleve()).length;

      try {
        await deroulerPage((position, hauteur) => {
          info.textContent = `Défilement ${Math.round((position / hauteur) * 100)} %…`;
        });
        passer();
        const apres = Object.keys(lireReleve()).length;
        info.textContent = `Page déroulée : ${apres - avant} produit(s) de plus, ${apres} au total.`;
      } finally {
        defilementEnCours = false;
        derouler.disabled = false;
      }
    });

    const copier = bouton("Copier le relevé", false);
    copier.addEventListener("click", async () => {
      const contenu = JSON.stringify(
        { version: 1, produits: Object.values(lireReleve()) },
        null, 2,
      );
      try {
        await navigator.clipboard.writeText(contenu);
        info.textContent = "Relevé copié. Colle-le dans Auchan-Opti → Réglages.";
      } catch {
        // Le presse-papier peut être refusé : on retombe sur un téléchargement.
        const lien = document.createElement("a");
        lien.href = URL.createObjectURL(new Blob([contenu], { type: "application/json" }));
        lien.download = "releve-auchan.json";
        lien.click();
        URL.revokeObjectURL(lien.href);
        info.textContent = "Relevé téléchargé.";
      }
    });

    const vider = bouton("Vider", false);
    vider.addEventListener("click", () => {
      ecrireReleve({});
      info.textContent = "Relevé vidé.";
    });

    actions.append(derouler, copier, vider);
    panneau.appendChild(actions);

    const astuce = document.createElement("div");
    astuce.style.cssText = "margin-top:9px;padding-top:8px;border-top:1px solid #eee;color:#888;font-size:11px;line-height:1.4";
    astuce.textContent = "Le plus rentable : ouvre « Mes commandes », une liste "
      + "enregistrée, ou un rayon entier — une seule page y contient des dizaines "
      + "de produits.";
    panneau.appendChild(astuce);
  }

  /**
   * Fait défiler la page jusqu'en bas, par paliers, en laissant le temps au
   * contenu paresseux de se charger. S'arrête dès que la hauteur cesse de
   * croître, ou au bout d'un plafond de paliers — une page infinie ne doit pas
   * faire tourner le script sans fin.
   */
  async function deroulerPage(onProgres) {
    const PALIER = Math.max(400, window.innerHeight * 0.85);
    const PALIERS_MAX = 120;
    let stagnation = 0;

    for (let i = 0; i < PALIERS_MAX; i++) {
      const hauteurAvant = document.body.scrollHeight;
      const position = window.scrollY + window.innerHeight;

      onProgres(Math.min(position, hauteurAvant), hauteurAvant);
      window.scrollBy(0, PALIER);
      await pause(450);

      const enBas = window.scrollY + window.innerHeight >= document.body.scrollHeight - 5;
      const aGrandi = document.body.scrollHeight > hauteurAvant;

      if (enBas && !aGrandi) {
        // Deux paliers sans rien de neuf : la page est bel et bien terminée.
        if (++stagnation >= 2) break;
        await pause(700);
      } else {
        stagnation = 0;
      }
    }

    window.scrollTo({ top: 0, behavior: "instant" });
  }

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------------------
  // Boucle : le site est une application, le contenu change sans rechargement
  // ---------------------------------------------------------------------------

  let dernierResume = "";
  /** Empêche deux défilements concurrents, qui se gêneraient mutuellement. */
  let defilementEnCours = false;

  function passer() {
    const { produits, methode } = extraireProduits();
    const magasin = detecterMagasin();

    if (produits.length === 0) {
      const releve = lireReleve();
      const total = Object.keys(releve).length;
      afficher({
        message: total > 0
          ? `${total} produit(s) relevés. Rien à lire sur cette page.`
          : "Rien à lire ici. Ouvre une fiche produit ou un rayon.",
      });
      return;
    }

    const { total, nouveaux } = enregistrer(produits, magasin);
    const resume = `${total}|${nouveaux}|${methode}`;
    if (resume === dernierResume) return;
    dernierResume = resume;

    afficher({
      message: `${total} produit(s) relevés${nouveaux > 0 ? ` (+${nouveaux})` : ""}`
        + ` — lecture par ${methode}${magasin ? ` · ${magasin}` : ""}.`,
    });
  }

  passer();
  // Le site remplace son contenu sans recharger : on repasse quand il change,
  // avec une temporisation pour ne pas travailler à chaque micro-mutation.
  let minuteur;
  new MutationObserver(() => {
    if (defilementEnCours) return; // l'analyse se fera une fois en bas de page
    clearTimeout(minuteur);
    minuteur = setTimeout(passer, 1200);
  }).observe(document.body, { childList: true, subtree: true });
})();
