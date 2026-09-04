"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Catalog, MealPlan, PlanRequest } from "@/lib/types";
import { applyOverrides, seedCatalog, type StoreOverride } from "@/lib/catalog";
import { generatePlan } from "@/lib/planner";
import {
  DEFAULT_REQUEST, KEYS, loadCatalog, loadOverrides, loadPlan, loadRequest,
  read, remove, write,
} from "@/lib/storage";
import { PlanForm, type BudgetMode } from "@/components/PlanForm";
import { PlanResult } from "@/components/PlanResult";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Button, Notice } from "@/components/ui";

type View = "form" | "result" | "settings";

export default function Home() {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("form");

  const [request, setRequest] = useState<PlanRequest>(DEFAULT_REQUEST);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gemini-2.5-flash");
  const [overrides, setOverrides] = useState<StoreOverride[]>([]);
  const [importedCatalog, setImportedCatalog] = useState<Catalog | null>(null);
  const [assumeStaples, setAssumeStaples] = useState(true);
  const [budgetMode, setBudgetMode] = useState<BudgetMode>("total");

  const [plan, setPlan] = useState<MealPlan | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  // Restauration de l'état persisté. Fait après le montage pour que le rendu
  // serveur et le premier rendu client soient identiques.
  useEffect(() => {
    setRequest(loadRequest());
    setApiKey(read(KEYS.apiKey, ""));
    setModel(read(KEYS.model, "gemini-2.5-flash"));
    setOverrides(loadOverrides());
    setAssumeStaples(read(KEYS.staples, true));
    setChecked(read<string[]>(KEYS.checked, []));
    setImportedCatalog(loadCatalog());
    setBudgetMode(read<BudgetMode>(KEYS.budgetMode, "total"));

    const saved = loadPlan();
    if (saved) {
      setPlan(saved);
      setView("result");
    }
    setReady(true);
  }, []);

  useEffect(() => { if (ready) write(KEYS.request, request); }, [ready, request]);
  useEffect(() => { if (ready) write(KEYS.apiKey, apiKey); }, [ready, apiKey]);
  useEffect(() => { if (ready) write(KEYS.model, model); }, [ready, model]);
  useEffect(() => { if (ready) write(KEYS.overrides, overrides); }, [ready, overrides]);
  useEffect(() => { if (ready) write(KEYS.staples, assumeStaples); }, [ready, assumeStaples]);
  useEffect(() => { if (ready) write(KEYS.checked, checked); }, [ready, checked]);
  useEffect(() => { if (ready) write(KEYS.budgetMode, budgetMode); }, [ready, budgetMode]);
  useEffect(() => {
    if (!ready) return;
    if (importedCatalog) write(KEYS.catalog, importedCatalog);
    else remove(KEYS.catalog);
  }, [ready, importedCatalog]);

  /** Le catalogue effectif : la source choisie, corrigée des relevés magasin. */
  const catalog = useMemo(
    () => applyOverrides(importedCatalog ?? seedCatalog, overrides),
    [importedCatalog, overrides],
  );

  const generate = useCallback(async () => {
    setBusy(true);
    setError("");
    setProgress("Préparation…");

    try {
      const result = await generatePlan({
        request,
        catalog,
        gemini: apiKey.trim() ? { apiKey: apiKey.trim(), model } : undefined,
        assumeStaples,
        onProgress: setProgress,
      });

      setPlan(result);
      setChecked([]);
      write(KEYS.plan, result);
      setView("result");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Échec de la génération.");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }, [request, catalog, apiKey, model, assumeStaples]);

  const reset = () => {
    setPlan(null);
    setChecked([]);
    remove(KEYS.plan);
    setView("form");
  };

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-6">
      <header className="no-print mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Auchan-Opti</h1>
            <p className="mt-1 text-sm text-muted">
              Un budget, un nombre de repas, tes contraintes — une liste de courses
              chiffrée et les recettes qui vont avec.
            </p>
          </div>
          <Button
            variant={view === "settings" ? "primary" : "secondary"}
            onClick={() => setView(view === "settings" ? (plan ? "result" : "form") : "settings")}
          >
            {view === "settings" ? "Fermer" : "Réglages"}
          </Button>
        </div>

        {view !== "settings" && plan && (
          <nav className="mt-4 flex gap-2">
            <Button
              variant={view === "form" ? "primary" : "secondary"}
              onClick={() => setView("form")}
            >
              Modifier ma demande
            </Button>
            <Button
              variant={view === "result" ? "primary" : "secondary"}
              onClick={() => setView("result")}
            >
              Mon plan
            </Button>
          </nav>
        )}
      </header>

      {!ready ? (
        <p className="text-sm text-muted">Chargement…</p>
      ) : view === "settings" ? (
        <SettingsPanel
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          model={model}
          onModelChange={setModel}
          overrides={overrides}
          onOverridesChange={setOverrides}
          catalog={catalog}
          onCatalogChange={setImportedCatalog}
          assumeStaples={assumeStaples}
          onAssumeStaplesChange={setAssumeStaples}
        />
      ) : view === "result" && plan ? (
        <PlanResult
          plan={plan}
          checked={checked}
          onToggleChecked={(productId) =>
            setChecked((current) =>
              current.includes(productId)
                ? current.filter((id) => id !== productId)
                : [...current, productId],
            )
          }
          onReset={reset}
        />
      ) : (
        <div className="space-y-5">
          {error && (
            <Notice tone="warn" title="La génération a échoué">
              {error}
            </Notice>
          )}

          {!apiKey.trim() && (
            <Notice title="Mode hors-ligne actif">
              Sans clé Gemini, les repas sont composés par le planificateur local :
              corrects et chiffrés juste, mais peu variés.{" "}
              <button
                type="button"
                className="text-accent underline"
                onClick={() => setView("settings")}
              >
                Ajouter une clé
              </button>
              .
            </Notice>
          )}

          <PlanForm
            request={request}
            onChange={setRequest}
            onSubmit={generate}
            busy={busy}
            progress={progress}
            budgetMode={budgetMode}
            onBudgetModeChange={setBudgetMode}
          />
        </div>
      )}

      <footer className="no-print mt-10 border-t border-line pt-5 text-xs text-muted">
        <p>
          Les prix du catalogue sont des relevés indicatifs, pas les prix en direct de
          ton magasin : vérifie-les en rayon ou importe les tiens dans les réglages.
          Cette application n&apos;est pas affiliée à Auchan.
        </p>
      </footer>
    </div>
  );
}
