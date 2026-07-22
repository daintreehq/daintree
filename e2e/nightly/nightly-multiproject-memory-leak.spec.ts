import { test, expect } from "@playwright/test";
import path from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../helpers/workflows";
import { measureMainMemory } from "../helpers/stress";
import {
  parseHeapSnapshot,
  countInstancesByName,
  cleanupHeapSnapshot,
} from "../helpers/heapSnapshot";

// Simulates the reported pain: many projects open, switched between rapidly.
// Each project is a separate WebContentsView (renderer process). With the
// cache limit pinned below the project count, every round-robin sweep forces
// the LRU to evict and cold-start renderers — the exact create/destroy churn
// suspected of leaking. Asserts the MAIN process does NOT accumulate memory or
// view entries, AND that evicted renderers are actually destroyed (not leaked
// as live processes, which main's JS heap alone would not reflect).

const PROJECT_COUNT = 6;
// Pin below PROJECT_COUNT so each sweep guarantees eviction + cold-start churn,
// and disable the low-memory override so residency is deterministic regardless
// of host memory pressure (mirrors nightly-evicted-view-leak.spec.ts).
const CACHE_LIMIT = 2;
const WARMUP_SWEEPS = 2;
const MEASURED_SWEEPS = 5;
// Main-process heap should be flat across switches — renderers are separate
// processes that are destroyed on eviction, so churn must not grow main's heap.
// A real per-switch leak over MEASURED_SWEEPS*PROJECT_COUNT (30) switches would
// dwarf this; the bound catches anything above ~1MB retained per switch.
const MAIN_HEAP_GROWTH_THRESHOLD_MB = 35;

const PROJECT_NAMES = Array.from(
  { length: PROJECT_COUNT },
  (_, i) => `project-${String.fromCharCode(65 + i)}`
);

interface PvmState {
  activeProjectId: string | null;
  viewCount: number;
  states: string[];
  wcIds: number[];
}

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
let snapshotBaselinePath: string;
let snapshotFinalPath: string;

async function readPvm(app: AppContext["app"]): Promise<PvmState | null> {
  return app.evaluate(() => {
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
        }
      | null
      | undefined;
    if (!pvm) return null;
    const views = pvm.getAllViews();
    return {
      activeProjectId: pvm.getActiveProjectId(),
      viewCount: views.length,
      states: views.map((v) => v.state),
      wcIds: views
        .filter((v) => !v.view.webContents.isDestroyed())
        .map((v) => v.view.webContents.id),
    };
  });
}

async function countAliveRenderers(app: AppContext["app"], ids: number[]): Promise<number> {
  return app.evaluate(({ webContents }, wcIds) => {
    return wcIds.filter((id) => {
      const wc = webContents.fromId(id);
      return !!wc && !wc.isDestroyed();
    }).length;
  }, ids);
}

async function writeSnapshot(app: AppContext["app"], target: string): Promise<void> {
  await app.evaluate((_electron, p) => {
    const g = globalThis as Record<string, unknown>;
    const writer = g.__daintreeWriteHeapSnapshot as ((path: string) => void) | undefined;
    if (!writer) throw new Error("__daintreeWriteHeapSnapshot is not registered");
    writer(p);
  }, target);
}

async function pvmRuntimeName(app: AppContext["app"]): Promise<string | null> {
  return app.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const pvm = (g.__daintreeGetPvm as (() => unknown) | undefined)?.();
    return (pvm as { constructor?: { name?: string } })?.constructor?.name ?? null;
  });
}

test.describe.serial("Nightly: Multi-project switching memory leak", () => {
  test.beforeAll(async () => {
    const fixtures = createFixtureRepos(PROJECT_COUNT);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const dirs = fixtures.map((f) => f.dir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dirs[0], PROJECT_NAMES[0]);

    // Deterministic eviction: fixed cache limit, no host-pressure override.
    await ctx.app.evaluate((_electron, limit) => {
      const g = globalThis as Record<string, unknown>;
      const pvm = (g.__daintreeGetPvm as (() => unknown) | undefined)?.() as
        | {
            setCachedViewLimit: (n: number) => void;
            setLowMemoryFreeThresholdMb?: (n: number | null) => void;
          }
        | null
        | undefined;
      pvm?.setLowMemoryFreeThresholdMb?.(null);
      pvm?.setCachedViewLimit(limit);
    }, CACHE_LIMIT);

    // Register the remaining projects in the switcher (each add also switches).
    for (let i = 1; i < PROJECT_COUNT; i++) {
      ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, dirs[i], PROJECT_NAMES[i]);
    }

    snapshotBaselinePath = path.join(
      tmpdir(),
      `daintree-mp-leak-baseline-${Date.now()}.heapsnapshot`
    );
    snapshotFinalPath = path.join(tmpdir(), `daintree-mp-leak-final-${Date.now()}.heapsnapshot`);
  });

  test.afterAll(async () => {
    if (snapshotBaselinePath) cleanupHeapSnapshot(snapshotBaselinePath);
    if (snapshotFinalPath) cleanupHeapSnapshot(snapshotFinalPath);
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("main-process memory and view residency stay bounded across many switches", async () => {
    test.setTimeout(600_000);
    const { app } = ctx;

    // Preconditions — a leak spec must fail loudly if its instruments are
    // missing rather than silently passing with degraded checks.
    const env = await app.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const gcAvailable =
        typeof g.__daintree_gc === "function" || typeof (g as { gc?: unknown }).gc === "function";
      const pvm = (g.__daintreeGetPvm as (() => unknown) | undefined)?.() as
        { getCacheConfig?: () => { maxCachedViews: number } } | null | undefined;
      return {
        gcAvailable,
        snapshotAvailable: typeof g.__daintreeWriteHeapSnapshot === "function",
        cacheLimit: pvm?.getCacheConfig?.().maxCachedViews ?? null,
      };
    });
    // Forced GC is what turns the heap delta into a real retained-memory signal.
    expect(env.gcAvailable).toBe(true);
    expect(env.snapshotAvailable).toBe(true);
    // The deterministic-churn premise: the cap must actually be pinned.
    expect(env.cacheLimit).toBe(CACHE_LIMIT);

    // Every distinct project-view renderer created during the run. Cold starts
    // mint a fresh webContents id each time an evicted project is reopened, so
    // this set grows with churn and lets us prove evicted renderers were torn
    // down — a signal main's JS heap cannot give.
    const seenProjectWcIds = new Set<number>();
    const sweep = async () => {
      for (const name of PROJECT_NAMES) {
        ctx.window = await selectExistingProjectAndRefresh(app, ctx.window, name);
        const s = await readPvm(app);
        s?.wcIds.forEach((id) => seenProjectWcIds.add(id));
      }
    };

    // Warm up: reach steady state (JIT, caches, first-cold-start allocations)
    // before sampling so the baseline isn't inflated by one-time costs.
    for (let s = 0; s < WARMUP_SWEEPS; s++) await sweep();

    // Capture the baseline snapshot BEFORE measuring baseline memory so the
    // snapshot writer's own allocations land in the baseline rather than being
    // charged to the switch loop as growth.
    const runtimeName = await pvmRuntimeName(app);
    await writeSnapshot(app, snapshotBaselinePath);
    const baseline = await measureMainMemory(app, { forceGc: true });
    const baselinePvm = await readPvm(app);

    // The churn: round-robin across every project, repeatedly. With CACHE_LIMIT
    // below PROJECT_COUNT, most of these switches are evict + cold-start.
    for (let s = 0; s < MEASURED_SWEEPS; s++) {
      await sweep();
      const mid = await measureMainMemory(app, { forceGc: false });
      console.log(
        `[mp-leak] sweep ${s + 1}/${MEASURED_SWEEPS} heapUsed=${(mid.heapUsed / 1e6).toFixed(1)}MB rss=${(mid.rss / 1e6).toFixed(1)}MB`
      );
    }

    // Cold-start eviction is deferred (setImmediate), so the LRU may not have
    // trimmed the just-cold-started view yet. Poll until residency settles to
    // the cap before sampling, so the asserted bound is the real invariant
    // (CACHE_LIMIT, active view included) rather than a race window.
    await expect
      .poll(async () => (await readPvm(app))?.viewCount ?? -1, {
        timeout: 15_000,
        intervals: [200, 400, 800, 1600],
      })
      .toBeLessThanOrEqual(CACHE_LIMIT);

    const final = await measureMainMemory(app, { forceGc: true });
    const finalPvm = await readPvm(app);
    await writeSnapshot(app, snapshotFinalPath);

    // webContents.close() is async, so a just-evicted renderer may still report
    // alive immediately after the PVM map is trimmed. Poll until the destroyed
    // renderers actually die (mirrors nightly-evicted-view-leak.spec.ts).
    await expect
      .poll(async () => countAliveRenderers(app, Array.from(seenProjectWcIds)), {
        timeout: 15_000,
        intervals: [200, 400, 800, 1600],
      })
      .toBeLessThanOrEqual(CACHE_LIMIT);
    const aliveRenderers = await countAliveRenderers(app, Array.from(seenProjectWcIds));

    const totalSwitches = (WARMUP_SWEEPS + MEASURED_SWEEPS) * PROJECT_COUNT;
    const heapGrowthMB = (final.heapUsed - baseline.heapUsed) / 1e6;
    const rssGrowthMB = (final.rss - baseline.rss) / 1e6;
    console.log(
      `[mp-leak] switches=${totalSwitches} heapGrowth=${heapGrowthMB.toFixed(1)}MB rssGrowth=${rssGrowthMB.toFixed(1)}MB ` +
        `perSwitchHeap=${(heapGrowthMB / (MEASURED_SWEEPS * PROJECT_COUNT)).toFixed(2)}MB`
    );
    console.log(
      `[mp-leak] baseline views=${baselinePvm?.viewCount} states=${JSON.stringify(baselinePvm?.states)}; ` +
        `final views=${finalPvm?.viewCount} states=${JSON.stringify(finalPvm?.states)}`
    );
    console.log(
      `[mp-leak] distinct project renderers created=${seenProjectWcIds.size}, still alive=${aliveRenderers}`
    );

    // 0. Sanity: the scenario actually exercised eviction churn. Cold starts
    //    mint fresh ids, so the distinct-renderer count must exceed the cap —
    //    otherwise nothing was evicted and the test proves nothing.
    expect(seenProjectWcIds.size).toBeGreaterThan(CACHE_LIMIT);

    // 1. View residency is bounded by the cache policy, NOT by how many
    //    projects were switched through. The cap counts the active view, so the
    //    settled bound is CACHE_LIMIT (no +1 headroom once eviction has run).
    expect(finalPvm).not.toBeNull();
    expect(finalPvm!.viewCount).toBeLessThanOrEqual(CACHE_LIMIT);

    // 2. Evicted renderers are genuinely destroyed, not leaked as live
    //    processes. Live project renderers must not exceed the residency cap.
    expect(aliveRenderers).toBeLessThanOrEqual(CACHE_LIMIT);

    // 3. Main-process heap does not accumulate with switch count. A per-project
    //    or per-switch leak in main would grow this monotonically across the
    //    measured switches; a flat post-GC heap means churn is reclaimed.
    expect(heapGrowthMB).toBeLessThan(MAIN_HEAP_GROWTH_THRESHOLD_MB);

    // 4. The view manager itself is a per-window singleton — switching must not
    //    duplicate it. Counted by runtime constructor name so it holds under
    //    production minification (esbuild mangles class names).
    expect(runtimeName).toBeTruthy();
    expect(existsSync(snapshotBaselinePath)).toBe(true);
    expect(existsSync(snapshotFinalPath)).toBe(true);
    const baseSnap = parseHeapSnapshot(snapshotBaselinePath);
    const finalSnap = parseHeapSnapshot(snapshotFinalPath);
    const basePvmCount = countInstancesByName(baseSnap, runtimeName!);
    const finalPvmCount = countInstancesByName(finalSnap, runtimeName!);
    console.log(
      `[mp-leak] PVM (${runtimeName}) instances baseline=${basePvmCount} final=${finalPvmCount}`
    );
    expect(finalPvmCount).toBe(1);
    expect(finalPvmCount).toBe(basePvmCount);
  });
});
