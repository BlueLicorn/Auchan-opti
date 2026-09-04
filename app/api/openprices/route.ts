import { NextResponse } from "next/server";
import { OPEN_PRICES_API } from "@/lib/catalog/openprices";

/**
 * Relais vers l'API Open Prices.
 *
 * Trois raisons de passer par le serveur plutôt que d'appeler depuis le
 * navigateur :
 *  1. on ne dépend pas de la politique CORS d'un service tiers ;
 *  2. Open Food Facts demande un User-Agent identifiant ses consommateurs,
 *     ce qu'un navigateur ne laisse pas définir ;
 *  3. les réponses sont mises en cache, pour ne pas marteler un service
 *     associatif à chaque frappe dans un champ de recherche.
 *
 * Aucune donnée personnelle ne transite ici : ni la clé Gemini, qui reste
 * strictement dans le navigateur, ni le contenu des listes de courses.
 */

const USER_AGENT = "Auchan-Opti/1.0 (outil personnel de liste de courses)";
const TIMEOUT_MS = 12_000;

/** Paramètres autorisés par action. Tout le reste est ignoré. */
const ALLOWED: Record<string, readonly string[]> = {
  locations: ["osm_name__like", "size", "page"],
  prices: ["location_osm_id", "location_osm_type", "product_code", "size", "page", "order_by"],
};

export const revalidate = 900;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") ?? "";

  const allowed = ALLOWED[action];
  if (!allowed) {
    return NextResponse.json(
      { error: "Action inconnue. Utilise « locations » ou « prices »." },
      { status: 400 },
    );
  }

  // On reconstruit la requête à partir d'une liste blanche : l'URL amont
  // n'est jamais influencée par autre chose que des paramètres attendus.
  const upstream = new URL(`${OPEN_PRICES_API}/${action}`);
  for (const key of allowed) {
    const value = searchParams.get(key);
    if (value !== null && value.length <= 120) upstream.searchParams.set(key, value);
  }

  try {
    const response = await fetch(upstream, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: messageForStatus(response.status) },
        { status: response.status === 404 ? 404 : 502 },
      );
    }

    return NextResponse.json(await response.json(), {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=900" },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut
          ? "Open Prices n'a pas répondu à temps. Réessaie dans un moment."
          : "Open Prices est injoignable depuis ce serveur.",
      },
      { status: 504 },
    );
  }
}

function messageForStatus(status: number): string {
  if (status === 404) return "Rien trouvé pour cette recherche.";
  if (status === 422) return "Recherche refusée par Open Prices : affine les termes.";
  if (status === 429) return "Trop de requêtes vers Open Prices. Patiente une minute.";
  return `Open Prices a répondu ${status}.`;
}
