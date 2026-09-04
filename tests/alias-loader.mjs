/**
 * Résout les imports « @/… » vers la racine du projet pour les tests.
 * Next.js le fait via tsconfig ; le runner natif de Node a besoin d'un hook.
 */
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const base = join(ROOT, specifier.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.json`, join(base, "index.ts"), base]) {
    if (!isFile(candidate)) continue;
    const url = pathToFileURL(candidate).href;
    // Next.js importe le JSON sans attribut ; le runner de Node l'exige.
    if (candidate.endsWith(".json")) {
      return { url, format: "json", importAttributes: { type: "json" }, shortCircuit: true };
    }
    return nextResolve(url, context);
  }
  return nextResolve(specifier, context);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
