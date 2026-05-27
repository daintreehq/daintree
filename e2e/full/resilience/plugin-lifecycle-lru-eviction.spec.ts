import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../../helpers/workflows";

// Plugin lifecycle sync must survive LRU project-view eviction (#9285): a view
// evicted (destroyed) while a plugin is installed/uninstalled must reflect the
// current plugin contribution set once it cold-starts — its mount-time pull is
// the only reconciliation path, since the broadcast fired into a dead view.

const PROJECT_A = "project-A";
const PROJECT_B = "project-B";
const PROJECT_C = "project-C";

// cache=2 over three projects evicts exactly one LRU view per switch — the same
// determinism the core eviction spec relies on.
const CACHE_LIMIT = 2;

const PLUGIN_ID = "e2e.lifecycle";
const ACTION_ID = "e2e.lifecycle.ping";
const ACTION_CONTRIBUTION = {
  id: ACTION_ID,
  title: "Lifecycle ping",
  description: "E2E lifecycle-sync probe action",
  category: "plugin",
  kind: "command",
  danger: "safe",
} as const;

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
let pluginRoot = "";
let pluginDir = "";
let projectIdA = "";
let projectIdC = "";

async function configurePvm(app: AppContext["app"], limit: number): Promise<void> {
  await app.evaluate((_electron, n) => {
    const g = globalThis as Record<string, unknown>;
    const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
    const pvm = getPvm?.() as
      | {
          setCachedViewLimit: (n: number) => void;
          setLowMemoryFreeThresholdMb?: (mb: number | null) => void;
        }
      | null
      | undefined;
    pvm?.setLowMemoryFreeThresholdMb?.(null);
    pvm?.setCachedViewLimit(n);
  }, limit);
}

async function readPvmState(app: AppContext["app"]): Promise<{
  projectIds: string[];
  activeProjectId: string | null;
  viewCount: number;
}> {
  return app.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
    const pvm = getPvm?.() as
      | {
          getAllViews: () => Array<{ projectId: string }>;
          getActiveProjectId: () => string | null;
        }
      | null
      | undefined;
    if (!pvm) return { projectIds: [], activeProjectId: null, viewCount: -1 };
    const views = pvm.getAllViews();
    return {
      projectIds: views.map((v) => v.projectId),
      activeProjectId: pvm.getActiveProjectId(),
      viewCount: views.length,
    };
  });
}

async function requireActiveProjectId(app: AppContext["app"], label: string): Promise<string> {
  const state = await readPvmState(app);
  if (!state.activeProjectId) {
    throw new Error(`[plugin-lru] expected active project id after opening ${label}`);
  }
  return state.activeProjectId;
}

async function evictProjectA(app: AppContext["app"]): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await readPvmState(app);
        return (
          state.activeProjectId === projectIdC &&
          !state.projectIds.includes(projectIdA) &&
          state.viewCount >= 1 &&
          state.viewCount <= CACHE_LIMIT
        );
      },
      { timeout: 15_000, intervals: [200, 400, 800, 1600] }
    )
    .toBe(true);
}

async function loadFixturePlugin(app: AppContext["app"]): Promise<number> {
  return app.evaluate(async (_electron, dir) => {
    const g = globalThis as Record<string, unknown>;
    const load = g.__daintreeE2ELoadPlugin as ((d: string) => Promise<number>) | undefined;
    return load ? load(dir) : -1;
  }, pluginRoot);
}

async function unloadFixturePlugin(app: AppContext["app"]): Promise<void> {
  await app.evaluate(async (_electron, id) => {
    const g = globalThis as Record<string, unknown>;
    const unload = g.__daintreeE2EUnloadPlugin as ((i: string) => Promise<void>) | undefined;
    if (unload) await unload(id);
  }, PLUGIN_ID);
}

async function registerFixtureAction(window: Page): Promise<void> {
  await window.evaluate(
    async ({ pluginId, action }) => {
      const api = (
        window as unknown as {
          electron?: {
            plugin?: { registerAction: (id: string, c: unknown) => Promise<void> };
          };
        }
      ).electron?.plugin;
      if (api) await api.registerAction(pluginId, action);
    },
    { pluginId: PLUGIN_ID, action: ACTION_CONTRIBUTION }
  );
}

async function hasFixtureAction(window: Page): Promise<boolean> {
  return window.evaluate((id) => {
    const fn = (window as unknown as { __daintreeHasAction?: (a: string) => boolean })
      .__daintreeHasAction;
    return fn ? fn(id) : false;
  }, ACTION_ID);
}

test.describe.serial("Full: plugin lifecycle sync survives LRU project-view eviction", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const fixtures = createFixtureRepos(3);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const [repoA, repoB, repoC] = fixtures.map((f) => f.dir);

    // Fixture plugin: a manifest-only plugin (no main entry). The action is
    // registered at runtime via the plugin:actions-register IPC, matching how
    // a plugin contributes actions today.
    pluginRoot = mkdtempSync(join(tmpdir(), "daintree-e2e-plugin-"));
    pluginDir = join(pluginRoot, "lifecycle");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: PLUGIN_ID,
        displayName: "Lifecycle E2E",
        version: "1.0.0",
        engines: { daintree: "*" },
      })
    );

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);
    projectIdA = await requireActiveProjectId(ctx.app, PROJECT_A);

    await configurePvm(ctx.app, CACHE_LIMIT);

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoB, PROJECT_B);
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoC, PROJECT_C);
    projectIdC = await requireActiveProjectId(ctx.app, PROJECT_C);

    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      await unloadFixturePlugin(ctx.app).catch(() => undefined);
      await configurePvm(ctx.app, 5).catch(() => undefined);
      await closeApp(ctx.app);
    }
    for (const cleanup of fixtureCleanups) cleanup();
    if (pluginRoot) rmSync(pluginRoot, { recursive: true, force: true });
  });

  test("a plugin action installed while a view is active survives that view's eviction", async () => {
    test.slow();

    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // Install: load the plugin in main, then register its action (broadcasts to
    // every live view, including the active A).
    expect(await loadFixturePlugin(ctx.app)).toBe(1);
    await registerFixtureAction(ctx.window);
    await expect.poll(() => hasFixtureAction(ctx.window), { timeout: 10_000 }).toBe(true);

    // A→B→C with cache=2 evicts A's WebContentsView.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
    await evictProjectA(ctx.app);

    // Cold-start A: its mount-time pull must return the full action set (the
    // gate on PluginService init makes this race-free), so the action is back.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    await expect.poll(() => hasFixtureAction(ctx.window), { timeout: 10_000 }).toBe(true);
  });

  test("a plugin uninstalled while a view is evicted is gone after the view revives", async () => {
    test.slow();

    // Precondition: plugin loaded with its action present on A (carried from the
    // previous test; re-assert so this test is self-describing).
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    await expect.poll(() => hasFixtureAction(ctx.window), { timeout: 10_000 }).toBe(true);

    // Evict A, then uninstall the plugin while A's view is destroyed — the
    // removal broadcast fires into the live views only, never reaching A.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
    await evictProjectA(ctx.app);
    await unloadFixturePlugin(ctx.app);

    // Revived A must reconcile to the current (empty) set off its pull — the
    // stale action must not linger.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    await expect.poll(() => hasFixtureAction(ctx.window), { timeout: 10_000 }).toBe(false);
  });

  test("a plugin installed while a view is evicted appears after the view revives", async () => {
    test.slow();

    // Precondition: plugin not loaded (uninstalled in the previous test).
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    await expect.poll(() => hasFixtureAction(ctx.window), { timeout: 10_000 }).toBe(false);

    // Evict A, then install the plugin + register its action while A is dead.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
    await evictProjectA(ctx.app);
    expect(await loadFixturePlugin(ctx.app)).toBe(1);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
    await registerFixtureAction(ctx.window);

    // Revived A picks up the install off its mount-time pull.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    await expect.poll(() => hasFixtureAction(ctx.window), { timeout: 10_000 }).toBe(true);
  });
});
