/**
 * Client Gemini minimal, exécuté dans le navigateur.
 *
 * La clé API appartient à l'utilisateur et ne quitte jamais sa machine : les
 * requêtes partent du navigateur vers Google directement, sans passer par le
 * serveur Next.js. C'est le seul montage où l'on peut affirmer honnêtement que
 * personne d'autre ne voit la clé.
 */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiError extends Error {
  // Champs déclarés puis assignés, plutôt que des propriétés de constructeur :
  // celles-ci ne sont pas du JavaScript et empêchent d'exécuter ce module
  // — et tout ce qui l'importe — avec le runner de tests natif de Node.
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface GeminiModel {
  id: string;
  label: string;
  /** Fenêtre de contexte annoncée, utile pour jauger la taille du catalogue. */
  inputTokenLimit?: number;
}

/** Modèles proposés tant que la liste n'a pas été récupérée avec la clé. */
export const FALLBACK_MODELS: GeminiModel[] = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — rapide et économique" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — plus fin, plus lent" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
];

/**
 * Liste les modèles réellement accessibles avec cette clé. Utile parce que
 * les modèles disponibles changent, et qu'un nom codé en dur finit toujours
 * par renvoyer un 404 quelques mois plus tard.
 */
export async function listModels(apiKey: string): Promise<GeminiModel[]> {
  const response = await fetch(`${API_ROOT}/models?pageSize=100`, {
    headers: { "x-goog-api-key": apiKey },
  });

  if (!response.ok) throw await toError(response);

  const data = (await response.json()) as {
    models?: {
      name: string;
      displayName?: string;
      description?: string;
      inputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }[];
  };

  const models = (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({
      id: m.name.replace(/^models\//, ""),
      label: m.displayName ?? m.name.replace(/^models\//, ""),
      inputTokenLimit: m.inputTokenLimit,
    }))
    // Les variantes datées et expérimentales polluent la liste sans rien
    // apporter à l'utilisateur ; on garde les alias stables.
    .filter((m) => !/-\d{3,4}$|vision|embedding|aqa|tts|image|live/.test(m.id));

  return models.length > 0 ? models : FALLBACK_MODELS;
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  prompt: string;
  /** Schéma OpenAPI restreint imposé à la réponse. */
  responseSchema: unknown;
  temperature?: number;
  signal?: AbortSignal;
}

/** Appelle le modèle et renvoie l'objet JSON validé par le schéma. */
export async function generateJson<T>(options: GenerateOptions): Promise<T> {
  const response = await fetch(
    `${API_ROOT}/models/${encodeURIComponent(options.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      signal: options.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: options.responseSchema,
          temperature: options.temperature ?? 0.8,
          // Pas de maxOutputTokens : chaque modèle a le sien, et une valeur
          // codée en dur au-dessus de sa capacité fait refuser la requête —
          // Gemini 2.0 Flash plafonne à 8 192 jetons là où 2.5 Flash en
          // accepte huit fois plus. Sans la consigne, le modèle utilise son
          // propre maximum.
        },
      }),
    },
  );

  if (!response.ok) throw await toError(response);

  const data = (await response.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      finishReason?: string;
    }[];
    promptFeedback?: { blockReason?: string };
  };

  if (data.promptFeedback?.blockReason) {
    throw new GeminiError(
      `Requête refusée par Gemini (${data.promptFeedback.blockReason}).`,
    );
  }

  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new GeminiError(
      "Réponse tronquée : demande moins de repas à la fois, ou choisis un modèle avec une sortie plus longue.",
      undefined,
      true,
    );
  }

  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw new GeminiError("Gemini a renvoyé une réponse vide.", undefined, true);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // Certains modèles encadrent malgré tout le JSON ; on récupère le bloc.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as T;
    throw new GeminiError("Réponse Gemini illisible (JSON invalide).", undefined, true);
  }
}

/** Traduit les erreurs HTTP de l'API en messages actionnables. */
async function toError(response: Response): Promise<GeminiError> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    /* corps non JSON : le statut suffit */
  }

  switch (response.status) {
    case 400:
      return new GeminiError(
        detail.toLowerCase().includes("api key")
          ? "Clé API invalide. Vérifie-la sur aistudio.google.com/apikey."
          : `Requête refusée par Gemini : ${detail || "paramètre invalide"}.`,
        400,
      );
    case 401:
    case 403:
      return new GeminiError(
        "Clé API refusée. Vérifie qu'elle est active et autorisée pour l'API Generative Language.",
        response.status,
      );
    case 404:
      return new GeminiError(
        "Ce modèle n'existe pas ou n'est pas accessible avec ta clé. Choisis-en un autre dans la liste.",
        404,
      );
    case 429:
      return new GeminiError(
        "Quota Gemini atteint. Attends une minute, ou passe sur un modèle Flash.",
        429,
        true,
      );
    case 500:
    case 502:
    case 503:
      return new GeminiError(
        "Gemini est momentanément indisponible. Réessaie dans quelques secondes.",
        response.status,
        true,
      );
    default:
      return new GeminiError(
        `Erreur Gemini ${response.status}${detail ? ` : ${detail}` : ""}.`,
        response.status,
      );
  }
}

/** Réessaie une opération sur les erreurs transitoires, avec attente croissante. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof GeminiError && error.retryable;
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
    }
  }
  throw lastError;
}
