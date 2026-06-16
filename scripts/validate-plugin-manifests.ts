import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPluginManifestSchema } from "../electron/schemas/plugin.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PluginRoot {
  dir: string;
  isBuiltin: boolean;
}

interface ManifestError {
  file: string;
  message: string;
}

/**
 * Validate every `<root>/<name>/plugin.json` under each plugin root against the
 * runtime manifest schema. A directory without a `plugin.json` is skipped (a
 * manifest-only or main-only dir is valid); absent roots are skipped (mirrors
 * the build's copy steps). Returns every failure so the caller can report them
 * all at once rather than stopping at the first.
 */
export function validatePluginManifests(roots: PluginRoot[]): ManifestError[] {
  const errors: ManifestError[] = [];
  for (const { dir, isBuiltin } of roots) {
    if (!fs.existsSync(dir)) continue;
    const schema = getPluginManifestSchema(isBuiltin);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, "plugin.json");
      if (!fs.existsSync(manifestPath)) continue;

      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (err) {
        errors.push({ file: manifestPath, message: `Invalid JSON: ${(err as Error).message}` });
        continue;
      }

      const result = schema.safeParse(json);
      if (!result.success) {
        const issues = result.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n");
        errors.push({ file: manifestPath, message: issues });
      }
    }
  }
  return errors;
}

/**
 * Built-in plugins load with `isBuiltin: true`, and sample plugins are
 * sideloaded at runtime with `isBuiltin: true` too (PluginService.loadFromDir at
 * the sideload root) so their `daintree.*` names pass the namespace guard.
 * Validate both with the same flag the runtime uses.
 */
function defaultRoots(base: string): PluginRoot[] {
  return [
    { dir: path.join(base, "builtin"), isBuiltin: true },
    { dir: path.join(base, "sample"), isBuiltin: true },
  ];
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isInvokedDirectly()) {
  // `DAINTREE_PLUGIN_MANIFEST_BASE` overrides the plugin root for tests; defaults
  // to the repo's `plugins/` directory.
  const base = process.env.DAINTREE_PLUGIN_MANIFEST_BASE
    ? path.resolve(process.env.DAINTREE_PLUGIN_MANIFEST_BASE)
    : path.join(repoRoot, "plugins");

  const errors = validatePluginManifests(defaultRoots(base));
  if (errors.length > 0) {
    console.error(`[plugin-manifests] ${errors.length} invalid manifest(s):`);
    for (const err of errors) {
      console.error(`\n${path.relative(repoRoot, err.file)}:\n${err.message}`);
    }
    process.exit(1);
  }
  console.log("[plugin-manifests] all manifests valid");
}
