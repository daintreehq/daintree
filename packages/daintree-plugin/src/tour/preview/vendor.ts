import { createRequire } from "node:module";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { HOST_IMPORTMAP_SPECIFIERS } from "../../../../plugin-vite/src/hostImportMap.js";

export type HostSpecifier = (typeof HOST_IMPORTMAP_SPECIFIERS)[number];

/** URL prefix the vendor modules are served under. */
export const VENDOR_PATH = "/_preview/vendor/";

export interface VendorGraph {
  /** Output file name (relative to {@link VENDOR_PATH}) → module text. */
  files: Map<string, string>;
  /** The page's import map: every host specifier → its vendor module URL. */
  imports: Record<HostSpecifier, string>;
  /** The tour package's own files, whose class names the stylesheet has to cover. */
  tourFiles: string[];
}

/**
 * Exports each facade must carry. A facade that lost its named exports still
 * builds and loads; it only fails at the scene's first `useState`, in the
 * browser console, so the preview refuses to start instead (#11216).
 */
const REQUIRED_EXPORTS: Partial<Record<HostSpecifier, string[]>> = {
  react: ["createContext", "useState", "useSyncExternalStore"],
  "react/jsx-runtime": ["jsx", "jsxs", "Fragment"],
  "react-dom/client": ["createRoot"],
  "@daintreehq/tour": ["TourPlayer"],
  "@daintreehq/tour/react": ["TourPlayerContext", "useCue"],
  "@daintreehq/tour/kit": ["TourCanvas", "measureAnchor"],
  "@daintreehq/tour/mock-app": ["MockKitContext", "EMPTY_MOCK_KIT"],
};

const SAFE_EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ENTRY_NAMESPACE = "tour-preview-entry";
const REACT_SPECIFIER = /^react(-dom)?(\/|$)/;

function isTourSpecifier(specifier: string): boolean {
  return specifier === "@daintreehq/tour" || specifier.startsWith("@daintreehq/tour/");
}

function entryName(specifier: string): string {
  return specifier.replace(/^@/, "").replace(/\//g, "-");
}

/**
 * The facade module for one host specifier, the same shape as the host's own
 * (`renderHostFacade` in vite.config.ts). React ships CommonJS, so its names
 * are listed explicitly: `export * from "react"` bundles to a module that
 * exports only `default`. The tour package is ESM, so a star re-export carries
 * everything.
 */
export function renderFacade(specifier: string, reactExports: string[]): string {
  const target = JSON.stringify(specifier);
  if (isTourSpecifier(specifier)) return `export * from ${target};\n`;
  const lines = [`import * as m from ${target};`];
  const named = reactExports.filter((name) => name !== "default" && SAFE_EXPORT_NAME.test(name));
  if (named.length > 0) lines.push(`export { ${named.sort().join(", ")} } from ${target};`);
  lines.push(`export default m.default ?? m;`);
  return `${lines.join("\n")}\n`;
}

function missingDependency(specifier: string, pluginDir: string, error: unknown): Error {
  const pkg = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  return new Error(
    `Couldn't resolve "${specifier}" from ${pluginDir}; the preview plays your scenes against your own ${pkg}, so install it (npm install --save-dev ${pkg})`,
    { cause: error }
  );
}

/**
 * Bundle the modules the host import map serves, resolved from the plugin's
 * own dependencies: the React and tour versions its scenes were built against.
 * One build with code splitting, so every facade shares one React and one
 * `TourPlayerContext` — which is what lets the harness's player reach a scene's
 * `useCue`.
 */
export async function buildVendorGraph(pluginDir: string): Promise<VendorGraph> {
  const requireFromPlugin = createRequire(path.join(pluginDir, "package.json"));
  const resolveFromPlugin = (specifier: string): string => {
    try {
      return requireFromPlugin.resolve(specifier);
    } catch (error) {
      throw missingDependency(specifier, pluginDir, error);
    }
  };

  const facades = new Map<string, string>();
  for (const specifier of HOST_IMPORTMAP_SPECIFIERS) {
    const resolved = resolveFromPlugin(specifier);
    let names: string[] = [];
    if (!isTourSpecifier(specifier)) {
      // Node loads React's development build here, matching NODE_ENV below.
      names = Object.keys(requireFromPlugin(resolved) as Record<string, unknown>);
    }
    facades.set(specifier, renderFacade(specifier, names));
  }
  const tourEntry = resolveFromPlugin("@daintreehq/tour");
  const tourDir = path.dirname(tourEntry);
  // The tour's own dependencies resolve from where it's installed, except
  // React, which must be the plugin's single copy.
  const requireFromTour = createRequire(tourEntry);

  const entries: Plugin = {
    name: "tour-preview-entries",
    setup(b) {
      b.onResolve({ filter: /^tour-preview-entry:/ }, (args) => ({
        path: args.path.slice(ENTRY_NAMESPACE.length + 1),
        namespace: ENTRY_NAMESPACE,
      }));
      b.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, (args) => ({
        contents: facades.get(args.path),
        resolveDir: pluginDir,
        loader: "js",
      }));
      b.onResolve({ filter: REACT_SPECIFIER }, (args) => ({ path: resolveFromPlugin(args.path) }));
      b.onResolve({ filter: /^lucide-react$/ }, (args) => {
        for (const resolve of [requireFromPlugin.resolve, requireFromTour.resolve]) {
          try {
            return { path: resolve(args.path) };
          } catch {
            // Try the next location.
          }
        }
        return {
          errors: [
            {
              text: `@daintreehq/tour's mockup kit draws its icons with lucide-react; install it in the plugin (npm install --save-dev lucide-react)`,
            },
          ],
        };
      });
    },
  };

  // Nothing is written; esbuild only needs somewhere to name the outputs.
  const outdir = path.join(pluginDir, ".tour-preview-vendor");
  let result;
  try {
    result = await build({
      absWorkingDir: pluginDir,
      entryPoints: HOST_IMPORTMAP_SPECIFIERS.map((specifier) => ({
        in: `${ENTRY_NAMESPACE}:${specifier}`,
        out: entryName(specifier),
      })),
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outdir,
      entryNames: "[name]",
      chunkNames: "chunk-[hash]",
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [entries],
    });
  } catch (error) {
    const errors = (error as { errors?: Array<{ text: string }> }).errors;
    const detail = errors?.map((e) => e.text).join("\n") ?? (error as Error).message;
    throw new Error(`Couldn't bundle React and @daintreehq/tour for the preview:\n${detail}`, {
      cause: error,
    });
  }

  const files = new Map<string, string>();
  for (const file of result.outputFiles) {
    files.set(path.relative(outdir, file.path).split(path.sep).join("/"), file.text);
  }
  for (const [specifier, required] of Object.entries(REQUIRED_EXPORTS)) {
    const output = Object.entries(result.metafile.outputs).find(([file]) =>
      file.endsWith(`/${entryName(specifier)}.js`)
    )?.[1];
    const missing = required.filter((name) => !output?.exports.includes(name));
    if (missing.length > 0) {
      throw new Error(
        `The preview's "${specifier}" module is missing ${missing.join(", ")}; the installed package doesn't have the shape the preview expects`
      );
    }
  }

  const imports = Object.fromEntries(
    HOST_IMPORTMAP_SPECIFIERS.map((specifier) => [
      specifier,
      `${VENDOR_PATH}${entryName(specifier)}.js`,
    ])
  ) as Record<HostSpecifier, string>;
  const tourFiles = Object.keys(result.metafile.inputs)
    .map((input) => path.resolve(pluginDir, input))
    .filter((input) => input.startsWith(tourDir + path.sep));
  return { files, imports, tourFiles };
}
