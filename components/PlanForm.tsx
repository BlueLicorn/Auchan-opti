"use client";

import { useMemo } from "react";
import type { DietTag, Equipment, PlanRequest, SkillLevel } from "@/lib/types";
import { formatPrice } from "@/lib/catalog";
import {
  Button, Card, ChipGroup, Field, NumberInput, SegmentGroup, Slider, TextInput,
} from "@/components/ui";

const EQUIPMENT_OPTIONS: { value: Equipment; label: string }[] = [
  { value: "plaques", label: "Plaques" },
  { value: "poele", label: "Poêle" },
  { value: "four", label: "Four" },
  { value: "cocotte", label: "Cocotte" },
  { value: "micro_ondes", label: "Micro-ondes" },
  { value: "mixeur", label: "Mixeur" },
  { value: "robot", label: "Robot" },
  { value: "airfryer", label: "Air fryer" },
  { value: "autocuiseur", label: "Autocuiseur" },
  { value: "barbecue", label: "Barbecue" },
];

const DIET_OPTIONS: { value: DietTag; label: string }[] = [
  { value: "vegetarien", label: "Végétarien" },
  { value: "vegan", label: "Vegan" },
  { value: "sans_porc", label: "Sans porc" },
  { value: "sans_gluten", label: "Sans gluten" },
  { value: "sans_lactose", label: "Sans lactose" },
  { value: "sans_fruits_a_coque", label: "Sans fruits à coque" },
  { value: "halal_compatible", label: "Halal compatible" },
];

const INDULGENCE_MARKS = [
  { at: 0, label: "Équilibré" },
  { at: 50, label: "Gourmand" },
  { at: 100, label: "Gros porc" },
];

/**
 * Deux façons de dire la même chose.
 *
 * Le moteur ne connaît qu'un budget total, mais on ne raisonne pas toujours
 * ainsi : « 8 € le repas » est souvent plus naturel que « 240 € le mois ».
 * Le mode ne change que la saisie ; la valeur transmise reste le total.
 */
export type BudgetMode = "total" | "parRepas";

export function PlanForm({
  request, onChange, onSubmit, busy, progress, budgetMode, onBudgetModeChange,
}: {
  request: PlanRequest;
  onChange: (next: PlanRequest) => void;
  onSubmit: () => void;
  busy: boolean;
  progress?: string;
  budgetMode: BudgetMode;
  onBudgetModeChange: (mode: BudgetMode) => void;
}) {
  const set = <K extends keyof PlanRequest>(key: K, value: PlanRequest[K]) =>
    onChange({ ...request, [key]: value });

  const round2 = (n: number) => Math.round(n * 100) / 100;

  /** Coût par repas déduit du total. Le total reste la source de vérité. */
  const parRepas = request.meals > 0 ? round2(request.budget / request.meals) : 0;

  /** Changer le nombre de repas conserve le coût unitaire, pas le total. */
  const setMeals = (meals: number) => {
    if (budgetMode === "parRepas" && meals > 0) {
      onChange({ ...request, meals, budget: round2(parRepas * meals) });
    } else {
      set("meals", meals);
    }
  };

  const toggle = <T extends string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const servings = request.meals * request.servingsPerMeal;
  const perServing = useMemo(
    () => (servings > 0 ? request.budget / servings : 0),
    [request.budget, servings],
  );

  /**
   * Diagnostic avant génération.
   *
   * Le seuil de faisabilité dépend du nombre de portions, pas seulement du
   * prix : on achète des paquets entiers, si bien que 1 € la portion est
   * atteignable pour une famille et hors de portée pour cinq repas solo.
   */
  const plancher = servings >= 16 ? 1.0 : servings >= 10 ? 1.3 : servings >= 6 ? 1.8 : 2.3;
  const diagnostic = perServing <= 0
    ? null
    : perServing < plancher
      ? "impossible"
      : perServing < plancher * 1.5
        ? "serre"
        : perServing > 12
          ? "large"
          : "normal";

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Card title="Le cadre" subtitle="Ce que tu veux dépenser, et pour combien de repas.">
        <div className="mb-4">
          <SegmentGroup<BudgetMode>
            value={budgetMode}
            onChange={onBudgetModeChange}
            options={[
              { value: "total", label: "Budget total", hint: "pour l'ensemble" },
              { value: "parRepas", label: "Coût par repas", hint: "×  nb de repas" },
            ]}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {budgetMode === "total" ? (
            <Field label="Budget total">
              <NumberInput
                value={request.budget}
                onChange={(v) => set("budget", v)}
                min={5}
                max={5000}
                step={5}
                suffix="€"
              />
            </Field>
          ) : (
            <Field label="Coût par repas">
              <NumberInput
                value={parRepas}
                onChange={(v) => onChange({ ...request, budget: round2(v * request.meals) })}
                min={0.5}
                max={200}
                step={0.5}
                suffix="€"
              />
            </Field>
          )}
          <Field label="Repas">
            <NumberInput
              value={request.meals}
              onChange={setMeals}
              min={1}
              max={60}
            />
          </Field>
          <Field label="Couverts par repas">
            <NumberInput
              value={request.servingsPerMeal}
              onChange={(v) => set("servingsPerMeal", v)}
              min={1}
              max={12}
            />
          </Field>
        </div>

        <p
          className={`mt-3 text-sm ${
            diagnostic === "impossible" ? "text-warn" : "text-muted"
          }`}
        >
          {budgetMode === "parRepas" ? (
            <>
              <strong>{formatPrice(request.budget)} au total</strong> pour{" "}
              {request.meals} repas, soit {formatPrice(perServing)} par portion
              ({servings} portion{servings > 1 ? "s" : ""}).{" "}
            </>
          ) : (
            <>
              <strong>{formatPrice(perServing)} par portion</strong> pour{" "}
              {servings} portion{servings > 1 ? "s" : ""}.{" "}
            </>
          )}
          {diagnostic === "impossible" && (
            <>
              Ce budget ne passera pas : avec {servings} portion
              {servings > 1 ? "s" : ""}, on paie des paquets entiers même en
              n&apos;en utilisant qu&apos;une part, et le minimum réaliste tourne
              autour de {formatPrice(plancher)} par portion. Augmente le budget,
              ou cuisine plus de couverts par repas — c&apos;est ce qui fait le
              plus baisser le prix unitaire.
            </>
          )}
          {diagnostic === "serre" &&
            "C'est serré : attends-toi à des pâtes, des légumineuses et des œufs, avec peu de viande."}
          {diagnostic === "normal" && "Cohérent pour de la cuisine maison."}
          {diagnostic === "large" && "Large : il y aura de quoi se faire plaisir."}
        </p>
      </Card>

      <Card
        title="L'envie"
        subtitle="Le curseur déplace vraiment les repères nutritionnels, il ne maquille pas le résultat."
      >
        <Field label={`Équilibre ou plaisir — ${request.indulgence}/100`}>
          <Slider
            value={request.indulgence}
            onChange={(v) => set("indulgence", v)}
            marks={INDULGENCE_MARKS}
          />
        </Field>

        <p className="mt-2 rounded-xl bg-canvas px-3 py-2 text-sm text-muted">
          {describeIndulgence(request.indulgence)}
        </p>
      </Card>

      <Card title="La cuisine" subtitle="Ce que tu sais faire et avec quoi.">
        <div className="space-y-4">
          <Field label="Niveau">
            <SegmentGroup<SkillLevel>
              value={request.skill}
              onChange={(v) => set("skill", v)}
              options={[
                { value: 1, label: "Débutant", hint: "Recettes simples" },
                { value: 2, label: "À l'aise", hint: "Sauces, cuissons" },
                { value: 3, label: "Confirmé", hint: "Tout est permis" },
              ]}
            />
          </Field>

          <Field
            label="Équipement disponible"
            hint="Une recette ne proposera jamais un four que tu n'as pas coché."
          >
            <ChipGroup
              options={EQUIPMENT_OPTIONS}
              selected={request.equipment}
              onToggle={(v) => set("equipment", toggle(request.equipment, v))}
              columns={2}
            />
          </Field>

          <Field label="Temps maximum par repas">
            <NumberInput
              value={request.maxPrepMinutes}
              onChange={(v) => set("maxPrepMinutes", v)}
              min={10}
              max={240}
              step={5}
              suffix="min"
            />
          </Field>
        </div>
      </Card>

      <Card title="Les contraintes" subtitle="Régimes et interdits absolus.">
        <div className="space-y-4">
          <Field label="Régimes">
            <ChipGroup
              options={DIET_OPTIONS}
              selected={request.diet}
              onToggle={(v) => set("diet", toggle(request.diet, v))}
              columns={2}
            />
          </Field>

          <Field
            label="Ingrédients à bannir"
            hint="Séparés par des virgules. Une recette qui en contient est rejetée, pas rafistolée."
          >
            <TextInput
              value={request.exclusions.join(", ")}
              placeholder="coriandre, fruits de mer, olives"
              onChange={(value) =>
                set(
                  "exclusions",
                  value.split(",").map((v) => v.trim()).filter(Boolean),
                )
              }
            />
          </Field>
        </div>
      </Card>

      <div className="sticky bottom-4 z-10 no-print">
        <Button type="submit" full disabled={busy || request.equipment.length === 0}>
          {busy ? (progress ?? "Génération en cours…") : "Générer mes repas et ma liste"}
        </Button>
        {request.equipment.length === 0 && (
          <p className="mt-2 text-center text-xs text-warn">
            Coche au moins un équipement de cuisson.
          </p>
        )}
      </div>
    </form>
  );
}

function describeIndulgence(value: number): string {
  if (value <= 20) return "Légumes à tous les repas, protéines maigres, matières grasses mesurées.";
  if (value <= 45) return "Équilibré dans l'ensemble, avec une vraie gourmandise par repas.";
  if (value <= 70) return "Cuisine généreuse : gratins, mijotés, sauces montées, fromage fondu.";
  return "Plaisir assumé : portions copieuses, gras, fromage, viandes marbrées. Aucun compromis diététique.";
}
