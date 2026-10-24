import type { Plugin, Rolldown } from "vite";
import path from "path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
// Source of truth for the host/plugin React contract. The plugin build
// (@daintreehq/plugin-vite) errors on any React subpath outside this list, and
// here it drives the injected `<script type="importmap">` — one constant keeps
// the two sides from drifting (the `react-dom/server` "externalized but
// unresolved" class of bug). Imported from source (not the built dist) the same
// way vite.config.ts imports from `./shared/*`.
//
// The map itself serves the wider HOST_IMPORTMAP_SERVED_SPECIFIERS: the
// externals contract plus raw-only entries (the SDK's React hooks) that bundled
// views keep bundling and only zero-build views resolve through the host.
import { HOST_IMPORTMAP_SERVED_SPECIFIERS } from "../../packages/plugin-vite/src/hostImportMap";
import { getFirstRenderPreloadSeeds } from "../../shared/config/panelKindRegistry";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import { HOST_FACADE_REQUIRED_EXPORTS, type HostFacadeSpecifier } from "./host-facade-exports";
import type { ImportMapBuildState } from "./vite-index-html";

// `HOST_IMPORTMAP_SERVED_SPECIFIERS` (imported from @daintreehq/plugin-vite above) is
// the set of specifiers exposed to externalized plugin bundles and raw views. Each one gets
// its OWN facade module re-exporting that specifier's public API; the import
// map points at the facades, never at `vendor-react` directly. Pointing every
// specifier at the shared `vendor-react` chunk is what broke the contract in
// #11208: a code-split chunk is not an entry, so its exports are Rolldown's
// private cross-chunk interface (`export{n as a,i,...}`), not React's public
// API — `import { useEffect } from "react"` threw "does not provide an export
// named 'useEffect'" in every packaged build since v0.15.0. Trailing-slash
// mappings ("react/") can't substitute either — a chunk file has no subpath
// structure to concatenate against — so every JSX/React entrypoint plugins
// might import is listed explicitly in the shared constant. `scheduler` is
// internal to React and not exposed because no documented plugin path imports
// it directly; if that changes, add it to the shared constant (plugin-vite),
// which keeps the externals regex and this import map in lockstep by design.

const HOST_APP_ORIGIN = "app://daintree";

// Prefix for the virtual facade modules that re-export host modules. Shared
// by the production emitter (hostFacadePlugin) and the dev server
// (hostImportMapDevPlugin) — the two apply to disjoint modes but must generate
// byte-identical module source, which is the whole point of #11208: dev built a
// real facade while production mapped to a raw chunk, so the ABI plugins compile
// against silently differed between `npm run dev` and a packaged build.
const HOST_FACADE_VIRTUAL_PREFIX = "virtual:daintree-host/";

function toPosixId(id: string): string {
  return id.split(path.sep).join("/");
}

// The host compiles the tour from source (see the `@daintreehq/tour` aliases).
export function isTourSourceModule(id: string): boolean {
  return toPosixId(id).includes("/packages/tour/src/");
}

// Only the thin public surface of `@daintreehq/plugin-ui`; the components it
// lazily loads live elsewhere in `src/` and keep their own chunks.
export function isPluginUiSourceModule(id: string): boolean {
  return toPosixId(id).includes("/src/pluginUi/");
}

// The SDK's React hooks, served to zero-build views. Compiled from the SDK's own
// source (aliased in vite.config.ts), never from `src/`, so the served surface is exactly
// the published `/react` entry. `sync/` is the one sibling the hooks reach.
export function isPluginSdkReactSourceModule(id: string): boolean {
  const posix = toPosixId(id);
  return (
    posix.endsWith("/packages/plugin-sdk/src/react.ts") ||
    posix.includes("/packages/plugin-sdk/src/react/") ||
    posix.includes("/packages/plugin-sdk/src/sync/")
  );
}

// The codeSplitting group that holds the tour engine. One chunk shared by the
// host's lazy TourDialog and the tour facades is what makes a plugin scene's
// `useCue` see the host's `TourPlayerContext`.
export const TOUR_CHUNK_NAME = "tour";

// The codeSplitting group that holds `src/pluginUi`, so serving it to plugins
// never folds it into the eager `boot` chunk.
export const PLUGIN_UI_CHUNK_NAME = "plugin-ui";

// The codeSplitting group that holds the SDK's React hooks: one module instance
// per document, so raw views share `useCachedHostChannel`'s cache and `useNow`'s
// clocks. Bundled views carry their own pinned copy and never touch it.
export const PLUGIN_SDK_REACT_CHUNK_NAME = "plugin-sdk-react";

// Host modules served to plugins that the host compiles from its own ESM
// source, as opposed to React's CJS (see renderHostFacade). Each lives in one
// codeSplitting group chunk that every facade for it imports — one instance
// shared by host and plugins — and none may load at startup; hostFacadePlugin
// proves both.
interface HostSourceModule {
  readonly chunkName: string;
  serves(specifier: string): boolean;
  isSourceModule(id: string): boolean;
  /**
   * Hold the facade to exactly HOST_FACADE_REQUIRED_EXPORTS rather than a
   * minimum. For a module written only to be served, any extra export is an
   * accidental public contract.
   */
  readonly exactExports?: boolean;
}

const HOST_SOURCE_MODULES: readonly HostSourceModule[] = [
  {
    chunkName: TOUR_CHUNK_NAME,
    serves: (specifier) =>
      specifier === "@daintreehq/tour" || specifier.startsWith("@daintreehq/tour/"),
    isSourceModule: isTourSourceModule,
  },
  {
    chunkName: PLUGIN_UI_CHUNK_NAME,
    serves: (specifier) => specifier === "@daintreehq/plugin-ui",
    isSourceModule: isPluginUiSourceModule,
    exactExports: true,
  },
  {
    chunkName: PLUGIN_SDK_REACT_CHUNK_NAME,
    serves: (specifier) => specifier === "@daintreehq/plugin-sdk/react",
    isSourceModule: isPluginSdkReactSourceModule,
    exactExports: true,
  },
];

function hostSourceModuleFor(specifier: string): HostSourceModule | undefined {
  return HOST_SOURCE_MODULES.find((module) => module.serves(specifier));
}

// Resolution anchor for reading the installed React packages. Anchored on cwd
// rather than `import.meta.url` because Vite may load its config as either ESM
// or CJS, and `import.meta` is absent in the CJS path.
const requireFromRoot = createRequire(path.join(process.cwd(), "vite.config.ts"));

// A conservative "safe to write in an export clause" identifier test. Anything
// exotic is dropped rather than risking a syntax error in generated code; no
// React export has ever needed it.
const SAFE_EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const hostReactExportNameCache = new Map<string, string[]>();

// The public names a specifier actually exports, read from the installed
// package. Generating from the real surface (rather than a hand-kept list)
// keeps the facades correct across React upgrades, and matches per mode: Vite
// defaults NODE_ENV to production for `build` (and preserves an explicit one)
// and uses that same value for the browser's `process.env.NODE_ENV` define, so
// this Node process and the bundle always select the same branch of React's
// `if (process.env.NODE_ENV === 'production')` CJS switch. `vite dev` likewise
// sees the development build the dev server serves.
//
// Memoized: the generator and the build guard both need this list, and the
// guard's whole job is to compare what the generator ASKED for against what
// Rolldown emitted — so both must read exactly the same set.
function hostReactExportNames(specifier: string): string[] {
  const cached = hostReactExportNameCache.get(specifier);
  if (cached) return cached;

  let ns: Record<string, unknown>;
  try {
    ns = requireFromRoot(specifier) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[host-react-facade] cannot resolve "${specifier}" to read its export surface: ` +
        formatErrorMessage(err, "module resolution failed"),
      { cause: err }
    );
  }
  // `default` is excluded here and re-exported explicitly below; emitting it in
  // the named clause too would be a duplicate-binding syntax error.
  const names = Object.keys(ns)
    .filter((name) => name !== "default" && SAFE_EXPORT_NAME.test(name))
    .sort();
  hostReactExportNameCache.set(specifier, names);
  return names;
}

// The single source of the facade module body, shared by the production emitter
// and the dev server.
//
// The named re-exports are enumerated EXPLICITLY. `export * from "react"` looks
// equivalent and is not: React ships CJS, and a star re-export from CJS has no
// statically-known name set, so Rolldown emits a facade exporting nothing but
// `default` — silently, with a clean build. (Dev got away with `export *` only
// because Vite pre-bundles React into real ESM first, which is precisely the
// dev/prod divergence behind #11208.) Naming each export is what makes the
// production chunk's signature real; hostFacadePlugin's generateBundle
// then proves it against the built output.
//
// The star form also never re-exports `default` (ESM semantics), so the
// computed default below keeps `import React from "react"` working without a
// direct `export { default }`, which would throw for subpaths (e.g.
// jsx-runtime) that have no own default export.
//
// Host source modules (the tour, plugin-ui, the SDK hooks) take the star form:
// they are ESM source (aliased into packages/*/src and src/pluginUi), so their export
// names are statically known and `export *` carries all of them — no
// config-time require of a package that ships no CJS and whose `dist/` may not
// be built. Neither has a default export to synthesize.
function renderHostFacade(specifier: string): string {
  const target = JSON.stringify(specifier);
  if (hostSourceModuleFor(specifier)) return `export * from ${target};\n`;
  const named = hostReactExportNames(specifier);
  const lines = [`import * as m from ${target};`];
  if (named.length > 0) lines.push(`export { ${named.join(", ")} } from ${target};`);
  lines.push(`export default m.default ?? m;`);
  return `${lines.join("\n")}\n`;
}

// Emitted-chunk name for a specifier. Slashes are flattened to hyphens so the
// name can't be read as a directory path. The hashed `.fileName` is resolved
// from the bundle by this name — never predicted — because only Rolldown knows
// the final hash.
function hostFacadeChunkName(specifier: string): string {
  if (hostSourceModuleFor(specifier)) return `host-${specifier.slice(1).replaceAll("/", "-")}`;
  return `host-react-${specifier.replaceAll("/", "-")}`;
}

// Exact name -> specifier, not a `startsWith("host-react-")` prefix test: this
// set decides which chunks are excluded from entry selection and compile hints,
// and a real app chunk that happened to share the prefix would be silently
// dropped from those gates.
const HOST_FACADE_CHUNK_NAMES: ReadonlyMap<string, HostFacadeSpecifier> = new Map(
  HOST_IMPORTMAP_SERVED_SPECIFIERS.map((specifier) => [hostFacadeChunkName(specifier), specifier])
);

// Flattening `/` to `-` is not injective, so prove the derived names are
// distinct. Throwing at module scope fails config load — loud and immediate —
// rather than letting two specifiers collide onto one chunk.
if (HOST_FACADE_CHUNK_NAMES.size !== HOST_IMPORTMAP_SERVED_SPECIFIERS.length) {
  throw new Error(
    "[host-facade] two HOST_IMPORTMAP_SERVED_SPECIFIERS entries flatten to the same chunk name: " +
      HOST_IMPORTMAP_SERVED_SPECIFIERS.map((s) => `${s} -> ${hostFacadeChunkName(s)}`).join(", ")
  );
}

export function isHostFacadeChunkName(name: string): boolean {
  return HOST_FACADE_CHUNK_NAMES.has(name);
}

interface FacadeLookupChunk {
  type: string;
  name?: string;
  fileName?: string;
}

// Resolve each specifier's facade chunk to its hashed `.fileName`, which
// Rolldown assigns and the browser must load. Throws rather than falling back:
// a missing facade means the emitter didn't run, and silently mapping to
// something else is how #11208 shipped in the first place.
function findHostFacadePaths(bundle: Record<string, FacadeLookupChunk>): Record<string, string> {
  const byName = new Map<string, string>();
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk" && output.name && output.fileName) {
      if (isHostFacadeChunkName(output.name)) byName.set(output.name, output.fileName);
    }
  }

  const paths: Record<string, string> = {};
  const missing: string[] = [];
  for (const specifier of HOST_IMPORTMAP_SERVED_SPECIFIERS) {
    const fileName = byName.get(hostFacadeChunkName(specifier));
    if (fileName) paths[specifier] = fileName;
    else missing.push(specifier);
  }
  if (missing.length > 0) {
    throw new Error(
      `[host-import-map] no facade chunk emitted for: ${missing.join(", ")}. ` +
        "Check hostFacadePlugin's buildStart emitFile calls in scripts/lib/vite-host-facade.ts."
    );
  }
  return paths;
}

// Emits one facade entry chunk per host specifier and verifies the built result
// actually carries each specifier's public API (#11208), backed by one shared
// instance of React and of the tour.
//
// Why entry chunks: only an ENTRY has a preserved, meaningful export signature.
// `vendor-react` is a code-split chunk, so its exports are whatever other chunks
// happen to import from it — the private cross-chunk interface the import map
// used to point at. Emitting `import * as m from "react"; export * from "react"`
// as its own entry (`preserveSignature: "exports-only"`) makes Rolldown emit a
// chunk whose export list IS react's public surface, while the actual runtime
// modules stay captured by the untouched `vendor-react` group (priority 80) —
// so all five React facades import that same one chunk and the single-React-instance
// guarantee holds. Do NOT add `entriesAware` to the vendor-react group to
// "help": it fragments a group per unique importing-entry-set, which would give
// each facade its own React copy and reintroduce `Invalid hook call`.
//
// The tour facades follow the same shape against the `tour` group's chunk. The
// catch is that a facade is an entry, and anything an entry reaches statically
// is `$initial` — which the `boot` group would sweep into the eager first-render
// chunk. The `tour` group claims the tour source first, so it stays one chunk
// that only the lazy TourDialog and the facades import; generateBundle proves
// that the chunk exists, that both facades use it, and that nothing on the
// startup path reaches it statically. The `@daintreehq/plugin-ui` facade gets
// the same treatment against the `plugin-ui` group's chunk.
export function hostFacadePlugin(): Plugin {
  return {
    name: "host-facade",
    apply: "build",
    buildStart() {
      for (const [name, specifier] of HOST_FACADE_CHUNK_NAMES) {
        this.emitFile({
          type: "chunk",
          id: `${HOST_FACADE_VIRTUAL_PREFIX}${specifier}`,
          name,
          // Explicit rather than relying on the `'exports-only'` global default:
          // this is the property the whole contract rests on, and Vite's
          // RollupOptions type doesn't surface `preserveEntrySignatures`, so the
          // per-chunk override is the only place it can be stated in config.
          preserveSignature: "exports-only",
        });
      }
    },
    resolveId(id) {
      if (id.startsWith(HOST_FACADE_VIRTUAL_PREFIX)) return `\0${id}`;
      return null;
    },
    load(id) {
      const resolvedPrefix = `\0${HOST_FACADE_VIRTUAL_PREFIX}`;
      if (!id.startsWith(resolvedPrefix)) return null;
      return renderHostFacade(id.slice(resolvedPrefix.length));
    },
    // Runs against the FINAL bundle, so `chunk.exports` is the post-tree-shake
    // export list — the only thing that proves the facade survived. Source-level
    // `export *` and `preserveSignature` are both necessary but neither is
    // sufficient evidence: lazyBarrel prunes silently.
    generateBundle(_options, bundle) {
      const chunksByName = new Map<string, { fileName: string; exports: string[] }>();
      let vendorReactFileName: string | null = null;
      const facadeImports = new Map<string, readonly string[]>();
      const chunksByFileName = new Map<string, Rolldown.OutputChunk>();
      const sourceChunks = new Map<HostSourceModule, Rolldown.OutputChunk[]>(
        HOST_SOURCE_MODULES.map((module) => [module, []])
      );

      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        chunksByFileName.set(output.fileName, output);
        for (const [module, chunks] of sourceChunks) {
          if (output.moduleIds.some(module.isSourceModule)) chunks.push(output);
        }
        if (output.name === "vendor-react") vendorReactFileName = output.fileName;
        if (!output.name || !isHostFacadeChunkName(output.name)) continue;
        chunksByName.set(output.name, { fileName: output.fileName, exports: output.exports });
        facadeImports.set(output.name, output.imports);
      }

      const problems: string[] = [];

      // Fail closed. If the named group ever stops emitting, every per-facade
      // single-instance check below would silently no-op while React quietly
      // duplicated across entries — the exact failure this guard exists to catch.
      if (!vendorReactFileName) {
        problems.push(
          "no chunk named `vendor-react` in the build output — the codeSplitting group in " +
            "vite.config.ts is the only thing keeping React a single shared instance."
        );
      }

      // Same for each host source module: its source must live in exactly one
      // chunk, its group's. A second chunk holding tour source is a second
      // TourPlayerContext, and a plugin scene bound to the other one never sees
      // the host's player.
      const sharedChunks = new Map<HostSourceModule, Rolldown.OutputChunk | null>();
      for (const [module, chunks] of sourceChunks) {
        const owned = chunks.find((chunk) => chunk.name === module.chunkName) ?? null;
        sharedChunks.set(module, owned);
        if (!owned || chunks.length !== 1) {
          problems.push(
            `${module.chunkName} source must be in exactly one chunk named \`${module.chunkName}\`; found it in: ` +
              (chunks.map((chunk) => chunk.name || chunk.fileName).join(", ") || "(none)")
          );
        }
      }

      for (const [name, specifier] of HOST_FACADE_CHUNK_NAMES) {
        const chunk = chunksByName.get(name);
        if (!chunk) {
          problems.push(`"${specifier}": no facade chunk named "${name}" in the bundle`);
          continue;
        }
        const actual = new Set(chunk.exports);
        const sourceModule = hostSourceModuleFor(specifier);

        // Check 1 — nothing the generator asked for got tree-shaken away. The
        // host source module facades are `export *`, so they have no generator
        // list and rely on check 2 alone.
        if (!sourceModule) {
          const elided = [...hostReactExportNames(specifier), "default"].filter(
            (n) => !actual.has(n)
          );
          if (elided.length > 0) {
            problems.push(
              `"${specifier}" (${chunk.fileName}) lost ${elided.length} export(s) the facade ` +
                `re-exported: ${elided.join(", ")}`
            );
          }
        }

        // Check 2 — the promised minimum is present regardless of what the
        // generator derived (see HOST_FACADE_REQUIRED_EXPORTS).
        const missing = HOST_FACADE_REQUIRED_EXPORTS[specifier].filter((n) => !actual.has(n));
        if (missing.length > 0) {
          problems.push(
            `"${specifier}" (${chunk.fileName}) is missing: ${missing.join(", ")}. ` +
              `Emitted exports: ${chunk.exports.join(", ") || "(none)"}`
          );
        }
        if (sourceModule?.exactExports) {
          const promised = new Set<string>(HOST_FACADE_REQUIRED_EXPORTS[specifier]);
          const extra = chunk.exports.filter((n) => !promised.has(n));
          if (extra.length > 0) {
            problems.push(
              `"${specifier}" (${chunk.fileName}) exports ${extra.join(", ")} beyond its ` +
                "declared contract. Declare them in HOST_FACADE_REQUIRED_EXPORTS (and, for " +
                "plugin-ui, the SDK's plugin-ui.d.ts), or stop exporting them."
            );
          }
        }

        // Every facade must reach its module through the one shared chunk. If a
        // facade stopped importing it, the module got inlined into the facade —
        // i.e. a second copy — which breaks hooks (React) or context (tour).
        const sharedFileName = sourceModule
          ? (sharedChunks.get(sourceModule)?.fileName ?? null)
          : vendorReactFileName;
        if (sharedFileName && !facadeImports.get(name)?.includes(sharedFileName)) {
          problems.push(
            `"${specifier}" (${chunk.fileName}) does not import the shared ` +
              `${sourceModule?.chunkName ?? "vendor-react"} chunk (${sharedFileName}) — the ` +
              "module may have been duplicated into the facade."
          );
        }
      }

      // Serving a host source module to plugins must not load it at startup.
      // Walk the static imports of the app entry and of every first-render seed
      // chunk (App.tsx is a dynamic import but loads on first render all the
      // same); none may reach a host source module's chunk.
      const seeds = new Set(getFirstRenderPreloadSeeds());
      const root = process.cwd();
      const startupRoots = [...chunksByFileName.values()].filter((chunk) => {
        if (chunk.name && isHostFacadeChunkName(chunk.name)) return false;
        if (chunk.isEntry) return true;
        const facade = chunk.facadeModuleId;
        if (!facade || facade.startsWith("\0")) return false;
        return seeds.has(toPosixId(path.relative(root, facade)));
      });
      for (const startup of startupRoots) {
        const seen = new Set<string>();
        const queue = [startup.fileName];
        while (queue.length > 0) {
          const fileName = queue.pop()!;
          if (seen.has(fileName)) continue;
          seen.add(fileName);
          queue.push(...(chunksByFileName.get(fileName)?.imports ?? []));
        }
        for (const [module, shared] of sharedChunks) {
          if (!shared || !seen.has(shared.fileName)) continue;
          problems.push(
            `startup chunk ${startup.name || startup.fileName} statically imports the ` +
              `${module.chunkName} chunk (${shared.fileName}) — it would load on first ` +
              "render instead of when something first uses it."
          );
        }
      }

      if (problems.length > 0) {
        throw new Error(
          "[host-facade] the production import map would serve modules that do not " +
            "expose their public API from one shared instance — third-party plugins would " +
            "fail to load or silently misbehave (#11208, #12771):\n" +
            problems.map((p) => `  - ${p}`).join("\n")
        );
      }
    },
  };
}

// Injects `<script type="importmap">` into the production index.html and emits
// `dist/importmap-meta.json` so the Electron main process can mirror the inline
// script hash into its HTTP `Content-Security-Policy` header. Dev builds are
// skipped — the dev server CSP carries `'unsafe-inline'` and `ctx.bundle` is
// undefined in serve mode, so there's nothing to map. The map exists so plugin
// bundles can declare React as an external and resolve to the host's single
// React instance at runtime; bundling a second copy of React produces "Invalid
// hook call" errors at the first JSX render.
export function hostImportMapPlugin(state: ImportMapBuildState): Plugin {
  const sidecarPath = path.join(process.cwd(), "dist", "importmap-meta.json");

  return {
    name: "host-import-map",
    apply: "build",
    buildStart() {
      state.scriptSrcHash = null;
    },
    // Default-order hook (no `order` field). Vite calls default-order
    // transformIndexHtml hooks AFTER bundling so `ctx.bundle` is populated;
    // `order: "pre"` runs before bundling and would see `ctx.bundle ===
    // undefined`. cspTransformPlugin is the next default-order hook in the
    // plugin array, so it observes the hash this hook stores in shared state.
    transformIndexHtml(_html, ctx) {
      // `ctx.bundle` is populated only for production builds. In the dev
      // server the vendor-react chunk doesn't exist (Vite serves React from
      // the module graph), and an importmap pointing at a hashed filename
      // that won't be emitted would be a runtime 404.
      if (!ctx.bundle) return;

      const facadePaths = findHostFacadePaths(ctx.bundle as Record<string, FacadeLookupChunk>);

      // One distinct target per specifier — each facade exposes only that
      // specifier's public surface. hostFacadePlugin has already verified
      // those surfaces against the built chunks, so a map emitted here is a map
      // that actually resolves.
      const importMapPayload = {
        imports: Object.fromEntries(
          HOST_IMPORTMAP_SERVED_SPECIFIERS.map((specifier) => [
            specifier,
            `${HOST_APP_ORIGIN}/${facadePaths[specifier]}`,
          ])
        ),
      };

      // Pin the shape of the map itself, not just the facades it points at.
      // The facade guard proves the CHUNKS are good; it cannot see this HTML, so
      // a refactor that collapsed every specifier back onto one target (#11208's
      // original shape) would leave valid-but-unused facades and still
      // build clean. This is the assertion that makes that regression loud.
      const targets = Object.values(importMapPayload.imports);
      if (new Set(targets).size !== HOST_IMPORTMAP_SERVED_SPECIFIERS.length) {
        throw new Error(
          "[host-import-map] every specifier must map to its own facade; got " +
            `${new Set(targets).size} distinct target(s) for ${HOST_IMPORTMAP_SERVED_SPECIFIERS.length} ` +
            "specifiers. Mapping several specifiers at one file is #11208: a shared chunk only " +
            "exports the private cross-chunk interface, never React's public API."
        );
      }
      // Compact JSON without trailing whitespace — the byte sequence here is
      // exactly what the browser receives, and the SHA-256 must match.
      const serialized = JSON.stringify(importMapPayload);
      state.scriptSrcHash = `'sha256-${createHash("sha256").update(serialized, "utf8").digest("base64")}'`;

      return [
        {
          tag: "script",
          attrs: { type: "importmap" },
          // `head-prepend` places the importmap before the entry `<script
          // type="module">` so the browser parses it before resolving module
          // specifiers. Per the HTML spec, the integrity attribute is
          // FORBIDDEN on `<script type="importmap">`; a top-level `integrity`
          // block inside the JSON payload is the supported mechanism, but it
          // is only relevant when the map points at cross-origin chunks. The
          // host vendor chunk is same-origin, so no integrity block is
          // emitted today.
          injectTo: "head-prepend",
          children: serialized,
        },
      ];
    },
    closeBundle() {
      const allHashes = [
        ...(state.scriptSrcHash ? [state.scriptSrcHash] : []),
        ...state.skeletonScriptHashes,
      ];
      if (allHashes.length === 0) return;
      mkdirSync(path.dirname(sidecarPath), { recursive: true });
      writeFileSync(sidecarPath, JSON.stringify({ scriptSrcHashes: allHashes }, null, 2) + "\n");
    },
  };
}

// Dev counterpart to hostImportMapPlugin. Production maps each specifier to a
// hashed facade chunk emitted by hostFacadePlugin; in dev those chunks
// don't exist (Vite serves React from the module graph), so a sideloaded plugin
// view that externalizes React has nothing to resolve `react` against and fails
// to mount (#10514). This plugin closes that gap: it injects an import map into
// the dev index.html mapping each host specifier to a stable virtual module that
// re-exports the host's React. Because the virtual module's own `import` is
// resolved by Vite server-side (not via the browser import map), it lands on the
// exact React instance the host uses — one instance shared with every plugin,
// same guarantee as production. Serve-only; the dev CSP carries `'unsafe-inline'`
// so the inline `<script type="importmap">` needs no hash.
//
// Vite serves a resolved virtual id at `/@id/<id>`, so that URL is stable across
// runs — unlike the optimized-dep path (`/node_modules/.vite/deps/react.js?v=
// <hash>`), whose hash changes per optimize pass and can't be referenced
// statically from an import map. The id is left un-prefixed here for that
// reason; the production emitter `\0`-prefixes the same id, which is why these
// two plugins resolve alike but not identically.
export function hostImportMapDevPlugin(): Plugin {
  return {
    name: "host-import-map-dev",
    apply: "serve",
    resolveId(id) {
      if (id.startsWith(HOST_FACADE_VIRTUAL_PREFIX)) return id;
      return null;
    },
    load(id) {
      if (!id.startsWith(HOST_FACADE_VIRTUAL_PREFIX)) return null;
      // Same generator as production — dev/prod ABI parity by construction.
      return renderHostFacade(id.slice(HOST_FACADE_VIRTUAL_PREFIX.length));
    },
    transformIndexHtml(_html, ctx) {
      if (!ctx.server) return;
      const importMapPayload = {
        imports: Object.fromEntries(
          HOST_IMPORTMAP_SERVED_SPECIFIERS.map((specifier) => [
            specifier,
            `/@id/${HOST_FACADE_VIRTUAL_PREFIX}${specifier}`,
          ])
        ),
      };
      return [
        {
          tag: "script",
          attrs: { type: "importmap" },
          injectTo: "head-prepend",
          children: JSON.stringify(importMapPayload),
        },
      ];
    },
  };
}
