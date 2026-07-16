import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // Every bundle entry point. Knip walks the static import graph from each
  // of these roots; anything unreachable is flagged as dead code. Mirrors
  // the esbuild entryPoints in scripts/build-main.mjs plus the renderer
  // entry wired via vite.config.
  entry: [
    "electron/bootstrap.ts",
    "electron/main.ts",
    "electron/pty-host.ts",
    "electron/pty-host-bootstrap.ts",
    "electron/workspace-host.ts",
    "electron/workspace-host-bootstrap.ts",
    "electron/watchdog-host.ts",
    "electron/watchdog-host-bootstrap.ts",
    "electron/plugin-dev-worker.ts",
    "electron/plugin-dev-worker-bootstrap.ts",
    "electron/preload.cts",
    "electron/pty-host/analysisWorker.ts",
    "electron/services/persistence/dbMaintenanceWorker.ts",
    "electron/services/voice/openaiVadWorker.ts",
    "electron/workspace-host/copytreeWorker.ts",

    // Web workers instantiated via `new Worker(new URL(...))`. Static analysis
    // can't follow those URLs, so workers read as unreachable without
    // an explicit entry.
    "src/workers/*.worker.ts",

    // Invoked by the electron-builder CLI and documented diagnostic scripts
    // that aren't wired through package.json.
    "electron-builder.config.cjs",
    "scripts/generate-sounds.mjs",

    // The perf dispatcher launches these entry points by string path in
    // isolated subprocesses, so static analysis cannot follow those edges.
    "scripts/perf/run.ts",
    "scripts/perf/cold-start.ts",
    "scripts/perf/launch-ab.ts",
    "scripts/perf/memory-bench-compare.ts",
    "scripts/perf/memory-growth-compare.ts",

    // why: bench-only classic script inlined by vite.config.ts via readFileSync
    // when DAINTREE_RENDER_PROBE=1 (`npm run build:e2e:bench`). Knip cannot
    // follow filesystem reads, but e2e/full/panels/store-fanout-perf.spec.ts
    // consumes the global it installs.
    "scripts/perf/render-fanout-probe.js",

    // Playwright discovers specs by filesystem glob; knip has no visibility
    // into the test runner, so tests appear unused without these roots.
    "e2e/**/*.spec.ts",
  ],

  // Project files Knip considers part of the graph. Includes root-level
  // *.config.ts (vite, vitest, playwright) and scripts/** so build-time and
  // test-time imports are seen — without them Knip reports live devDeps
  // like tailwindcss, fast-check, and wait-on as unused. `.cjs` is included
  // so scripts/postinstall.cjs and scripts/afterPack.cjs are covered.
  project: [
    "electron/**/*.{ts,cts}",
    "src/**/*.{ts,tsx}",
    "shared/**/*.ts",
    "scripts/**/*.{js,mjs,cjs,ts}",
    "e2e/**/*.ts",
    "*.config.{ts,mts,cts,js,mjs,cjs}",
  ],

  // why: ActionService dispatches via string IDs (see
  // src/services/ActionService.ts — `dispatch(actionId, ...)`). Knip cannot
  // see those calls in the static import graph, so action handlers registered
  // via the definitions/*.ts files appear unused. Surface this as a known
  // false-positive class rather than a file-level ignore so any *new*
  // genuinely-unused exports still get flagged.
  ignoreExportsUsedInFile: true,

  ignore: [
    // why: Renderer hook intended for plugin panels mounted at runtime.
    // Plugins are loaded from ~/.daintree/plugins at app start, so the static
    // import graph never reaches this hook. Keep it available as a public
    // API surface for plugin authors.
    "src/hooks/useActiveWorktree.ts",

    // why: Barrel files only reachable via React.lazy() dynamic imports in
    // src/App.tsx. Knip cannot trace import() calls, so these index.ts
    // re-exports appear unused despite being public API surfaces.
    "src/components/ActionPalette/index.ts",
    "src/components/LogLevelPalette/index.ts",
    "src/components/QuickSwitcher/index.ts",
    "src/components/TerminalPalette/index.ts",
    "src/components/ThemePalette/index.ts",

    // why: codegen test fixtures loaded dynamically by
    // scripts/codegen/__tests__/ipc-map.test.ts via path.join(__dirname,
    // "fixtures"). Knip cannot trace runtime path resolution, so these
    // files appear unused.
    "scripts/codegen/__tests__/fixtures/*.ts",
    // why: renderer API codegen fixtures loaded dynamically by
    // scripts/codegen/__tests__/ipc-renderer.test.ts via path.join(__dirname,
    // "fixtures-renderer"). Knip cannot trace runtime path resolution.
    "scripts/codegen/__tests__/fixtures-renderer/*.ts",

    // why: public plugin SDK API snapshots are loaded by
    // scripts/ci/check-api-surface.mjs via readFileSync rather than static
    // imports. They are tracked files that gate reviewed API changes.
    "packages/plugin-sdk/api-report/*.d.ts",

    // why: local native packages expose package-level declarations through
    // their own package.json "main" entries and are consumed via createRequire.
    // Knip walks the app source graph and does not treat local file:
    // dependency declaration files as package entry points.
    "electron/native/posix-pty-reaper/index.d.ts",
    "electron/native/win-job-object/index.d.ts",

    // why: plugin-facing renderer helper documented in docs/plugins/host-api.md.
    // Plugin views import this surface dynamically through the SDK path, so the
    // app's static graph does not reach the hook directly.
    "src/hooks/useHostChannel.ts",

    // why: planned reactive `when` context backing for plugin menu/keybinding
    // predicates. The current fail-closed menu path documents that producers
    // are not wired yet; keep this as deliberate feature scaffolding.
    "src/services/WhenClauseStore.ts",

    // why: native assistant-host process wrapper added with the protocol and
    // entry resolver, but not wired into a service yet. Keep the wrapper
    // available while the integration lands without making the repo's knip
    // gate fail on the scaffold file.
    "electron/services/assistant-host/AssistantHostProcess.ts",
  ],

  ignoreBinaries: [
    // why: Windows system command used for process-tree cleanup. It is not an
    // npm-provided binary and must not be declared as a package dependency.
    "taskkill",
  ],

  // why: these packages are consumed via mechanisms Knip can't trace:
  //   - tailwindcss / @tailwindcss/typography / tw-animate-css: loaded through
  //     src/index.css (@import statements)
  //   - wait-on: invoked as a shell command from scripts/dev.mjs
  //   - fast-check: peer of @fast-check/vitest; declared in devDeps as a
  //     pinning anchor but imported indirectly through `@fast-check/vitest`.
  //
  // The entries below are imported directly but satisfied transitively today.
  // Flagged here as known debt — silencing knip keeps CI green, but the
  // explicit-declare fix should happen in a follow-up:
  //   - conf: imported in electron/__tests__/storeBackupRestore.test.ts;
  //     transitive via electron-store.
  ignoreDependencies: [
    "tailwindcss",
    "@tailwindcss/typography",
    "tw-animate-css",
    "wait-on",
    "fast-check",
    "conf",
    // scripts/ci/electron-builder-config.test.mjs reads the installed
    // electron-builder schema from node_modules/app-builder-lib/scheme.json.
    // electron-builder owns that transitive package; the test must validate
    // against the exact bundled schema rather than a separately declared copy.
    "app-builder-lib",
    "@octokit/request-error",
    "@octokit/types",
    // CJS-only runtime dependencies loaded through createRequire so the ESM
    // bundles can keep narrow interop types at the call sites.
    "ajv",
    "ajv-formats",
    "proper-lockfile",
    // packages/daintree-plugin reuses host archive/schema code outside the
    // package workspace and bundles those imports with tsup. Knip checks
    // package-local source only, so these bundled runtime dependencies look
    // unused from that workspace.
    "archiver",
    "semver",
    "yauzl",
    "zod",
    // Native addon support, consumed only from electron/native/win-job-object/
    // binding.gyp (#7526). Knip walks JS/TS imports, not gyp files.
    "node-addon-api",
  ],

  // why: the repo pre-dates knip and carries a ~150-entry backlog of unused
  // exports and types. Emit these categories as warnings so the CI job
  // surfaces the debt without gating merges — matches the "promote to
  // required once the report is clean" intent in .github/workflows/ci.yml.
  // `files`, `dependencies`, and `unlisted` stay as errors so new regressions
  // (dead files, missing deps, phantom imports) still block.
  rules: {
    exports: "warn",
    types: "warn",
    duplicates: "warn",
  },
};

export default config;
