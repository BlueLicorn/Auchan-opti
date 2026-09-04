/**
 * Fabrique une version « bookmarklet » du collecteur.
 *
 * Le script utilisateur exige d'installer Violentmonkey ou Tampermonkey, ce
 * qui est l'obstacle principal — surtout sur téléphone, où ces extensions
 * n'existent quasiment pas. Un bookmarklet, lui, est un simple favori : on le
 * range dans la barre de marque-pages et on clique dessus sur la page Auchan.
 *
 * Le code est intégralement embarqué dans l'URL plutôt que téléchargé depuis
 * un serveur : la politique de sécurité du site marchand bloquerait le
 * chargement d'un script externe, alors qu'un favori déclenché par
 * l'utilisateur y échappe.
 *
 * Usage : node scripts/build-bookmarklet.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync(new URL("../public/auchan-collect.user.js", import.meta.url), "utf-8");

// L'en-tête ==UserScript== ne sert qu'aux gestionnaires de scripts.
const body = source.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n?/m, "");

// Un favori relancé deux fois ne doit pas empiler deux panneaux.
const guarded = `(function(){if(window.__auchanOptiCharge){alert("Collecteur déjà actif sur cette page.");return;}window.__auchanOptiCharge=1;\n${body}\n})();`;

const url = `javascript:${encodeURIComponent(guarded)}`;

writeFileSync(new URL("../public/auchan-collect.bookmarklet.txt", import.meta.url), url);

console.log(`bookmarklet écrit : ${(url.length / 1024).toFixed(1)} Ko`);
if (url.length > 60000) {
  console.warn("Attention : au-delà de 60 Ko, certains navigateurs tronquent un favori.");
}
