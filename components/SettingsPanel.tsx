"use client";

import { useEffect, useRef, useState } from "react";
import type { Catalog, Product } from "@/lib/types";
import type { StoreOverride } from "@/lib/catalog";
import {
  formatPrice, normalize, packLabel, provenanceLabel, seedCatalog,
} from "@/lib/catalog";
import { CSV_TEMPLATE, exportCsv, importCsv, type CsvImportResult } from "@/lib/catalog/sources";
import { FALLBACK_MODELS, GeminiError, listModels, type GeminiModel } from "@/lib/ai/gemini";
import { download } from "@/lib/export";
import { Button, Card, Field, Notice, TextInput } from "@/components/ui";
import { CollectPanel } from "@/components/CollectPanel";
import { ShelfMode } from "@/components/ShelfMode";

export function SettingsPanel({
  apiKey, onApiKeyChange, model, onModelChange,
  overrides, onOverridesChange, catalog, onCatalogChange,
  assumeStaples, onAssumeStaplesChange,
}: {
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  overrides: StoreOverride[];
  onOverridesChange: (value: StoreOverride[]) => void;
  catalog: Catalog;
  onCatalogChange: (value: Catalog | null) => void;
  assumeStaples: boolean;
  onAssumeStaplesChange: (value: boolean) => void;
}) {
  // Les réglages couvrent trois sujets distincts ; les empiler ferait une page
  // interminable où le relevé de prix — le plus utile — serait tout en bas.
  const [tab, setTab] = useState<"prix" | "rayon" | "ia">("prix");

  const tabs = [
    { id: "prix", label: "Prix & stock" },
    { id: "rayon", label: "Mode rayon" },
    { id: "ia", label: "IA & catalogue" },
  ] as const;

  return (
    <div className="space-y-5">
      <div className="flex gap-2 rounded-2xl border border-line bg-surface p-1.5">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-pressed={tab === entry.id}
            className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
              tab === entry.id ? "bg-accent text-white" : "text-muted hover:text-ink"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "prix" && (
        <CollectPanel
          catalog={catalog}
          onCatalogChange={(next) => onCatalogChange(next)}
        />
      )}

      {tab === "rayon" && (
        <ShelfMode
          products={catalog.products}
          overrides={overrides}
          onOverridesChange={onOverridesChange}
        />
      )}

      {tab === "ia" && (
        <>
          <GeminiSettings
            apiKey={apiKey}
            onApiKeyChange={onApiKeyChange}
            model={model}
            onModelChange={onModelChange}
          />
          <CatalogSettings
            catalog={catalog}
            onCatalogChange={onCatalogChange}
            overrides={overrides}
            onOverridesChange={onOverridesChange}
            assumeStaples={assumeStaples}
            onAssumeStaplesChange={onAssumeStaplesChange}
          />
        </>
      )}
    </div>
  );
}

function GeminiSettings({
  apiKey, onApiKeyChange, model, onModelChange,
}: {
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
}) {
  const [models, setModels] = useState<GeminiModel[]>(FALLBACK_MODELS);
  const [status, setStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [error, setError] = useState("");
  const [reveal, setReveal] = useState(false);

  const check = async () => {
    if (!apiKey.trim()) return;
    setStatus("checking");
    setError("");
    try {
      const available = await listModels(apiKey.trim());
      setModels(available);
      setStatus("ok");
      if (!available.some((m) => m.id === model)) {
        const preferred = available.find((m) => m.id.includes("flash")) ?? available[0];
        if (preferred) onModelChange(preferred.id);
      }
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof GeminiError ? caught.message : "Vérification impossible.");
    }
  };

  return (
    <Card
      title="Clé Gemini"
      subtitle="Elle reste dans ce navigateur et part directement chez Google : elle ne transite jamais par le serveur de cette application."
    >
      <div className="space-y-4">
        <Field
          label="Clé API"
          hint="Gratuite sur aistudio.google.com/apikey. Sans clé, l'application bascule sur un planificateur hors-ligne."
        >
          <div className="flex gap-2">
            <div className="flex-1">
              <TextInput
                type={reveal ? "text" : "password"}
                value={apiKey}
                onChange={onApiKeyChange}
                placeholder="AIza…"
                ariaLabel="Clé API Gemini"
              />
            </div>
            <Button variant="secondary" onClick={() => setReveal((v) => !v)}>
              {reveal ? "Masquer" : "Voir"}
            </Button>
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={check} disabled={!apiKey.trim() || status === "checking"}>
            {status === "checking" ? "Vérification…" : "Vérifier la clé"}
          </Button>
          {status === "ok" && (
            <span className="text-sm text-good">
              Clé valide — {models.length} modèles disponibles.
            </span>
          )}
          {status === "error" && <span className="text-sm text-warn">{error}</span>}
        </div>

        <Field label="Modèle">
          <select
            className="w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-base outline-none focus:border-accent"
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>

        {apiKey.trim() && (
          <Notice>
            Chaque génération consomme des jetons de ton quota Google. Le catalogue
            envoyé pèse quelques milliers de jetons ; un modèle Flash suffit largement.
          </Notice>
        )}
      </div>
    </Card>
  );
}

function CatalogSettings({
  catalog, onCatalogChange, overrides, onOverridesChange,
  assumeStaples, onAssumeStaplesChange,
}: {
  catalog: Catalog;
  onCatalogChange: (value: Catalog | null) => void;
  overrides: StoreOverride[];
  onOverridesChange: (value: StoreOverride[]) => void;
  assumeStaples: boolean;
  onAssumeStaplesChange: (value: boolean) => void;
}) {
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const matches = useSearch(catalog.products, query);
  const overrideById = new Map(overrides.map((o) => [o.productId, o]));

  const setOverride = (productId: string, patch: Partial<StoreOverride>) => {
    const existing = overrideById.get(productId) ?? { productId };
    const next = { ...existing, ...patch };
    const isEmpty = next.price === undefined && next.stock === undefined;
    onOverridesChange([
      ...overrides.filter((o) => o.productId !== productId),
      ...(isEmpty ? [] : [next]),
    ]);
  };

  return (
    <Card
      title="Catalogue de ton magasin"
      subtitle={`${catalog.products.length} produits · ${catalog.source === "csv" ? "prix importés" : "relevé indicatif"} · mis à jour le ${catalog.updatedAt}`}
    >
      <div className="space-y-5">
        <Notice title="Pourquoi un import plutôt qu'une connexion directe ?">
          Auchan ne publie pas d&apos;API de prix. La seule donnée exacte pour{" "}
          <em>ton</em> magasin, c&apos;est celle que tu relèves ou que tu exportes de
          ton compte. Le détail est dans <code>docs/SOURCES_DONNEES.md</code>.
        </Notice>

        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.txt,text/csv"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const imported = importCsv(await file.text(), seedCatalog);
              setResult(imported);
              onCatalogChange(imported.catalog);
              event.target.value = "";
            }}
          />
          <Button variant="secondary" onClick={() => fileInput.current?.click()}>
            Importer mes prix (CSV)
          </Button>
          <Button
            variant="secondary"
            onClick={() => download("modele-prix.csv", CSV_TEMPLATE, "text/csv;charset=utf-8")}
          >
            Télécharger le modèle
          </Button>
          <Button
            variant="secondary"
            onClick={() => download("mon-catalogue.csv", exportCsv(catalog), "text/csv;charset=utf-8")}
          >
            Exporter le catalogue
          </Button>
          {catalog.source === "csv" && (
            <Button variant="ghost" onClick={() => { onCatalogChange(null); setResult(null); }}>
              Revenir au catalogue d&apos;origine
            </Button>
          )}
        </div>

        {result && (
          <Notice tone={result.rejected.length > 0 ? "warn" : "info"}>
            {result.updated} prix mis à jour, {result.added} produits ajoutés.
            {result.rejected.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {result.rejected.slice(0, 5).map((r, i) => (
                  <li key={i}>Ligne {r.line} : {r.reason}</li>
                ))}
                {result.rejected.length > 5 && <li>…et {result.rejected.length - 5} autres.</li>}
              </ul>
            )}
          </Notice>
        )}

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-canvas px-3 py-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            checked={assumeStaples}
            onChange={(event) => onAssumeStaplesChange(event.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium">J&apos;ai déjà un fond de placard</span>
            <span className="block text-muted">
              Sel, poivre, épices, huile et farine sont facturés au prorata au lieu du
              pot entier. Décoche si tu pars de zéro.
            </span>
          </span>
        </label>

        <div>
          <Field
            label="Corriger un prix ou signaler une rupture"
            hint="Ces corrections sont conservées et s'appliquent à toutes tes prochaines listes."
          >
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="Chercher un produit…"
            />
          </Field>

          {overrides.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              {overrides.length} correction(s) enregistrée(s).{" "}
              <button
                type="button"
                className="text-accent underline"
                onClick={() => onOverridesChange([])}
              >
                Tout effacer
              </button>
            </p>
          )}

          {matches.length > 0 && (
            <ul className="mt-3 space-y-2">
              {matches.map((product) => {
                const override = overrideById.get(product.id);
                return (
                  <li
                    key={product.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-canvas px-3 py-2.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{product.name}</span>
                      <span className="block text-xs text-muted">
                        {product.rayon} · {packLabel(product)} ·{" "}
                        {formatPrice(product.price)} · {provenanceLabel(product.priceFrom)}
                      </span>
                    </span>

                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder={product.price.toFixed(2)}
                      value={override?.price ?? ""}
                      aria-label={`Prix relevé pour ${product.name}`}
                      className="w-24 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setOverride(product.id, {
                          price: event.target.value === "" || !Number.isFinite(value) || value <= 0
                            ? undefined
                            : Math.round(value * 100) / 100,
                        });
                      }}
                    />

                    <select
                      className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
                      aria-label={`Disponibilité de ${product.name}`}
                      value={override?.stock ?? product.stock}
                      onChange={(event) =>
                        setOverride(product.id, {
                          stock: event.target.value as Product["stock"],
                        })
                      }
                    >
                      <option value="inconnu">Stock inconnu</option>
                      <option value="en_rayon">En rayon</option>
                      <option value="stock_faible">Stock faible</option>
                      <option value="rupture">Rupture</option>
                    </select>
                  </li>
                );
              })}
            </ul>
          )}

          {query.trim().length >= 2 && matches.length === 0 && (
            <p className="mt-3 text-sm text-muted">Aucun produit ne correspond.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Recherche incrémentale limitée : au-delà de dix résultats, on affine. */
function useSearch(products: Product[], query: string): Product[] {
  const [results, setResults] = useState<Product[]>([]);

  useEffect(() => {
    const q = normalize(query);
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setResults(
      products
        .filter((p) => normalize(p.name).includes(q) || normalize(p.category).includes(q))
        .slice(0, 10),
    );
  }, [products, query]);

  return results;
}
