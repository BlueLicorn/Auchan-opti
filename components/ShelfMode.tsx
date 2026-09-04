"use client";

import { useEffect, useRef, useState } from "react";
import type { Product, StockStatus } from "@/lib/types";
import type { StoreOverride } from "@/lib/catalog";
import {
  formatPrice, normalize, packLabel, provenanceLabel,
} from "@/lib/catalog";
import { Button, Card, Notice, TextInput } from "@/components/ui";

/**
 * Relevé en rayon, téléphone en main.
 *
 * Complément du collecteur navigateur : celui-ci couvre le drive, celui-là le
 * magasin physique, où l'étiquette est la seule vérité. Tout est conçu pour
 * une main : gros boutons, saisie numérique, validation en un geste.
 */
export function ShelfMode({
  products, overrides, onOverridesChange,
}: {
  products: Product[];
  overrides: StoreOverride[];
  onOverridesChange: (value: StoreOverride[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<Product | null>(null);
  const [price, setPrice] = useState("");
  const [done, setDone] = useState<string[]>([]);
  const priceInput = useRef<HTMLInputElement>(null);

  const matches = query.trim().length >= 2 ? search(products, query, 6) : [];

  const record = (product: Product, patch: Partial<StoreOverride>) => {
    const at = new Date().toISOString().slice(0, 10);
    const existing = overrides.find((o) => o.productId === product.id) ?? { productId: product.id };
    onOverridesChange([
      ...overrides.filter((o) => o.productId !== product.id),
      { ...existing, ...patch, at },
    ]);
    setDone((d) => [product.name, ...d.filter((n) => n !== product.name)].slice(0, 8));
  };

  const validate = () => {
    if (!current) return;
    const value = Number(price.replace(",", "."));
    if (Number.isFinite(value) && value > 0) {
      record(current, { price: Math.round(value * 100) / 100, stock: "en_rayon" });
    }
    setCurrent(null);
    setPrice("");
    setQuery("");
  };

  return (
    <div className="space-y-5">
      <Card
        title="Mode rayon"
        subtitle="Devant l'étiquette, corrige le prix en trois gestes. Le relevé est daté et s'applique à toutes tes listes."
      >
        <div className="space-y-4">
          <BarcodeScanner
            onDetected={(ean) => {
              const found = products.find((p) => p.ean === ean);
              if (found) {
                setCurrent(found);
                setQuery("");
                window.setTimeout(() => priceInput.current?.focus(), 50);
              } else {
                setQuery(ean);
              }
            }}
          />

          {!current && (
            <>
              <TextInput
                value={query}
                onChange={setQuery}
                placeholder="Chercher un produit…"
                ariaLabel="Chercher un produit à relever"
              />

              {matches.length > 0 && (
                <ul className="space-y-2">
                  {matches.map((product) => (
                    <li key={product.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setCurrent(product);
                          setPrice("");
                          window.setTimeout(() => priceInput.current?.focus(), 50);
                        }}
                        className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-canvas px-3 py-3 text-left transition hover:border-accent/40"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{product.name}</span>
                          <span className="block text-xs text-muted">
                            {packLabel(product)} · {provenanceLabel(product.priceFrom)}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums text-sm font-semibold">
                          {formatPrice(product.price)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {query.trim().length >= 2 && matches.length === 0 && (
                <p className="text-sm text-muted">Aucun produit ne correspond.</p>
              )}
            </>
          )}

          {current && (
            <div className="rounded-xl border border-accent/40 bg-accent-soft/40 p-4">
              <p className="text-sm font-semibold">{current.name}</p>
              <p className="mt-0.5 text-xs text-muted">
                {packLabel(current)} · au catalogue {formatPrice(current.price)} ·{" "}
                {provenanceLabel(current.priceFrom)}
              </p>

              <label className="mt-3 block">
                <span className="mb-1.5 block text-sm font-medium">
                  Prix sur l&apos;étiquette
                </span>
                <input
                  ref={priceInput}
                  type="text"
                  inputMode="decimal"
                  className="w-full rounded-xl border border-line bg-surface px-3 py-3 text-lg font-semibold outline-none focus:border-accent"
                  placeholder={current.price.toFixed(2)}
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") validate();
                  }}
                />
              </label>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={validate} disabled={!price.trim()}>
                  Enregistrer
                </Button>
                {(["rupture", "stock_faible"] as StockStatus[]).map((status) => (
                  <Button
                    key={status}
                    variant="secondary"
                    onClick={() => {
                      record(current, { stock: status });
                      setCurrent(null);
                      setPrice("");
                      setQuery("");
                    }}
                  >
                    {status === "rupture" ? "En rupture" : "Stock faible"}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCurrent(null);
                    setPrice("");
                  }}
                >
                  Annuler
                </Button>
              </div>
            </div>
          )}

          {done.length > 0 && (
            <p className="text-xs text-muted">
              Relevés à l&apos;instant : {done.join(", ")}.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

/**
 * Lecture de code-barres par la caméra.
 *
 * L'API BarcodeDetector n'existe pas partout (absente de Safari et de Firefox
 * à ce jour). Plutôt que d'embarquer une bibliothèque de décodage de plusieurs
 * centaines de kilo-octets pour un usage d'appoint, on utilise l'API quand
 * elle est là et on le dit clairement quand elle ne l'est pas : la recherche
 * par nom reste disponible dans tous les cas.
 */
function BarcodeScanner({ onDetected }: { onDetected: (ean: string) => void }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setSupported("BarcodeDetector" in window);
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let frame = 0;

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const Detector = (window as unknown as {
          BarcodeDetector: new (options: { formats: string[] }) => {
            detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
          };
        }).BarcodeDetector;
        const detector = new Detector({ formats: ["ean_13", "ean_8", "upc_a"] });

        const scan = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const code = codes[0]?.rawValue;
            if (code) {
              onDetected(code);
              setActive(false);
              return;
            }
          } catch {
            /* image illisible sur cette trame : on retente à la suivante */
          }
          frame = window.setTimeout(scan, 350);
        };
        scan();
      } catch {
        if (!cancelled) {
          setError("Caméra indisponible ou refusée. Utilise la recherche par nom.");
          setActive(false);
        }
      }
    };

    start();

    return () => {
      cancelled = true;
      window.clearTimeout(frame);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [active, onDetected]);

  if (supported === null) return null;

  if (!supported) {
    return (
      <Notice>
        Ton navigateur ne sait pas lire les codes-barres (l&apos;API n&apos;existe
        pas sur Safari ni Firefox). Utilise la recherche par nom, ou Chrome sur
        Android.
      </Notice>
    );
  }

  return (
    <div>
      {active ? (
        <div>
          <video
            ref={videoRef}
            className="w-full rounded-xl border border-line bg-black"
            style={{ maxHeight: 240 }}
            muted
            playsInline
          />
          <Button variant="secondary" onClick={() => setActive(false)}>
            Arrêter la caméra
          </Button>
        </div>
      ) : (
        <Button variant="secondary" full onClick={() => setActive(true)}>
          Scanner un code-barres
        </Button>
      )}
      {error && <p className="mt-2 text-sm text-warn">{error}</p>}
    </div>
  );
}

function search(products: Product[], query: string, limit: number): Product[] {
  const q = normalize(query);
  return products
    .filter((p) => normalize(p.name).includes(q) || p.ean === query.trim())
    .slice(0, limit);
}
