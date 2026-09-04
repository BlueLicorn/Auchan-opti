"use client";

import { useEffect, useRef, useState } from "react";
import type { Catalog } from "@/lib/types";
import { coverage, formatPrice, seedCatalog } from "@/lib/catalog";
import {
  importReleve, mergeEntries, parseReceiptText,
  type CollectResult, type ReleveEntry,
} from "@/lib/catalog/collect";
import { Button, Card, Notice, Stat } from "@/components/ui";
import { CommunityPrices } from "@/components/CommunityPrices";

/**
 * Écran du relevé en magasin.
 *
 * C'est ici que l'application passe des prix estimés aux prix réels. Le
 * collecteur ne robotise rien : il lit les pages Auchan que l'utilisateur
 * consulte lui-même, dans sa propre session. L'interface doit rendre ce
 * fonctionnement évident, sans quoi l'utilisateur ne peut pas juger de ce
 * qu'il installe.
 */
export function CollectPanel({
  catalog, onCatalogChange,
}: {
  catalog: Catalog;
  onCatalogChange: (value: Catalog) => void;
}) {
  const [result, setResult] = useState<CollectResult | null>(null);
  const [pasted, setPasted] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const stats = coverage(catalog.products);
  const pctPrix = Math.round((stats.realPrices / Math.max(1, stats.total)) * 100);
  const pctStock = Math.round((stats.knownStock / Math.max(1, stats.total)) * 100);

  const apply = (raw: string) => {
    const imported = importReleve(raw, catalog);
    setResult(imported);
    if (imported.matched > 0 || imported.added > 0 || imported.stockUpdated > 0) {
      onCatalogChange(imported.catalog);
      setPasted("");
    }
  };

  return (
    <div className="space-y-5">
      <Card
        title="Ce que l'application sait vraiment"
        subtitle={
          catalog.storeLabel
            ? `Données rattachées à : ${catalog.storeLabel}`
            : "Aucun magasin identifié pour l'instant."
        }
      >
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="Prix réels"
            value={`${pctPrix} %`}
            tone={pctPrix >= 60 ? "good" : pctPrix > 0 ? "warn" : "neutral"}
            hint={`${stats.realPrices} sur ${stats.total}`}
          />
          <Stat
            label="Stock connu"
            value={`${pctStock} %`}
            tone={pctStock >= 60 ? "good" : pctStock > 0 ? "warn" : "neutral"}
            hint={`${stats.knownStock} sur ${stats.total}`}
          />
          <Stat
            label="À rafraîchir"
            value={String(stats.stale)}
            tone={stats.stale > 0 ? "warn" : "neutral"}
            hint="relevés > 30 jours"
          />
        </div>

        {pctPrix === 0 && (
          <Notice tone="warn" title="Aucun prix réel pour l'instant">
            Tous les prix affichés sont des estimations. Ton total sera dans le
            bon ordre de grandeur, pas au centime. Le relevé ci-dessous corrige
            ça produit par produit.
          </Notice>
        )}
      </Card>

      <Card
        title="Relever les prix et le stock de ton magasin"
        subtitle="Auchan ne publie ni API de prix ni API de stock. La seule source qui contient les deux, c'est le site Drive avec ton magasin sélectionné."
      >
        <div className="space-y-5">
          <Notice title="Les pages qui rapportent le plus">
            Inutile d&apos;ouvrir les fiches une par une. <strong>Mes commandes</strong>,
            une <strong>liste enregistrée</strong> ou un <strong>rayon entier</strong>{" "}
            contiennent chacun des dizaines de produits sur une seule page.
            Ouvre-en une, clique sur « Dérouler la page », et c&apos;est fait.
          </Notice>

          <Notice title="Comment ça marche, exactement">
            Le collecteur est un petit script qui s&apos;exécute{" "}
            <strong>dans ton navigateur, sur les pages Auchan que tu ouvres
            toi-même</strong>. Il ne fait aucune requête au site, ne suit aucun
            lien, ne stocke aucun identifiant : il lit ce que ton écran affiche
            déjà, et l&apos;accumule localement. Rien n&apos;en sort tant que tu
            ne cliques pas sur « Copier ».
          </Notice>

          <Installation />

          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <Step n={3} />
              <span>
                Va sur auchan.fr, <strong>choisis ton magasin</strong>, puis
                navigue normalement dans les rayons qui t&apos;intéressent. Un
                encart en bas à droite compte les produits relevés.
              </span>
            </li>
            <li className="flex gap-3">
              <Step n={4} />
              <span>
                Sur une page de rayon, clique sur{" "}
                <strong>« Dérouler la page »</strong> : le script fait défiler
                la page jusqu&apos;au bout pour que tous ses produits se
                chargent. Un rayon entier se relève ainsi en un clic, sans
                ouvrir la moindre fiche produit.
              </span>
            </li>
            <li className="flex gap-3">
              <Step n={5} />
              <span>
                Clique sur « Copier le relevé », puis colle-le ci-dessous.
              </span>
            </li>
          </ol>

          <div>
            <textarea
              className="h-28 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 font-mono text-xs outline-none focus:border-accent"
              placeholder='Colle ici le relevé copié depuis auchan.fr — il commence par {"version":1,...'
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              aria-label="Relevé à importer"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onClick={() => apply(pasted)} disabled={pasted.trim().length < 10}>
                Importer le relevé
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) apply(await file.text());
                  event.target.value = "";
                }}
              />
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                Ou choisir le fichier
              </Button>
            </div>
          </div>

          {result && <ImportReport result={result} />}
        </div>
      </Card>

      <ReceiptImport catalog={catalog} onCatalogChange={onCatalogChange} />

      <CommunityPrices catalog={catalog} onCatalogChange={onCatalogChange} />
    </div>
  );
}

/**
 * Installation du collecteur, par favori ou par extension.
 *
 * Le favori est proposé en premier parce qu'il ne demande rien à installer :
 * l'extension était l'obstacle qui décourageait le plus, et elle n'existe
 * quasiment pas sur téléphone.
 */
function Installation() {
  const [code, setCode] = useState("");
  const [copie, setCopie] = useState("");
  const lien = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    let annule = false;
    fetch("/auchan-collect.bookmarklet.txt")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("indisponible"))))
      .then((texte) => {
        if (!annule) setCode(texte.trim());
      })
      .catch(() => {
        /* le chemin par extension reste proposé ci-dessous */
      });
    return () => {
      annule = true;
    };
  }, []);

  // React refuse une URL « javascript: » dans un href : on la pose nous-mêmes
  // sur l'élément, ce qui est justement le mécanisme d'un favori.
  useEffect(() => {
    if (lien.current && code) lien.current.setAttribute("href", code);
  }, [code]);

  return (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <p className="text-sm font-semibold">Installer le collecteur</p>

      <div className="mt-3 space-y-4">
        <div>
          <p className="text-sm font-medium">Sur ordinateur — le plus simple</p>
          <p className="mt-1 text-sm text-muted">
            Affiche ta barre de favoris ({" "}
            <kbd className="rounded border border-line px-1">Ctrl</kbd>+
            <kbd className="rounded border border-line px-1">Maj</kbd>+
            <kbd className="rounded border border-line px-1">B</kbd>, ou{" "}
            <kbd className="rounded border border-line px-1">Cmd</kbd>+
            <kbd className="rounded border border-line px-1">Maj</kbd>+
            <kbd className="rounded border border-line px-1">B</kbd> sur Mac),
            puis <strong>fais glisser ce bouton dedans</strong>. Rien à
            installer.
          </p>
          <p className="mt-2">
            {code ? (
              <a
                ref={lien}
                draggable
                onClick={(event) => event.preventDefault()}
                className="inline-block cursor-grab rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white"
              >
                📋 Relever les prix Auchan
              </a>
            ) : (
              <span className="text-sm text-muted">Chargement du collecteur…</span>
            )}
          </p>
          <p className="mt-2 text-xs text-muted">
            Ensuite : va sur auchan.fr, et clique sur ce favori.
          </p>
        </div>

        <div>
          <p className="text-sm font-medium">Sur téléphone</p>
          <p className="mt-1 text-sm text-muted">
            Copie le code, crée un favori sur n&apos;importe quelle page, puis
            modifie-le : remplace son adresse par le code collé et nomme-le
            « Relever Auchan ». Sur la page Auchan, ouvre la barre d&apos;adresse
            et tape le nom du favori pour le déclencher.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(code);
                  setCopie("Code copié.");
                } catch {
                  setCopie("Copie refusée : sélectionne le code à la main.");
                }
                window.setTimeout(() => setCopie(""), 3000);
              }}
            >
              Copier le code du collecteur
            </Button>
            {copie && <span className="text-xs text-good">{copie}</span>}
          </div>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-muted">
            Ou par extension, si tu préfères
          </summary>
          <p className="mt-2 text-muted">
            Installe{" "}
            <a
              className="text-accent underline"
              href="https://violentmonkey.github.io/"
              target="_blank"
              rel="noreferrer noopener"
            >
              Violentmonkey
            </a>{" "}
            ou Tampermonkey, puis colle{" "}
            <a
              className="text-accent underline"
              href="/auchan-collect.user.js"
              target="_blank"
              rel="noreferrer noopener"
            >
              le collecteur
            </a>{" "}
            dans un nouveau script. Il se lancera alors tout seul sur auchan.fr,
            sans avoir à cliquer sur un favori.
          </p>
        </details>
      </div>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent"
    >
      {n}
    </span>
  );
}

function ImportReport({ result }: { result: CollectResult }) {
  const rien = result.matched === 0 && result.added === 0 && result.stockUpdated === 0;

  return (
    <Notice tone={rien || result.rejected.length > 0 ? "warn" : "info"}>
      {rien ? (
        <p className="font-medium">Rien n&apos;a été importé.</p>
      ) : (
        <p className="font-medium">
          {result.matched} prix relevés appliqués, {result.stockUpdated} disponibilités
          renseignées, {result.added} produits ajoutés
          {result.storeLabel ? ` — magasin ${result.storeLabel}` : ""}.
        </p>
      )}

      {result.rejected.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {result.rejected.slice(0, 6).map((entry, i) => (
            <li key={i}>
              <span className="font-medium">{entry.label}</span> — {entry.reason}
            </li>
          ))}
          {result.rejected.length > 6 && (
            <li>…et {result.rejected.length - 6} autres lignes écartées.</li>
          )}
        </ul>
      )}
    </Notice>
  );
}

/**
 * Import d'une commande ou d'un ticket collé.
 *
 * Le meilleur rapport effort/exactitude qui existe : ce sont les prix
 * réellement payés, pour les produits réellement achetés, et ce sont les
 * données du compte de l'utilisateur — rien n'est collecté nulle part.
 */
function ReceiptImport({
  catalog, onCatalogChange,
}: {
  catalog: Catalog;
  onCatalogChange: (value: Catalog) => void;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ReleveEntry[] | null>(null);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [result, setResult] = useState<CollectResult | null>(null);

  const analyse = () => {
    const { entries, ignored } = parseReceiptText(text);
    setPreview(entries);
    setIgnoredCount(ignored.length);
    setResult(null);
  };

  const confirm = () => {
    if (!preview || preview.length === 0) return;
    const merged = mergeEntries(preview, catalog);
    setResult(merged);
    if (merged.matched > 0 || merged.added > 0) {
      onCatalogChange(merged.catalog);
      setText("");
      setPreview(null);
    }
  };

  return (
    <Card
      title="Coller une commande ou un ticket"
      subtitle="Le chemin le plus court vers des prix exacts : ce que tu as réellement payé, pour ce que tu achètes réellement."
    >
      <div className="space-y-4">
        <Notice>
          Ouvre <strong>Mes commandes</strong> sur ton compte Auchan, sélectionne
          le détail d&apos;une commande, copie-le, et colle-le ici. Un ticket
          dématérialisé fonctionne aussi. Ce sont tes données : rien n&apos;est
          collecté ailleurs que dans ton propre compte.
        </Notice>

        <textarea
          className="h-32 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 font-mono text-xs outline-none focus:border-accent"
          placeholder={"PENNE 500G                 1,15 €\nFILETS DE POULET 1KG       8,99 €\n3 x YAOURT NATURE          4,50 €"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="Commande ou ticket à analyser"
        />

        <Button onClick={analyse} disabled={text.trim().length < 6}>
          Analyser
        </Button>

        {preview && preview.length === 0 && (
          <Notice tone="warn">
            Aucune ligne de produit reconnue. Il faut un libellé suivi d&apos;un
            prix en fin de ligne, par exemple « PENNE 500G 1,15 € ».
          </Notice>
        )}

        {preview && preview.length > 0 && (
          <div className="rounded-xl border border-line bg-canvas p-3">
            <p className="mb-2 text-sm font-medium">
              {preview.length} ligne(s) reconnue(s)
              {ignoredCount > 0 && `, ${ignoredCount} écartée(s)`} — vérifie avant
              d&apos;appliquer.
            </p>
            <ul className="max-h-52 overflow-y-auto text-sm">
              {preview.map((entry, i) => (
                <li
                  key={i}
                  className="flex justify-between gap-3 border-b border-line py-1.5 last:border-0"
                >
                  <span className="min-w-0 truncate">{entry.nom}</span>
                  <span className="shrink-0 tabular-nums font-medium">
                    {formatPrice(entry.prix ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <Button onClick={confirm}>Appliquer au catalogue</Button>
            </div>
          </div>
        )}

        {result && <ImportReport result={result} />}
      </div>
    </Card>
  );
}

/** Rappel : le catalogue embarqué reste la référence de repli. */
export const FALLBACK_CATALOG = seedCatalog;
