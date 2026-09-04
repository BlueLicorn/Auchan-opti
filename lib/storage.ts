"use client";

import type { MealPlan, PlanRequest } from "@/lib/types";
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
  staples: `${PREFIX}assume-staples`,
} as const;

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
};

export function loadRequest(): PlanRequest {
  const stored = read<Partial<PlanRequest>>(KEYS.request, {});
  return { ...DEFAULT_REQUEST, ...stored, pantry: stored.pantry ?? [] };
}

export function loadOverrides(): StoreOverride[] {
  return read<StoreOverride[]>(KEYS.overrides, []);
}

export function loadPlan(): MealPlan | null {
  return read<MealPlan | null>(KEYS.plan, null);
}
