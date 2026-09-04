"use client";

import { useRef, useState } from "react";
import type { Catalog } from "@/lib/types";
import { coverage, seedCatalog } from "@/lib/catalog";
import { importReleve, type CollectResult } from "@/lib/catalog/collect";
import { Button, Card, Notice, Stat } from "@/components/ui";

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
          <Notice title="Comment ça marche, exactement">
            Le collecteur est un petit script qui s&apos;exécute{" "}
            <strong>dans ton navigateur, sur les pages Auchan que tu ouvres
            toi-même</strong>. Il ne fait aucune requête au site, ne suit aucun
            lien, ne stocke aucun identifiant : il lit ce que ton écran affiche
            déjà, et l&apos;accumule localement. Rien n&apos;en sort tant que tu
            ne cliques pas sur « Copier ».
          </Notice>

          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <Step n={1} />
              <span>
                Installe{" "}
                <a
                  className="text-accent underline"
                  href="https://violentmonkey.github.io/"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Violentmonkey
                </a>{" "}
                ou Tampermonkey dans ton navigateur (extension gratuite qui
                exécute des scripts utilisateur).
              </span>
            </li>
            <li className="flex gap-3">
              <Step n={2} />
              <span>
                Ouvre le collecteur et colle-le dans un nouveau script.
                <span className="mt-2 block">
                  <a
                    className="inline-block rounded-xl border border-line bg-canvas px-3 py-2 text-sm font-semibold text-accent"
                    href="/auchan-collect.user.js"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Ouvrir le collecteur
                  </a>
                </span>
              </span>
            </li>
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

/** Rappel : le catalogue embarqué reste la référence de repli. */
export const FALLBACK_CATALOG = seedCatalog;
