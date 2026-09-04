"use client";

import { useState } from "react";
import type { Catalog } from "@/lib/types";
import {
  isStale, mergeCommunityPrices, parseLocations, parsePrices,
  type CommunityPrice, type MergeResult, type StoreLocation,
} from "@/lib/catalog/openprices";
import { Button, Card, Notice, TextInput } from "@/components/ui";

/**
 * Import des prix depuis Open Prices.
 *
 * L'écran doit faire comprendre en une lecture ce que cette source est et ce
 * qu'elle n'est pas : des prix réels, saisis par d'autres, dans un magasin
 * identifié, à une date donnée — et jamais une information de stock.
 */
export function CommunityPrices({
  catalog, onCatalogChange,
}: {
  catalog: Catalog;
  onCatalogChange: (value: Catalog) => void;
}) {
  const [query, setQuery] = useState("");
  const [locations, setLocations] = useState<StoreLocation[] | null>(null);
  const [selected, setSelected] = useState<StoreLocation | null>(null);
  const [prices, setPrices] = useState<CommunityPrice[] | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const call = async (params: Record<string, string>) => {
    const search = new URLSearchParams(params);
    const response = await fetch(`/api/openprices?${search}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error ?? "Requête refusée.");
    return payload;
  };

  const searchStores = async () => {
    setBusy("Recherche du magasin…");
    setError("");
    setLocations(null);
    setPrices(null);
    setResult(null);
    try {
      const payload = await call({
        action: "locations",
        osm_name__like: query.trim(),
        size: "20",
      });
      setLocations(parseLocations(payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recherche impossible.");
    } finally {
      setBusy("");
    }
  };

  const loadPrices = async (location: StoreLocation) => {
    setBusy(`Lecture des prix de ${location.name}…`);
    setError("");
    setSelected(location);
    setPrices(null);
    setResult(null);
    try {
      // Deux pages suffisent : au-delà, ce sont des prix anciens qui
      // n'apporteraient qu'une précision illusoire.
      const pages = await Promise.all([1, 2].map((page) =>
        call({
          action: "prices",
          location_osm_id: String(location.osmId),
          location_osm_type: location.osmType,
          size: "100",
          page: String(page),
          order_by: "-date",
        }).catch(() => null),
      ));

      const collected = pages.filter(Boolean).flatMap((payload) => parsePrices(payload));
      setPrices(collected);
      if (collected.length === 0) {
        setError(
          `Aucun prix n'a encore été partagé pour ${location.name}. C'est le point faible d'une base participative : la couverture dépend des contributeurs.`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Lecture impossible.");
    } finally {
      setBusy("");
    }
  };

  const apply = () => {
    if (!prices || prices.length === 0) return;
    const merged = mergeCommunityPrices(prices, catalog, { storeLabel: selected?.name });
    setResult(merged);
    if (merged.applied > 0) onCatalogChange(merged.catalog);
  };

  const recents = prices?.filter((p) => !isStale(p)).length ?? 0;

  return (
    <Card
      title="Compléter avec Open Prices"
      subtitle="La base de prix ouverte d'Open Food Facts : des prix réels, saisis par d'autres, rattachés à un magasin précis."
    >
      <div className="space-y-4">
        <Notice title="Ce que cette source apporte, et ce qu'elle n'apporte pas">
          Les prix sont <strong>rattachés à un magasin identifié</strong>, pas à
          une moyenne nationale — c&apos;est ce qui la distingue des
          comparateurs commerciaux. En revanche la couverture dépend des
          contributeurs, elle est souvent partielle, et{" "}
          <strong>il n&apos;y a aucune donnée de stock</strong>. Un prix venu
          d&apos;ici ne remplacera jamais un relevé que tu as fait toi-même.
        </Notice>

        <div className="flex gap-2">
          <div className="flex-1">
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="Auchan Villars, Auchan Bordeaux…"
              ariaLabel="Chercher un magasin dans Open Prices"
            />
          </div>
          <Button onClick={searchStores} disabled={query.trim().length < 3 || busy !== ""}>
            Chercher
          </Button>
        </div>

        {busy && <p className="text-sm text-muted">{busy}</p>}
        {error && <Notice tone="warn">{error}</Notice>}

        {locations && locations.length === 0 && !busy && (
          <p className="text-sm text-muted">
            Aucun magasin de ce nom dans Open Prices. Essaie avec la ville seule.
          </p>
        )}

        {locations && locations.length > 0 && (
          <ul className="space-y-2">
            {locations.map((location) => (
              <li key={`${location.osmType}-${location.osmId}`}>
                <button
                  type="button"
                  onClick={() => loadPrices(location)}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left transition ${
                    selected?.osmId === location.osmId
                      ? "border-accent bg-accent-soft"
                      : "border-line bg-canvas hover:border-accent/40"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{location.name}</span>
                    {location.city && (
                      <span className="block text-xs text-muted">{location.city}</span>
                    )}
                  </span>
                  {location.priceCount !== undefined && (
                    <span className="shrink-0 text-xs text-muted">
                      {location.priceCount} prix
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {prices && prices.length > 0 && (
          <div className="rounded-xl border border-line bg-canvas px-3 py-3">
            <p className="text-sm">
              <strong>{prices.length} prix</strong> partagés pour {selected?.name},
              dont <strong>{recents}</strong> de moins de quatre mois.
            </p>
            {recents < prices.length && (
              <p className="mt-1 text-xs text-warn">
                {prices.length - recents} prix datent de plus de quatre mois : avec
                l&apos;inflation alimentaire, ils sont à prendre avec précaution.
              </p>
            )}
            <div className="mt-3">
              <Button onClick={apply}>Appliquer au catalogue</Button>
            </div>
          </div>
        )}

        {result && (
          <Notice tone={result.applied === 0 ? "warn" : "info"}>
            <p className="font-medium">
              {result.applied} prix appliqués au catalogue.
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {result.unmatched > 0 && (
                <li>
                  {result.unmatched} prix ne correspondaient à aucun produit du
                  catalogue — le plus souvent des références qu&apos;il ne contient pas.
                </li>
              )}
              {result.skipped > 0 && (
                <li>
                  {result.skipped} prix écartés : tu avais déjà un relevé personnel
                  ou plus récent sur ces produits.
                </li>
              )}
              {result.foreign > 0 && (
                <li>{result.foreign} prix dans une autre devise, ignorés.</li>
              )}
            </ul>
          </Notice>
        )}
      </div>
    </Card>
  );
}
