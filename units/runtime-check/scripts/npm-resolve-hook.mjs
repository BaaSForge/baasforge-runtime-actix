import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeCheckRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const projectRequire = createRequire(join(runtimeCheckRoot, "package.json"));

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("#")
  ) {
    return nextResolve(specifier, context);
  }
  try {
    let resolved;
    try {
      resolved = projectRequire.resolve(specifier);
    } catch {
      resolved = projectRequire.resolve(`${specifier}.js`);
    }
    return { url: pathToFileURL(resolved).href, shortCircuit: true };
  } catch {
    return nextResolve(specifier, context);
  }
}
