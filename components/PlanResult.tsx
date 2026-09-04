"use client";

import { useMemo, useState } from "react";
import type { MealPlan, ShoppingLine } from "@/lib/types";
import {
  formatPrice, isEstimate, packLabel, provenanceLabel, quantityLabel,
} from "@/lib/catalog";
import {
  costPerRecipe, costPerServing, leftoverValue, pantryStockValue,
} from "@/lib/planner/cost";
import { balanceComment } from "@/lib/planner/scoring";
import {
  copyToClipboard, download, planToMarkdown, shoppingListToCsv,
  shoppingListToDriveQueries, shoppingListToText,
} from "@/lib/export";
import { Button, Card, Notice, Stat } from "@/components/ui";

export function PlanResult({
  plan, checked, onToggleChecked, onReset,
}: {
  plan: MealPlan;
  checked: string[];
  onToggleChecked: (productId: string) => void;
  onReset: () => void;
}) {
  const [tab, setTab] = useState<"liste" | "recettes">("liste");
  const perRecipe = useMemo(() => costPerRecipe(plan.recipes, plan.shoppingList), [plan]);
  const waste = useMemo(() => leftoverValue(plan.shoppingList), [plan]);
  const provision = useMemo(() => pantryStockValue(plan.shoppingList), [plan]);

  const overBudget = plan.shoppingList.total > plan.request.budget;
  const remaining = plan.request.budget - plan.shoppingList.total;

  return (
    <div className="space-y-5">
      <Card
        title="Le résultat"
        subtitle={
          plan.provenance.engine === "gemini"
            ? `Recettes composées par ${plan.provenance.model}. Prix calculés localement.`
            : "Recettes composées hors-ligne. Ajoute une clé Gemini pour plus de variété."
        }
        action={
          <Button variant="ghost" onClick={onReset}>
            Recommencer
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Total"
            value={formatPrice(plan.shoppingList.total)}
            tone={overBudget ? "warn" : "good"}
            hint={
              overBudget
                ? `${formatPrice(-remaining)} au-dessus`
                : `${formatPrice(remaining)} restants`
            }
          />
          <Stat
            label="Par portion"
            value={formatPrice(costPerServing(plan))}
            hint={`${plan.recipes.length} repas`}
          />
          {/*
            « Conformité » et non « Équilibre » : le score mesure l'écart au
            profil demandé, pas la santé. Un plan à 1 000 kcal la portion peut
            être à 100 quand on a réglé le curseur sur plaisir — le libeller
            « équilibre » serait un mensonge, alors que la valeur est juste.
          */}
          <Stat
            label="Conformité"
            value={`${plan.nutrition.balanceScore}/100`}
            tone={plan.nutrition.balanceScore >= 65 ? "good" : "warn"}
            hint={`${plan.nutrition.kcalPerServing} kcal/portion`}
          />
          <Stat
            label="Gâchis"
            value={formatPrice(waste)}
            tone={waste > plan.shoppingList.total * 0.2 ? "warn" : "neutral"}
            hint={
              provision > 0
                ? `+ ${formatPrice(provision)} de provisions`
                : "frais acheté et non consommé"
            }
          />
        </div>

        <p className="mt-3 text-sm text-muted">
          {balanceComment(plan.nutrition.balanceScore, plan.request.indulgence)}{" "}
          Par portion : {plan.nutrition.proteinPerServing} g de protéines,{" "}
          {plan.nutrition.fiberPerServing} g de fibres, {plan.nutrition.saltPerServing} g de sel.
        </p>

        <PriceReliability plan={plan} />

        {plan.suggestions.length > 0 && (
          <div className="mt-4">
            <Notice title={`Il reste ${formatPrice(remaining)} de budget`}>
              <p className="mb-2">
                Le plan n&apos;épuise pas ce que tu voulais dépenser. De quoi ajouter,
                si l&apos;envie est là :
              </p>
              <ul className="flex flex-wrap gap-2">
                {plan.suggestions.map((product) => (
                  <li
                    key={product.id}
                    className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs"
                  >
                    {product.name} · {formatPrice(product.price)}
                  </li>
                ))}
              </ul>
            </Notice>
          </div>
        )}

        {(plan.warnings.length > 0 || plan.provenance.repairs.length > 0) && (
          <div className="mt-4 space-y-2">
            {plan.warnings.length > 0 && (
              <Notice tone="warn" title="À savoir">
                <ul className="list-disc space-y-1 pl-4">
                  {plan.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {plan.provenance.repairs.length > 0 && (
              <Notice title="Ajustements faits pour tenir le budget">
                <ul className="list-disc space-y-1 pl-4">
                  {plan.provenance.repairs.map((repair, i) => (
                    <li key={i}>{repair}</li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        )}
      </Card>

      <div className="no-print flex gap-2 rounded-2xl border border-line bg-surface p-1.5">
        {(["liste", "recettes"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            aria-pressed={tab === value}
            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
              tab === value ? "bg-accent text-white" : "text-muted hover:text-ink"
            }`}
          >
            {value === "liste"
              ? `Liste de courses (${plan.shoppingList.lines.filter((l) => l.packs > 0 && !l.prorated).length})`
              : `Recettes (${plan.recipes.length})`}
          </button>
        ))}
      </div>

      <div className={tab === "liste" ? "" : "hidden print:block"}>
        <ShoppingListView plan={plan} checked={checked} onToggle={onToggleChecked} />
      </div>
      <div className={tab === "recettes" ? "" : "hidden print:block"}>
        <RecipeListView plan={plan} costs={perRecipe} />
      </div>
    </div>
  );
}

function ShoppingListView({
  plan, checked, onToggle,
}: {
  plan: MealPlan;
  checked: string[];
  onToggle: (productId: string) => void;
}) {
  const checkedSet = new Set(checked);
  const buyable = plan.shoppingList.lines.filter((line) => line.packs > 0 && !line.prorated);
  const staples = plan.shoppingList.lines.filter((line) => line.prorated);
  const done = buyable.filter((line) => checkedSet.has(line.product.id)).length;
  const remainingCost = buyable
    .filter((line) => !checkedSet.has(line.product.id))
    .reduce((sum, line) => sum + line.cost, 0);

  const fromPantry = plan.shoppingList.lines.filter(
    (line) => line.packs === 0 && !line.prorated,
  );

  return (
    <div className="space-y-4">
      <Card
        title="Liste de courses"
        subtitle={`Triée dans l'ordre de parcours du magasin. ${done}/${buyable.length} pris — reste ${formatPrice(remainingCost)} à mettre au panier.`}
        action={<ExportMenu plan={plan} />}
      >
        <div className="space-y-5">
          {plan.shoppingList.byRayon.map((group) => {
            const lines = group.lines;
            if (lines.length === 0) return null;
            return (
              <div key={group.rayon} className="print-break">
                <h3 className="mb-2 flex items-baseline justify-between border-b border-line pb-1.5 text-sm font-bold uppercase tracking-wide">
                  <span>{group.rayon}</span>
                  <span className="tabular-nums text-muted">{formatPrice(group.subtotal)}</span>
                </h3>
                <ul>
                  {lines.map((line) => (
                    <ShoppingRow
                      key={line.product.id}
                      line={line}
                      checked={checkedSet.has(line.product.id)}
                      onToggle={() => onToggle(line.product.id)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Card>

      {staples.length > 0 && (
        <Card
          title="Fond de placard"
          subtitle="Compté au prorata dans le budget, pas au pot entier. Vérifie que tu en as avant de partir."
        >
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-muted sm:grid-cols-3">
            {staples.map((line) => (
              <li key={line.product.id}>
                {line.product.name} —{" "}
                {quantityLabel(line.neededQuantity, line.product.unit)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {fromPantry.length > 0 && (
        <Card
          title="Déjà chez toi"
          subtitle="Utilisé par les recettes, mais couvert par tes placards : rien à acheter."
        >
          <ul className="space-y-1 text-sm text-muted">
            {fromPantry.map((line) => (
              <li key={line.product.id}>
                {line.product.name} — {quantityLabel(line.neededQuantity, line.product.unit)} nécessaires
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ShoppingRow({
  line, checked, onToggle,
}: {
  line: ShoppingLine;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={checked}
        className="flex w-full items-start gap-3 rounded-xl px-1.5 py-2.5 text-left transition hover:bg-canvas"
      >
        <span
          aria-hidden
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 text-xs font-bold transition ${
            checked ? "border-good bg-good text-white" : "border-line"
          }`}
        >
          {checked ? "✓" : ""}
        </span>

        <span className="min-w-0 flex-1">
          <span className={`block font-medium ${checked ? "text-muted line-through" : ""}`}>
            {line.packs > 1 && <span className="text-accent">{line.packs} × </span>}
            {line.product.name}
          </span>
          <span className="block text-xs text-muted">
            <StockBadge line={line} />
            {packLabel(line.product)}
            {" · "}
            <span className={isEstimate(line.product) ? "italic" : "text-good"}>
              {provenanceLabel(line.product.priceFrom)}
            </span>
            {line.leftoverQuantity > 0 &&
              ` · reste ${quantityLabel(line.leftoverQuantity, line.product.unit)}`}
            {line.usedBy.length > 0 && ` · ${line.usedBy.join(", ")}`}
          </span>
        </span>

        <span className="shrink-0 tabular-nums text-sm font-semibold">
          {formatPrice(line.cost)}
        </span>
      </button>
    </li>
  );
}

/**
 * Pastille de disponibilité.
 *
 * « Inconnu » n'affiche rien : encombrer chaque ligne d'un badge gris pour
 * dire qu'on ne sait pas n'informe personne. Seul le constat mérite un signe.
 */
function StockBadge({ line }: { line: ShoppingLine }) {
  const { stock, stockFrom } = line.product;
  if (stock === "inconnu") return null;

  const style = {
    en_rayon: { text: "en rayon", className: "bg-good/15 text-good" },
    stock_faible: { text: "stock faible", className: "bg-warn/20 text-warn" },
    rupture: { text: "rupture", className: "bg-accent-soft text-accent" },
  }[stock];

  return (
    <span
      className={`mr-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style.className}`}
      title={stockFrom ? `Constaté : ${provenanceLabel(stockFrom)}` : undefined}
    >
      {style.text}
    </span>
  );
}

/**
 * Dit franchement sur quoi repose le total.
 *
 * Un budget calculé sur des prix estimés reste un ordre de grandeur. Le
 * masquer derrière un chiffre au centime près serait la pire des sorties :
 * l'utilisateur découvrirait l'écart en caisse.
 */
function PriceReliability({ plan }: { plan: MealPlan }) {
  const lignes = plan.shoppingList.lines.filter((l) => l.packs > 0);
  if (lignes.length === 0) return null;

  const reels = lignes.filter((l) => !isEstimate(l.product));
  const montantReel = reels.reduce((sum, l) => sum + l.cost, 0);
  const part = Math.round((montantReel / Math.max(0.01, plan.shoppingList.total)) * 100);

  if (part >= 90) {
    return (
      <div className="mt-4">
        <Notice title="Total fiable">
          {part} % du panier est chiffré sur des prix relevés dans ton magasin.
        </Notice>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <Notice tone="warn" title={part === 0 ? "Total indicatif" : `Total fiable à ${part} %`}>
        {part === 0
          ? "Aucun prix de ce panier n'a été relevé dans ton magasin : le total est un ordre de grandeur, pas un montant de caisse."
          : `${reels.length} produit(s) sur ${lignes.length} portent un prix relevé. Le reste est estimé.`}{" "}
        Le relevé se fait dans <strong>Réglages → Prix &amp; stock</strong>.
      </Notice>
    </div>
  );
}

function RecipeListView({
  plan, costs,
}: {
  plan: MealPlan;
  costs: Map<string, number>;
}) {
  return (
    <div className="space-y-4">
      {plan.recipes.map((recipe, index) => (
        <Card key={recipe.id} className="print-break">
          <div className="mb-3">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-lg font-bold">
                <span className="text-muted">{index + 1}. </span>
                {recipe.title}
              </h3>
              <span className="shrink-0 tabular-nums text-sm font-semibold text-accent">
                {formatPrice(costs.get(recipe.id) ?? 0)}
              </span>
            </div>
            {recipe.description && (
              <p className="mt-1 text-sm italic text-muted">{recipe.description}</p>
            )}
            <p className="mt-2 text-xs text-muted">
              {recipe.servings} pers. · {recipe.prepMinutes} min de préparation ·{" "}
              {recipe.cookMinutes} min de cuisson · niveau{" "}
              {["", "débutant", "à l'aise", "confirmé"][recipe.skill]}
              {recipe.equipment.length > 0 && ` · ${recipe.equipment.join(", ").replace(/_/g, " ")}`}
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <div>
              <h4 className="mb-2 text-sm font-bold uppercase tracking-wide">Ingrédients</h4>
              <ul className="space-y-1.5 text-sm">
                {recipe.ingredients.map((ingredient) => (
                  <li key={ingredient.productId} className="flex gap-2">
                    <span aria-hidden className="text-accent">•</span>
                    <span>
                      {ingredient.label}
                      {ingredient.optional && (
                        <span className="text-muted"> (facultatif)</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-bold uppercase tracking-wide">Préparation</h4>
              <ol className="space-y-2.5 text-sm">
                {recipe.steps.map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <span
                      aria-hidden
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent"
                    >
                      {i + 1}
                    </span>
                    <span className="pt-0.5">{step}</span>
                  </li>
                ))}
              </ol>

              {recipe.tips.length > 0 && (
                <div className="mt-4 rounded-xl bg-canvas px-3 py-2.5">
                  <h4 className="mb-1 text-xs font-bold uppercase tracking-wide">Astuces</h4>
                  <ul className="space-y-1 text-sm text-muted">
                    {recipe.tips.map((tip, i) => (
                      <li key={i}>{tip}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ExportMenu({ plan }: { plan: MealPlan }) {
  const [feedback, setFeedback] = useState("");

  const notify = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(""), 2500);
  };

  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <div className="no-print flex flex-wrap items-center justify-end gap-2">
      {feedback && <span className="text-xs text-good">{feedback}</span>}

      <Button
        variant="secondary"
        onClick={async () => {
          const ok = await copyToClipboard(shoppingListToDriveQueries(plan));
          notify(ok ? "Liste copiée" : "Copie refusée par le navigateur");
        }}
      >
        Copier pour le drive
      </Button>

      <Button
        variant="secondary"
        onClick={() => {
          download(`liste-courses-${stamp}.txt`, shoppingListToText(plan));
          notify("Fichier texte téléchargé");
        }}
      >
        Texte
      </Button>

      <Button
        variant="secondary"
        onClick={() => {
          download(`liste-courses-${stamp}.csv`, shoppingListToCsv(plan), "text/csv;charset=utf-8");
          notify("CSV téléchargé");
        }}
      >
        CSV
      </Button>

      <Button
        variant="secondary"
        onClick={() => {
          download(`plan-repas-${stamp}.md`, planToMarkdown(plan), "text/markdown;charset=utf-8");
          notify("Plan complet téléchargé");
        }}
      >
        Markdown
      </Button>

      <Button variant="secondary" onClick={() => window.print()}>
        Imprimer / PDF
      </Button>
    </div>
  );
}
