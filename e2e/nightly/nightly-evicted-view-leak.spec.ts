import { test, expect } from "@playwright/test";
import path from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../helpers/workflows";
import {
  parseHeapSnapshot,
  countInstancesByName,
  cleanupHeapSnapshot,
} from "../helpers/heapSnapshot";

const PROJECT_A = "Heap A";
const PROJECT_B = "Heap B";

// Class names whose instance counts we log diagnostically. These are real
// main-process ES6 classes — TypeScript interfaces (e.g. `ViewEntry`) are
// erased at compile time and never appear in a heap snapshot. PortalManager
// and EventBuffer are per-window services (not per-view), so their counts
// are NOT expected to drop on view eviction; they're logged for trend
// monitoring rather than gating the test.
const DIAGNOSTIC_CLASS_NAMES = ["ProjectViewManager", "PortalManager", "EventBuffer"];

let ctx: AppContext;
let snapshotPath: string;

test.describe.serial("Nightly: Evicted project view leak detection", () => {
  test.beforeAll(async () => {
    const [repoA, repoB] = createFixtureRepos(2);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoB, PROJECT_B);
    // Switch back to A so A is the active project; B will be the cached view
    // that we capture and watch for proper destruction after eviction.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    snapshotPath = path.join(tmpdir(), `daintree-evicted-view-${Date.now()}.heapsnapshot`);
  });

  test.afterAll(async () => {
    if (snapshotPath) cleanupHeapSnapshot(snapshotPath);
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("evicted project view is destroyed and removed from PVM cache", async () => {
    test.setTimeout(180_000);
    const { app } = ctx;

    const initial = await app.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
      const pvm = getPvm?.() as
        | {
            getAllViews: () => Array<{
              view: { webContents: { id: number; isDestroyed: () => boolean } };
              projectId: string;
              state: string;
            }>;
            getActiveProjectId: () => string | null;
            setCachedViewLimit: (n: number) => void;
          }
        | null
        | undefined;
      if (!pvm) return null;
      return {
        activeProjectId: pvm.getActiveProjectId(),
        views: pvm.getAllViews().map((v) => ({
          projectId: v.projectId,
          wcId: v.view.webContents.id,
          state: v.state,
        })),
      };
    });

    expect(initial).not.toBeNull();
    expect(initial!.views.length).toBeGreaterThanOrEqual(2);
    const activeId = initial!.activeProjectId;
    expect(activeId).not.toBeNull();
    const activeView = initial!.views.find((v) => v.projectId === activeId);
    const cachedView = initial!.views.find((v) => v.projectId !== activeId);
    expect(activeView).toBeDefined();
    expect(cachedView).toBeDefined();
    const evictedWcId = cachedView!.wcId;
    console.log(
      `[evicted-view] active=${activeId} (wc=${activeView!.wcId}), evicting target wc=${evictedWcId} (project=${cachedView!.projectId})`
    );

    await app.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
      const pvm = getPvm?.() as { setCachedViewLimit: (n: number) => void } | null | undefined;
      pvm?.setCachedViewLimit(1);
    });

    // Poll until eviction completes. webContents.close() can be slower on
    // loaded CI runners — a fixed sleep races there. Re-read state until the
    // evicted view is gone or we hit a meaningful timeout.
    const readEvictionState = () =>
      app.evaluate(({ webContents }, wcId) => {
        const g = globalThis as Record<string, unknown>;
        const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
        const pvm = getPvm?.() as
          | {
              getAllViews: () => Array<{
                view: { webContents: { id: number; isDestroyed: () => boolean } };
                projectId: string;
              }>;
            }
          | null
          | undefined;
        const evicted = webContents.fromId(wcId);
        return {
          viewCount: pvm?.getAllViews().length ?? -1,
          viewProjectIds: pvm?.getAllViews().map((v) => v.projectId) ?? [],
          evictedIsNullOrDestroyed: !evicted || evicted.isDestroyed(),
        };
      }, evictedWcId);

    await expect
      .poll(readEvictionState, { timeout: 10_000, intervals: [200, 400, 800, 1600] })
      .toMatchObject({ viewCount: 1, evictedIsNullOrDestroyed: true });

    const afterEviction = await readEvictionState();
    console.log(
      `[evicted-view] after eviction: viewCount=${afterEviction.viewCount}, projectIds=${JSON.stringify(afterEviction.viewProjectIds)}, evicted destroyed=${afterEviction.evictedIsNullOrDestroyed}`
    );
    expect(afterEviction.viewProjectIds).toContain(activeId);
  });

  test("main-process heap snapshot parses and surfaces diagnostic counts", async () => {
    test.setTimeout(180_000);
    const { app } = ctx;

    // Force a GC pass before the snapshot to drop unreferenced eviction state.
    await app.evaluate(async () => {
      const g = globalThis as unknown as Record<string, unknown>;
      const gcFn = (typeof g.__daintree_gc === "function" ? g.__daintree_gc : g.gc) as
        | (() => void)
        | undefined;
      if (gcFn) {
        gcFn();
        await new Promise((r) => setTimeout(r, 100));
      }
    });

    // Capture the runtime constructor name of PVM. Production builds minify
    // class identifiers (esbuild --minify), so the heap snapshot stores the
    // mangled name rather than "ProjectViewManager". Reading constructor.name
    // from a live instance gives us whatever name V8 will write, regardless
    // of minification.
    const pvmRuntimeName = await app.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const pvm = (g.__daintreeGetPvm as (() => unknown) | undefined)?.();
      return (pvm as { constructor?: { name?: string } })?.constructor?.name ?? null;
    });
    console.log(`[evicted-view][heap] PVM runtime constructor name: ${pvmRuntimeName}`);

    await app.evaluate((_electron, target) => {
      const g = globalThis as Record<string, unknown>;
      const writer = g.__daintreeWriteHeapSnapshot as ((p: string) => void) | undefined;
      if (!writer) throw new Error("__daintreeWriteHeapSnapshot is not registered");
      writer(target);
    }, snapshotPath);

    expect(existsSync(snapshotPath)).toBe(true);

    const snapshot = parseHeapSnapshot(snapshotPath);

    // Sanity: the snapshot must be a valid V8 heap snapshot with the expected
    // shape. If parsing yields an empty/garbage object, fail loudly so a
    // future Electron upgrade that changes the snapshot schema is noticed.
    // Run schema checks before the diagnostic loop so the failure points at
    // the schema, not the lookup.
    expect(snapshot.snapshot.meta.node_fields).toContain("type");
    expect(snapshot.snapshot.meta.node_fields).toContain("name");
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(snapshot.strings.length).toBeGreaterThan(0);

    for (const className of DIAGNOSTIC_CLASS_NAMES) {
      const count = countInstancesByName(snapshot, className);
      console.log(`[evicted-view][heap] ${className}: ${count} instances`);
    }

    // ProjectViewManager is a per-window singleton — its instance count
    // should be exactly 1 in single-window E2E runs. We look it up by the
    // runtime constructor name to stay correct under production minification.
    // Asserting truthiness first ensures the hook working correctly is a
    // hard requirement of the test rather than a best-effort skip — a falsy
    // value (null, "", undefined) would otherwise silently pass.
    expect(pvmRuntimeName).toBeTruthy();
    const pvmCount = countInstancesByName(snapshot, pvmRuntimeName!);
    console.log(`[evicted-view][heap] PVM (${pvmRuntimeName}): ${pvmCount} instances`);
    expect(pvmCount).toBe(1);
  });
});
