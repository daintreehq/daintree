import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../../helpers/workflows";
import { T_LONG } from "../../helpers/timeouts";

// Three projects with cache=2 — the same shape as the LRU eviction spec.
// A→B→C cycles deterministically evict A as LRU when C loads, so we can
// observe both the cached-warm path (B) and the cold-restore path (A) without
// CI memory pressure being able to collapse the cache below the user limit.
const PROJECT_A = "plugin-A";
const PROJECT_B = "plugin-B";
const PROJECT_C = "plugin-C";
const CACHE_LIMIT = 2;

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
let projectIdA = "";

interface PluginSnapshot {
  pluginNames: string[];
  actionIds: string[];
  panelKindIds: string[];
  toolbarButtonIds: string[];
}

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
    // Same low-memory-cap disable as the LRU spec: a CI collapse to 1 would
    // make A→B→C eviction non-deterministic and let the cache hide bugs.
    pvm?.setLowMemoryFreeThresholdMb?.(null);
    pvm?.setCachedViewLimit(n);
  }, limit);
}

async function readPvmProjectIds(app: AppContext["app"]): Promise<{
  activeProjectId: string | null;
  projectIds: string[];
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
    if (!pvm) return { activeProjectId: null, projectIds: [] };
    return {
      activeProjectId: pvm.getActiveProjectId(),
      projectIds: pvm.getAllViews().map((v) => v.projectId),
    };
  });
}

async function requireActiveProjectId(app: AppContext["app"], label: string): Promise<string> {
  const { activeProjectId } = await readPvmProjectIds(app);
  if (!activeProjectId) {
    throw new Error(`[plugin-lifecycle] expected active project id after opening ${label}`);
  }
  return activeProjectId;
}

async function waitForProjectAEvicted(app: AppContext["app"]): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await readPvmProjectIds(app);
        return !state.projectIds.includes(projectIdA);
      },
      {
        timeout: 15_000,
        intervals: [200, 400, 800, 1600],
      }
    )
    .toBe(true);
}

// Reads the plugin contribution snapshot the renderer would mount against:
// the four shapes the main process broadcasts (list, actions, panel kinds,
// toolbar buttons). Ids are sorted so equality comparisons across views
// aren't sensitive to enumeration order.
async function readPluginSnapshot(window: Page): Promise<PluginSnapshot> {
  return window.evaluate(async () => {
    const api = (
      window as unknown as {
        electron?: {
          plugin?: {
            list: () => Promise<Array<{ name: string }>>;
            getActions: () => Promise<Array<{ id: string }>>;
            getPanelKinds: () => Promise<Array<{ id: string }>>;
            toolbarButtons: () => Promise<Array<{ id: string }>>;
          };
        };
      }
    ).electron?.plugin;
    if (!api) {
      throw new Error("window.electron.plugin is not exposed");
    }
    const [plugins, actions, kinds, buttons] = await Promise.all([
      api.list(),
      api.getActions(),
      api.getPanelKinds(),
      api.toolbarButtons(),
    ]);
    return {
      pluginNames: plugins.map((p) => p.name).sort(),
      actionIds: actions.map((a) => a.id).sort(),
      panelKindIds: kinds.map((k) => k.id).sort(),
      toolbarButtonIds: buttons.map((b) => b.id).sort(),
    };
  });
}

test.describe.serial("Core: plugin lifecycle across project views and LRU restore", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const fixtures = createFixtureRepos(3);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const [repoA, repoB, repoC] = fixtures.map((f) => f.dir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);
    projectIdA = await requireActiveProjectId(ctx.app, PROJECT_A);

    await configurePvm(ctx.app, CACHE_LIMIT);

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoB, PROJECT_B);
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoC, PROJECT_C);

    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      await configurePvm(ctx.app, 5).catch(() => undefined);
      await closeApp(ctx.app);
    }
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("plugin snapshot is identical across the three views", async () => {
    test.slow();

    // Active = A. Read its snapshot first.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    const snapshotA = await readPluginSnapshot(ctx.window);

    // Switch to B (a previously-active, now-cached view becomes active again)
    // and assert the snapshot matches. Warm reactivation does not remount the
    // renderer, so this exercises the persistent listener path, not pull-on-
    // mount — they must converge on the same set.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    const snapshotB = await readPluginSnapshot(ctx.window);

    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
    const snapshotC = await readPluginSnapshot(ctx.window);

    expect(snapshotB).toEqual(snapshotA);
    expect(snapshotC).toEqual(snapshotA);
  });

  test("cold-restored view sees the same plugin snapshot as its peers", async () => {
    test.slow();

    // Force A→B→C so A is evicted as the LRU view.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);

    await waitForProjectAEvicted(ctx.app);

    // C is still active and was never evicted — its snapshot is the
    // authoritative reference for what the cold-restored view must observe.
    const snapshotC = await readPluginSnapshot(ctx.window);

    // Cold-restore A: a fresh WebContentsView is created, the renderer mounts,
    // pull-on-mount + the targeted pushSnapshotTo (the #9285 fix) populate the
    // hook state. The pull is gated on waitForInit() and the push is the
    // belt-and-suspenders for views that mount before activation settles.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    await expect
      .poll(() => readPluginSnapshot(ctx.window), {
        timeout: T_LONG,
        intervals: [200, 400, 800, 1600],
      })
      .toEqual(snapshotC);
  });
});
