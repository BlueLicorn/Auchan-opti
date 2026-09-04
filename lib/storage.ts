"use client";

import type { Catalog, MealPlan, PlanRequest } from "@/lib/types";
import type { StoreOverride } from "@/lib/catalog";

/**
 * Persistance locale.
 *
 * Tout reste dans le navigateur : la clé Gemini, les prix relevés en magasin,
 * le dernier plan. Aucune donnée ne part vers un serveur, ce qui est le seul
 * moyen honnête de promettre que la clé API n'est pas exposée.
 */

const PREFIX = "auchan-opti:";

export const KEYS = {
  apiKey: `${PREFIX}gemini-key`,
  model: `${PREFIX}gemini-model`,
  request: `${PREFIX}request`,
  plan: `${PREFIX}plan`,
  overrides: `${PREFIX}store-overrides`,
  checked: `${PREFIX}checked`,
  catalog: `${PREFIX}catalog`,
  budgetMode: `${PREFIX}budget-mode`,
  staples: `${PREFIX}assume-staples`,
  planVersion: `${PREFIX}plan-version`,
} as const;

/**
 * Version des règles de composition et de chiffrage.
 *
 * Le dernier plan est conservé pour survivre à un rechargement — c'est une
 * liste de courses, on l'ouvre en magasin. Mais il était réaffiché tel quel
 * après une mise à jour, y compris quand il portait un défaut que la nouvelle
 * version corrige : « 50 × Salade batavia » restait à l'écran alors que
 * l'application ne le produisait plus. À incrémenter dès qu'un plan déjà
 * enregistré peut être faux au regard des règles actuelles.
 */
export const PLAN_VERSION = 2;

export function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Stockage indisponible (navigation privée, quota) : on continue sans.
    return fallback;
  }
}

export function write(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* silencieux : perdre une préférence ne doit pas casser l'application */
  }
}

export function remove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* idem */
  }
}

export const DEFAULT_REQUEST: PlanRequest = {
  budget: 60,
  meals: 5,
  servingsPerMeal: 2,
  skill: 2,
  indulgence: 35,
  equipment: ["four", "plaques", "poele", "micro_ondes"],
  diet: [],
  exclusions: [],
  maxPrepMinutes: 60,
  pantry: [],
  verifiedOnly: false,
};

export function loadRequest(): PlanRequest {
  const stored = read<Partial<PlanRequest>>(KEYS.request, {});
  return { ...DEFAULT_REQUEST, ...stored, pantry: stored.pantry ?? [] };
}

export function loadOverrides(): StoreOverride[] {
  return read<StoreOverride[]>(KEYS.overrides, []);
}

export interface StoredPlan {
  plan: MealPlan;
  /** Le plan a-t-il été composé par la version en cours ? */
  current: boolean;
}

export function loadPlan(): StoredPlan | null {
  const plan = read<MealPlan | null>(KEYS.plan, null);
  if (!plan) return null;
  return { plan, current: read<number>(KEYS.planVersion, 0) === PLAN_VERSION };
}

export function savePlan(plan: MealPlan): void {
  write(KEYS.plan, plan);
  write(KEYS.planVersion, PLAN_VERSION);
}

/**
 * Catalogue personnalisé (import CSV ou relevé en magasin).
 *
 * Il représente un vrai travail de l'utilisateur — parfois une heure de
 * relevé — et doit survivre à un rechargement de page. On vérifie sa forme
 * avant de le rendre : un stockage corrompu ne doit pas casser l'application.
 */
export function loadCatalog(): Catalog | null {
  const stored = read<Catalog | null>(KEYS.catalog, null);
  if (!stored || !Array.isArray(stored.products) || stored.products.length === 0) {
    return null;
  }
  return stored;
}
