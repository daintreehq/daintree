/**
 * The core Element Picker's guest asset catalog: a fixed list the app builds,
 * never anything a plugin manifest or a page names.
 *
 * `scripts/build-main.mjs` bundles each entry to `dist-electron/<CORE_GUEST_ASSET_DIR>/<file>`
 * (its `CORE_PICKER_GUEST_ASSETS` restates this list, and
 * `__tests__/guestAssets.test.ts` pins the two together), and the loader below
 * reads them back on demand. A page can only name a framework from the shared
 * enum; whether that unlocks anything is this table's answer, so a framework
 * the app has no extractor for yet stays detected and uninstalled.
 */

import { app } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ElementPickerFramework } from "../../../shared/elementPicker/source.js";
import { AppError } from "../../utils/errorTypes.js";

/** Under `dist-electron/`. */
export const CORE_GUEST_ASSET_DIR = "element-picker/guest";

export type CoreGuestAssetId = "bootstrap" | "probe" | `extractor:${ElementPickerFramework}`;

export const CORE_GUEST_ASSET_FILES: Readonly<Partial<Record<CoreGuestAssetId, string>>> = {
  bootstrap: "bootstrap.js",
  probe: "probe.js",
  "extractor:svelte": "extractors/svelte.js",
  "extractor:react": "extractors/react.js",
};

/** Same ceiling as a plugin guest adapter's body. */
export const MAX_CORE_GUEST_ASSET_BYTES = 512 * 1024;

export function extractorAssetId(framework: ElementPickerFramework): CoreGuestAssetId {
  return `extractor:${framework}`;
}

/** Resolves to null for an asset the catalog does not list; throws when a listed one cannot be read. */
export type CoreGuestAssetLoader = (id: CoreGuestAssetId) => Promise<string | null>;

export interface CoreGuestAssetLoaderOptions {
  /** The directory holding the built assets, or null when it cannot be resolved. */
  root: () => string | null;
  /** Whether a read may be kept: true for a packaged build, false while a watcher can rewrite the file. */
  cache: boolean;
  read?: (file: string) => Promise<string>;
  files?: Readonly<Partial<Record<CoreGuestAssetId, string>>>;
}

export function createCoreGuestAssetLoader(
  options: CoreGuestAssetLoaderOptions
): CoreGuestAssetLoader {
  const read = options.read ?? ((file: string) => readFile(file, "utf8"));
  const files = options.files ?? CORE_GUEST_ASSET_FILES;
  const cached = new Map<CoreGuestAssetId, string>();
  // Shared by concurrent installs — two bindings detecting the same framework
  // at once read the file once — and dropped as soon as it settles, so a failed
  // read is retried by the next install rather than remembered.
  const inflight = new Map<CoreGuestAssetId, Promise<string>>();

  async function load(id: CoreGuestAssetId, file: string): Promise<string> {
    const root = options.root();
    if (root === null) {
      throw new AppError({
        code: "INTERNAL",
        message: "The Element Picker's guest assets could not be located",
        context: { asset: id },
      });
    }
    let source: string;
    try {
      source = await read(path.join(root, file));
    } catch (cause) {
      throw new AppError({
        code: "INTERNAL",
        message: "An Element Picker guest asset could not be read",
        context: { asset: id },
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    if (source.length === 0) {
      throw new AppError({
        code: "INTERNAL",
        message: "An Element Picker guest asset is empty",
        context: { asset: id },
      });
    }
    if (Buffer.byteLength(source, "utf8") > MAX_CORE_GUEST_ASSET_BYTES) {
      throw new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "An Element Picker guest asset exceeds its ceiling",
        context: { asset: id },
      });
    }
    if (options.cache) cached.set(id, source);
    return source;
  }

  return async (id) => {
    const file = files[id];
    if (file === undefined) return null;
    const hit = cached.get(id);
    if (hit !== undefined) return hit;
    let pending = inflight.get(id);
    if (pending === undefined) {
      pending = load(id, file).finally(() => inflight.delete(id));
      inflight.set(id, pending);
    }
    return pending;
  };
}

/**
 * Resolved at call time, because `app.getAppPath()` is not valid at module
 * evaluation. The same path serves both modes, exactly as for the built-in
 * plugins: the repo's `dist-electron/` in dev, `app.asar/dist-electron/` packaged.
 */
export function resolveCoreGuestAssetRoot(): string | null {
  try {
    if (typeof app?.getAppPath !== "function") return null;
    return path.join(app.getAppPath(), "dist-electron", CORE_GUEST_ASSET_DIR);
  } catch (err) {
    console.warn("[ElementPicker] Failed to resolve the guest asset directory:", err);
    return null;
  }
}

let defaultLoader: CoreGuestAssetLoader | null = null;

/** Built on first use, so an app that never binds the picker never reads a file. */
export function loadCoreGuestAsset(id: CoreGuestAssetId): Promise<string | null> {
  defaultLoader ??= createCoreGuestAssetLoader({
    root: resolveCoreGuestAssetRoot,
    // A packaged asset cannot change under the running app; in dev the esbuild
    // watcher rewrites it without restarting Electron.
    cache: app?.isPackaged === true,
  });
  return defaultLoader(id);
}
