// Generates docs/plugins/actions.md from the live action manifest.
// Run: npm run codegen:plugin-actions   Verify locally: npm run check:plugin-actions
// CI does not run the check script; the freshness gate is the vitest suite
// src/services/actions/__tests__/pluginActionsDoc.test.ts.
//
// The built-in actions a plugin may dispatch are everything in
// `BUILT_IN_ACTION_IDS` except `DENY_PLUGIN_DISPATCH_ACTION_IDS`, and the args
// and danger tier come from the definitions themselves. Generated rather than
// hand-written for the reason the issue gives: the first real plugin found nine
// of these by reading `src/services/actions/definitions/`, and a hand-kept list
// would rot within a release.
//
// Loaded through Vite's SSR pipeline rather than plain tsx: the registry lives
// in the renderer graph behind the `@/` and `@shared/` aliases, and reaching it
// any other way means reimplementing module resolution.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import type { ActionRegistry, ActionCallbacks } from "../../src/services/actions/actionTypes.js";
import { renderPluginActionsDoc } from "./pluginActionsDoc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_PATH = path.join(ROOT, "docs/plugins/actions.md");

/**
 * The registry only reads these to build closures it never invokes here, so
 * every one is inert. Shaped, not asserted from `{}`, so a new required
 * callback surfaces as a type error rather than as a runtime hole.
 */
function inertCallbacks(): ActionCallbacks {
  const noop = () => {};
  return {
    onOpenSettings: noop,
    onOpenSettingsTab: noop,
    onToggleSidebar: noop,
    onToggleFocusMode: noop,
    onFocusRegionNext: noop,
    onFocusRegionPrev: noop,
    onOpenActionPalette: noop,
    onOpenQuickSwitcher: noop,
    onOpenWorktreePalette: noop,
    onOpenQuickCreatePalette: noop,
    onToggleWorktreeOverview: noop,
    onOpenWorktreeOverview: noop,
    onCloseWorktreeOverview: noop,
    onOpenPanelPalette: noop,
    onOpenResumeSessionsPalette: noop,
    onOpenProjectSwitcherPalette: noop,
    onConfirmCloseActiveProject: noop,
    onOpenShortcuts: noop,
    onLaunchAgent: async () => null,
    onInject: noop,
    onAddTerminal: async () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
  } as unknown as ActionCallbacks;
}

async function loadRegistry(): Promise<ActionRegistry> {
  // A minimal config rather than the repo's own: `vite.config.ts` carries the
  // React plugin and the whole renderer build, none of which this needs, and
  // loading it would make doc generation hostage to a bundler change.
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: "error",
    appType: "custom",
    // No file watcher and no dependency pre-bundling: this process loads one
    // module graph once and exits, so the crawl that makes `vite dev` fast
    // makes this slow instead.
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: {
        "@": path.join(ROOT, "src"),
        "@shared": path.join(ROOT, "shared"),
      },
    },
  });
  // `actionDefinitions` reaches for `self` at module scope; there is no window
  // here to supply it.
  const globals = globalThis as unknown as { self?: unknown };
  globals.self = globalThis;
  try {
    const mod = (await server.ssrLoadModule("/src/services/actions/actionDefinitions.ts")) as {
      createActionDefinitions: (cb: ActionCallbacks, m: Map<unknown, unknown>) => ActionRegistry;
    };
    return mod.createActionDefinitions(inertCallbacks(), new Map());
  } finally {
    await server.close();
  }
}

/**
 * Exits explicitly once the message write completes or fails. The SSR load constructs the
 * renderer's `TerminalInstanceService` singleton, whose reflow heartbeat and
 * reconciliation watchdog arm intervals that outlive `server.close()`, so the
 * process would otherwise never exit on its own.
 */
function finish(stream: NodeJS.WriteStream, message: string, code: number): void {
  stream.write(`${message}\n`, () => process.exit(code));
}

const registry = await loadRegistry();
const expected = renderPluginActionsDoc(registry);
const isCheck = process.argv.includes("--check");

if (isCheck) {
  let actual = "";
  try {
    actual = readFileSync(DOC_PATH, "utf-8");
  } catch {
    // A missing file fails the comparison below.
  }
  if (actual !== expected) {
    finish(
      process.stderr,
      "docs/plugins/actions.md is stale. Run `npm run codegen:plugin-actions` and commit the result.",
      1
    );
  } else {
    finish(process.stdout, "docs/plugins/actions.md is up to date.", 0);
  }
} else {
  mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  writeFileSync(DOC_PATH, expected);
  finish(process.stdout, `Wrote docs/plugins/actions.md (${expected.split("\n").length} lines)`, 0);
}
