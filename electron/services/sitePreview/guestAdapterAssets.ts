/**
 * Where a built-in plugin's declared guest runtime lands, and how to find every
 * declaration.
 *
 * One module because two very different callers must agree on the answer:
 * `scripts/build-main.mjs` bundles the asset to this path at build time, and
 * `registerBuiltinGuestAdapters` reads it back from this path at startup. The
 * path is DERIVED from the adapter id rather than declared in the manifest,
 * precisely so there is no second place for the two to disagree.
 *
 * Deliberately dependency-light — `node:fs`/`node:path` only. It is read on the
 * startup path, and importing `electron/schemas/plugin.ts` for its zod schema
 * would drag ~100 module-eval schemas plus semver into the eager main graph
 * (the same reason `electron/schemas/pluginIdentifiers.ts` exists). The
 * structural rules below therefore restate the schema's, and
 * `__tests__/guestAdapterAssets.test.ts` pins the two together.
 */

import fs from "node:fs";
import path from "node:path";

/** Subdirectory of the plugin's output tree that holds its guest bundles. */
export const GUEST_ASSET_DIR = "guest";

export interface BuiltinGuestAdapterDeclaration {
  /** Manifest name, which is also the plugin id for a built-in. */
  pluginId: string;
  /** Directory name under the plugins root — not necessarily the manifest name. */
  dirName: string;
  /** The adapter id the renderer binds with, exactly as declared. */
  adapterId: string;
  /** Plugin-relative POSIX path to the bundle's source entry. */
  entry: string;
  /** Plugin-relative POSIX path to the built bundle, derived from `adapterId`. */
  assetPath: string;
}

/**
 * Mirrors `isSafeGuestEntryPath` in `electron/schemas/plugin.ts`. A manifest
 * that reached either caller has already been validated by that schema, so this
 * is a second gate rather than the first: the build joins `entry` onto a plugin
 * directory and hands it to a bundler, and a `..` segment there would bundle a
 * sibling plugin's source into a first-party asset.
 *
 * `GUEST_ASSET_DIR` is refused as the first segment because that is where the
 * bundler writes: the plugin asset copy runs after the bundle is emitted, so a
 * source file there would be copied over the compiled asset this module then
 * reads back as the adapter's body.
 */
export function isSafeGuestEntryPath(value: string): boolean {
  if (value.includes("\\") || value.includes("\0")) return false;
  // A colon is a drive or stream separator on Windows, where `C:/x.ts` and
  // `a:b.ts` are not the relative paths `path.isAbsolute` calls them on POSIX.
  // Rejected on every platform so one manifest cannot mean two things.
  if (value.includes(":")) return false;
  if (value.startsWith("/") || path.isAbsolute(value)) return false;
  if (!/\.(ts|tsx|js|mjs)$/.test(value)) return false;
  const segments = value.split("/");
  if (segments[0] === GUEST_ASSET_DIR) return false;
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The plugin-relative path of the bundle backing `adapterId`, or `null` when the
 * id is not one this derivation can name a file for.
 *
 * The id is `<plugin name>.<segment>` — exactly one segment past the plugin's
 * own name (the manifest schema enforces it), and that segment IS the filename.
 * A multi-segment suffix is refused rather than flattened: mapping dots to
 * dashes would give `<plugin>.a.b` and `<plugin>.a-b` the same asset, so the
 * build would emit one bundle over the other and one of the two adapters would
 * silently serve the wrong body.
 *
 * `null` also covers an id equal to the plugin name, or one prefixed with
 * another plugin's, so a caller reading a manifest off disk skips the entry
 * instead of writing outside the plugin's own output tree.
 */
export function guestAdapterAssetPath(pluginName: string, adapterId: string): string | null {
  if (!adapterId.startsWith(`${pluginName}.`)) return null;
  const suffix = adapterId.slice(pluginName.length + 1);
  // The suffix comes from a validated qualified id, so this only ever holds one
  // run of lower-case alphanumerics and dashes; assert it anyway, because the
  // value becomes a filename.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suffix)) return null;
  return `${GUEST_ASSET_DIR}/${suffix}.js`;
}

interface RawDeclaration {
  id?: unknown;
  entry?: unknown;
}

/**
 * Every guest adapter declared by a manifest under `pluginsRoot`, in directory
 * order.
 *
 * Tolerant of a missing, unparseable or oddly-shaped manifest: the dedicated
 * manifest validation (`scripts/validate-plugin-manifests.ts` at build time,
 * `PluginService.loadPlugin` at runtime) is what reports those loudly, and this
 * runs on both the source tree and the built output where an invalid manifest
 * has already been rejected once. An entry that fails a structural rule is
 * skipped rather than repaired.
 */
export function listBuiltinGuestAdapters(pluginsRoot: string): BuiltinGuestAdapterDeclaration[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const declarations: BuiltinGuestAdapterDeclaration[] = [];
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = path.join(pluginsRoot, dirent.name, "plugin.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    // `JSON.parse("null")` succeeds, and a bare scalar parses too, so the shape
    // is checked outside the catch — dereferencing either would throw a
    // TypeError out of this function and take the whole handler registration
    // down, instead of skipping the manifest as documented.
    if (typeof parsed !== "object" || parsed === null) continue;
    const manifest = parsed as { name?: unknown; contributes?: unknown };
    const pluginId = manifest.name;
    const contributes = manifest.contributes;
    const declared =
      typeof contributes === "object" && contributes !== null
        ? (contributes as { guestAdapters?: unknown }).guestAdapters
        : undefined;
    if (typeof pluginId !== "string" || pluginId === "" || !Array.isArray(declared)) continue;

    for (const raw of declared as RawDeclaration[]) {
      const adapterId = raw?.id;
      const entry = raw?.entry;
      if (typeof adapterId !== "string" || typeof entry !== "string") continue;
      if (!isSafeGuestEntryPath(entry)) continue;
      const assetPath = guestAdapterAssetPath(pluginId, adapterId);
      if (assetPath === null) continue;
      declarations.push({ pluginId, dirName: dirent.name, adapterId, entry, assetPath });
    }
  }
  return declarations;
}
