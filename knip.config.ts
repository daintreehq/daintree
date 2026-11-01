import type { KnipConfig } from "knip";

const baseConfig: KnipConfig = {
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
    "electron/services/pluginAgentMcp/databaseQueryWorker.ts",
    "electron/services/voice/openaiVadWorker.ts",
    "electron/services/canopy/canopyReaderWorker.ts",
    "electron/workspace-host/copytreeWorker.ts",
    // Picker utility-process and browser bundles are loaded by emitted path.
    "electron/services/elementPicker/host-bootstrap.ts",
    "electron/services/elementPicker/plugin-resolver-bootstrap.ts",
    "electron/services/elementPicker/guest/bootstrap.ts",
    "electron/services/elementPicker/guest/probe.ts",
    "electron/services/elementPicker/guest/pluginRuntime.ts",
    "electron/services/elementPicker/guest/extractors/{angular,astro,preact,react,solid,svelte,vue}.ts",
    // The guest-host contract test builds this fixture by its filesystem path.
    "electron/services/elementPicker/__tests__/fixtures/contributingExtractor.ts",
    "electron/services/elementPicker/__tests__/fixtures/plugins/lit-picker/src/lit.ts",

    // Web workers instantiated via `new Worker(new URL(...))`. Static analysis
    // can't follow those URLs, so workers read as unreachable without
    // an explicit entry.
    "src/workers/*.worker.ts",

    // Tailwind directives declare stylesheet dependencies as well as JS imports.
    "src/index.css",

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
    "scripts/perf/empty-view-memory-compare.ts",
    "scripts/perf/vanilla-plugins.ts",
    "scripts/perf/project-switch-rotation-compare.ts",
    "scripts/perf/foreground-terminal.ts",
    "scripts/perf/branch-name-availability.ts",
    "scripts/perf/claude-subagent-lookup.ts",
    "scripts/perf/model-catalog-bench.ts",
    "scripts/perf/voice-preview-final.ts",
    "scripts/perf/voice-pipeline.ts",
    "scripts/perf/voice-replay-compare.ts",
    "scripts/perf/voice-tuning.ts",
    "scripts/perf/voice-live-vad.ts",
    "scripts/perf/lib/foregroundAgent.cjs",
    "scripts/perf/verify-baselines.ts",
    "scripts/perf/diagnose.ts",
    "scripts/perf/journeys/report.ts",
    // Invoked directly for focused local measurements.
    "scripts/perf/audio-idle-probe.cjs",
    "scripts/perf/bench-tail-serialize.ts",
    "scripts/perf/snapshot-io-bench.ts",
    // These focused benches load their Vitest configs by CLI path.
    "src/components/Layout/__bench__/vitest.config.ts",
    "src/components/Worktree/__bench__/vitest.config.ts",
    "src/hooks/__bench__/vitest.config.ts",

    // The liveness and module-hook guards launch these drivers by string path
    // in isolated Node processes, so Knip cannot follow the spawn edge.
    "scripts/perf/__tests__/moduleHookProbe.ts",
    // Cross-process restore test loads this Main harness by a non-literal path.
    "electron/services/pty/__tests__/passiveCaptureRestoreHarness.ts",
    "scripts/perf/__tests__/scenarioSmokeDriver.ts",

    // why: bench-only classic script inlined by scripts/lib/vite-index-html.ts via readFileSync
    // when DAINTREE_RENDER_PROBE=1 (`npm run build:e2e:bench`). Knip cannot
    // follow filesystem reads, but e2e/perf/store-fanout-perf.spec.ts
    // consumes the global it installs.
    "scripts/perf/render-fanout-probe.js",

    // Playwright discovers specs by filesystem glob; knip has no visibility
    // into the test runner, so tests appear unused without these roots.
    "e2e/**/*.spec.ts",
    // Loaded by `--config` from the perf dispatcher; Knip's Playwright plugin
    // only discovers playwright.config.*.
    "playwright.perf.config.ts",
  ],

  // Project files Knip considers part of the graph. Includes root-level
  // *.config.ts (vite, vitest, playwright) and scripts/** so build-time and
  // test-time imports are seen — without them Knip reports live devDeps
  // like tailwindcss, fast-check, and wait-on as unused. `.cjs` is included
  // so scripts/postinstall.cjs and scripts/afterPack.cjs are covered.
  project: [
    "electron/**/*.{ts,cts}",
    "src/**/*.{ts,tsx,css}",
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
    // FixtureReader reads these route modules as source text, never imports them.
    "electron/services/elementPicker/projectAdapters/sveltekit/__fixtures__/**",
    // resolve.test.ts reads these compiler inputs as source text by filename.
    "packages/svelte-source-model/src/__tests__/__fixtures__/*.svelte",

    // why: public plugin SDK API snapshots are loaded by
    // scripts/ci/check-api-surface.mjs via readFileSync rather than static
    // imports. They are tracked files that gate reviewed API changes.
    "packages/plugin-sdk/api-report/*.d.ts",

    // why: local native packages expose package-level declarations through
    // their own package.json "main" entries and are consumed via createRequire.
    // Knip walks the app source graph and does not treat local file:
    // dependency declaration files as package entry points.
    "electron/native/mac-phys-footprint/index.d.ts",
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
  ],

  ignoreBinaries: [
    // The release workflow invokes CLI binaries from local npm workspaces.
    // Screenshot and tour tooling require ffmpeg and wrangler from
    // the host OS rather than npm dependencies in this package.
    "create-daintree-plugin",
    "daintree-plugin",
    "ffmpeg",
    "magick",
    "sqlite3",
    "wrangler",
    // why: Host OS commands invoked directly by platform-specific runtime,
    // installer, and E2E paths. They are not npm-provided binaries and must
    // not be declared as package dependencies.
    // The native supervisor tests compile their fixture with the host C compiler.
    "cc",
    "ditto",
    "du",
    "gnome-control-center",
    "mkfifo",
    "osascript",
    "pgrep",
    "pkill",
    "reg",
    "say",
    "sips",
    "taskkill.exe",
    "top",
    "vmmap",
    "where",
    "wsl.exe",
    "xdg-open",
  ],

  ignoreIssues: {
    // The macOS Focus probe invokes an absolute system executable. On Linux,
    // Knip cannot resolve that platform-only path and reports it as an import.
    "electron/services/OsDndService.ts": ["unresolved"],
  },

  // why: browser-only absolute module URLs that Vite resolves inside
  // `page.evaluate` in the copy-context screenshot harness. Exact specifiers,
  // so a misspelled import elsewhere in that spec is still flagged.
  ignoreUnresolved: ["/src/store/copyTreeRunStore.ts", "/src/lib/copyTreeFeedback.ts"],

  // why: these packages are consumed via mechanisms Knip can't trace:
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
    // Electron provides its unpatched filesystem as a built-in module.
    "original-fs",
    "wait-on",
    "fast-check",
    "conf",
    // Sample-plugin contract tests deliberately resolve the local workspaces
    // by their public package names, while the rich sample's standalone Vite
    // config exercises the same package boundary as third-party authors.
    // The samples are not npm workspaces and therefore cannot declare these
    // host-repository development dependencies themselves.
    "@daintreehq/plugin-sdk",
    // A host-provided virtual module; the SDK ships its ambient declaration.
    "@daintreehq/plugin-ui",
    "@daintreehq/plugin-vite",
    // The app compiles the tour engine from source through tsconfig, Vite and
    // Vitest aliases rather than as an installed dependency.
    "@daintreehq/tour",
    // scripts/ci/electron-builder-config.test.mjs reads the installed
    // electron-builder schema from node_modules/app-builder-lib/scheme.json.
    // electron-builder owns that transitive package; the test must validate
    // against the exact bundled schema rather than a separately declared copy.
    "app-builder-lib",
    "@octokit/request-error",
    "@octokit/types",
    // CJS-only runtime dependencies loaded through createRequire so the ESM
    // bundles can keep narrow interop types at the call sites.
    "ajv-formats",
    "proper-lockfile",
    // packages/daintree-plugin reuses host archive/schema code outside the
    // package workspace and bundles those imports with tsup. Knip checks
    // package-local source only, so these bundled runtime dependencies look
    // unused from that workspace.
    "archiver",
    "yauzl",
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

const { entry, project, ...options } = baseConfig;
const config: KnipConfig = {
  ...options,
  workspaces: {
    ".": { entry, project },
    "packages/daintree-plugin": {
      // tsup's onSuccess browser build names this entry by string path.
      entry: ["src/tour/preview/browser/harness.tsx"],
    },
  },
};

export default config;
