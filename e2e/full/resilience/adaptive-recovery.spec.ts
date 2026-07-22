import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { T_LONG } from "../../helpers/timeouts";

// Exercises ResourceProfileService's adaptive transitions under SYNTHETIC
// pressure. The service normally moves balanced ⇄ performance ⇄ efficiency off
// real memory/thermal/event-loop signals — CI can't reproduce those reliably,
// so the fault-mode hook `__daintreeForceResourceProfile` drives `applyProfile`
// directly. The observable side-effect is the per-profile low-memory floor that
// `applyProfile` fans out to every window's ProjectViewManager, read back via
// the existing `__daintreeGetPvm` accessor. Values mirror RESOURCE_PROFILE_CONFIGS
// (shared/types/resourceProfile.ts): performance→null, balanced→768, efficiency→1024.

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];

type ResourceProfile = "performance" | "balanced" | "efficiency";

async function forceProfile(app: AppContext["app"], profile: ResourceProfile): Promise<void> {
  await app.evaluate((_electron, p) => {
    const g = globalThis as Record<string, unknown>;
    const force = g.__daintreeForceResourceProfile as ((x: string) => void) | undefined;
    if (!force) throw new Error("__daintreeForceResourceProfile not present");
    force(p);
  }, profile);
}

async function readLowMemoryFloor(app: AppContext["app"]): Promise<number | null> {
  return app.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
    const pvm = getPvm?.() as
      { getLowMemoryFreeThresholdMb: () => number | null } | null | undefined;
    return pvm?.getLowMemoryFreeThresholdMb() ?? null;
  });
}

// The ResourceProfileService is created by a deferred init task, so the hook may
// throw until it settles. Poll the first force call until it lands, then assert.
async function waitUntilProfileForceable(app: AppContext["app"]): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await forceProfile(app, "balanced");
          return true;
        } catch {
          return false;
        }
      },
      { timeout: T_LONG, intervals: [200, 400, 800] }
    )
    .toBe(true);
}

test.describe.serial("Resilience: adaptive resource-profile recovery", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const [repo] = createFixtureRepos(1);
    fixtureCleanups = [repo.cleanup];
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "adaptive-project");
    await waitUntilProfileForceable(ctx.app);
  });

  test.afterAll(async () => {
    // Restore the default profile so a leaked efficiency floor doesn't bleed
    // into any later spec sharing the runner.
    if (ctx?.app) {
      await forceProfile(ctx.app, "balanced").catch(() => undefined);
      await closeApp(ctx.app);
    }
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("efficiency entry arms the low-memory floor on the active window's PVM", async () => {
    await forceProfile(ctx.app, "efficiency");
    expect(await readLowMemoryFloor(ctx.app)).toBe(1024);
  });

  test("upgrading out of efficiency releases the stricter floor", async () => {
    // efficiency → performance must clear the floor entirely (null), proving the
    // exit branch in applyProfile runs and isn't left stuck at the strict value.
    await forceProfile(ctx.app, "efficiency");
    expect(await readLowMemoryFloor(ctx.app)).toBe(1024);

    await forceProfile(ctx.app, "performance");
    expect(await readLowMemoryFloor(ctx.app)).toBeNull();
  });

  test("each profile pushes its own configured floor", async () => {
    await forceProfile(ctx.app, "balanced");
    expect(await readLowMemoryFloor(ctx.app)).toBe(768);

    await forceProfile(ctx.app, "performance");
    expect(await readLowMemoryFloor(ctx.app)).toBeNull();

    await forceProfile(ctx.app, "efficiency");
    expect(await readLowMemoryFloor(ctx.app)).toBe(1024);
  });
});
