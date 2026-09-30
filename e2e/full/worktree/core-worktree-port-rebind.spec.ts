import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_LONG } from "../../helpers/timeouts";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import path from "path";

const PROJECT_A = "project-A";
const PROJECT_B = "project-B";
const PROJECT_C = "project-C";

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
let repoA = "";
let repoB = "";
let repoC = "";
let projectIdA = "";
let projectIdB = "";
let projectIdC = "";

/**
 * Force the PVM's cached-view limit to a specific value via the E2E-only
 * `__daintreeGetPvm` accessor. Also disables the low-memory override so the
 * ResourceProfileService can't clamp the cache and undermine eviction
 * preconditions on loaded CI runners.
 */
async function setPvmCacheLimit(app: AppContext["app"], limit: number): Promise<void> {
  await app.evaluate((_e, n) => {
    const g = globalThis as Record<string, unknown>;
    const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
    const pvm = getPvm?.() as
      | {
          setCachedViewLimit: (n: number) => void;
          setLowMemoryFreeThresholdMb?: (n: number | null) => void;
        }
      | null
      | undefined;
    if (!pvm) {
      throw new Error("[port-rebind] __daintreeGetPvm not available — E2E accessor not wired");
    }
    pvm.setLowMemoryFreeThresholdMb?.(null);
    pvm.setCachedViewLimit(n);
  }, limit);
}

interface PvmSnapshot {
  activeProjectId: string | null;
  viewProjectIds: string[];
}

async function readPvmSnapshot(app: AppContext["app"]): Promise<PvmSnapshot> {
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
    if (!pvm) {
      throw new Error("[port-rebind] __daintreeGetPvm not available — E2E accessor not wired");
    }
    return {
      activeProjectId: pvm.getActiveProjectId(),
      viewProjectIds: pvm.getAllViews().map((v) => v.projectId),
    };
  });
}

async function ensureAllProjectViewsRegistered(): Promise<void> {
  let lastSnapshot: PvmSnapshot | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await setPvmCacheLimit(ctx.app, 4);

    // If CI pressure already evicted a setup view, rebuild the precondition by
    // cold-loading each known project once under the widened cache limit.
    for (const projectName of [PROJECT_A, PROJECT_B, PROJECT_C]) {
      ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, projectName);
      await setPvmCacheLimit(ctx.app, 4);
    }

    try {
      await expect
        .poll(
          async () => {
            lastSnapshot = await readPvmSnapshot(ctx.app);
            return lastSnapshot.viewProjectIds.length;
          },
          { timeout: 15_000, intervals: [200, 400, 800, 1600] }
        )
        .toBeGreaterThanOrEqual(3);
      return;
    } catch {
      // Retry the rebuild loop; throw a diagnostic snapshot after the final
      // attempt so remote failures explain which views survived.
    }
  }

  throw new Error(
    `[port-rebind] expected 3 registered project views after setup, got ${JSON.stringify(lastSnapshot)}`
  );
}

test.describe.serial("Core: Worktree Port Rebinding", () => {
  test.beforeAll(async () => {
    // beforeAll opens 3 projects and runs several project switches through
    // refreshActiveWindow, which uses adaptive timeouts (20s local, 30s CI,
    // 60s Windows CI) per operation. Widen explicitly to avoid the default
    // 120s hook budget on slower / CI machines.
    test.setTimeout(300_000);

    const fixtures = createFixtureRepos(3);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    [repoA, repoB, repoC] = fixtures.map((f) => f.dir);

    ctx = await launchApp();

    // Pin the cached-view limit to 4 so all three project views stay live
    // during Test 1 (cached path). Test 2 lowers it to 1 to force eviction.
    await setPvmCacheLimit(ctx.app, 4);

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);
    projectIdA = (await readPvmSnapshot(ctx.app)).activeProjectId ?? "";
    expect(projectIdA).not.toBe("");

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoB, PROJECT_B);
    projectIdB = (await readPvmSnapshot(ctx.app)).activeProjectId ?? "";
    expect(projectIdB).not.toBe("");

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoC, PROJECT_C);
    projectIdC = (await readPvmSnapshot(ctx.app)).activeProjectId ?? "";
    expect(projectIdC).not.toBe("");

    await ensureAllProjectViewsRegistered();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("cached project view picks up external git changes on reactivation", async () => {
    test.setTimeout(180_000);
    const { app } = ctx;

    // Switch away from C so its view is cached (limit=4 keeps all live).
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // Confirm C is still registered (cached, not evicted) and A is now active.
    // Pins this test to the cached-reactivation path it claims to cover —
    // without this, a stray eviction would silently pivot the test to a cold
    // load.
    const snap = await readPvmSnapshot(app);
    expect(snap.activeProjectId).toBe(projectIdA);
    expect(snap.viewProjectIds).toContain(projectIdC);

    writeFileSync(path.join(repoC, "rebind-cached-c1.txt"), "c1\n");
    execSync('git add -A && git commit -m "external-commit-c1"', {
      cwd: repoC,
      stdio: "ignore",
    });

    // Switch back to C — cached reactivation re-brokers the port synchronously
    // inside activateProjectView (electron/ipc/handlers/project/switch.ts).
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);

    const mainCard = ctx.window.locator(SEL.worktree.mainCard);
    await expect(mainCard).toBeVisible({ timeout: T_LONG });
    await expect(mainCard).toContainText("external-commit-c1", { timeout: T_LONG });
    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Cached reactivation should see clean state after external commit",
      })
      .not.toContain("has uncommitted changes");

    // Second external change WITHOUT another switch — proves the rebound port
    // is durable, not a one-shot wake.
    writeFileSync(path.join(repoC, "rebind-cached-c2.txt"), "c2\n");

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Live port should detect a second external change without re-switching",
      })
      .toContain("has uncommitted changes");
  });

  test("evicted project view picks up external git changes on cold reload", async () => {
    test.setTimeout(180_000);
    const { app } = ctx;

    // Force eviction of all non-active views by shrinking the cache to 1.
    // evictStaleViews fires synchronously inside setCachedViewLimit.
    await setPvmCacheLimit(app, 1);

    // Poll until only the active view (C) remains.
    await expect
      .poll(async () => (await readPvmSnapshot(app)).viewProjectIds.length, {
        timeout: 10_000,
        intervals: [200, 400, 800],
      })
      .toBe(1);

    writeFileSync(path.join(repoB, "rebind-evicted-b1.txt"), "b1\n");
    execSync('git add -A && git commit -m "external-commit-b1"', {
      cwd: repoB,
      stdio: "ignore",
    });

    // Switch to B — its view was evicted, so this is a cold load (isNew:true).
    // `did-finish-load` triggers `onViewReady` → `brokerPort(host, wc)` in
    // electron/main.ts; the new port carries the post-mutation git state.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);

    const mainCard = ctx.window.locator(SEL.worktree.mainCard);
    await expect(mainCard).toBeVisible({ timeout: T_LONG });
    await expect(mainCard).toContainText("external-commit-b1", { timeout: T_LONG });
    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Cold-loaded view should see clean state after external commit",
      })
      .not.toContain("has uncommitted changes");

    // Second external change WITHOUT another switch — proves the cold-load
    // port is durable too, not just a startup snapshot.
    writeFileSync(path.join(repoB, "rebind-evicted-b2.txt"), "b2\n");

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Cold-loaded port should detect a second external change without re-switching",
      })
      .toContain("has uncommitted changes");
  });

  test("cross-project isolation: each view sees only its own git state", async () => {
    test.setTimeout(180_000);
    const { app } = ctx;

    // Restore the cache so this test exercises isolation without further
    // eviction. Test 2's setCachedViewLimit(1) evicted A; the upcoming switch
    // to A is therefore a cold load (isNew:true), while the round-trip back
    // to B hits the cached path. Both port-rebind paths are covered here.
    await setPvmCacheLimit(app, 4);

    // Test 2 left B with an uncommitted file (rebind-evicted-b2.txt). Commit
    // it externally so B's card returns to a clean state showing the latest
    // commit message — the WorktreeCard text swaps to file-count + relative
    // time while dirty, so `toContainText(commit)` only works on a clean card.
    execSync('git add -A && git commit -m "external-commit-b2"', {
      cwd: repoB,
      stdio: "ignore",
    });

    const mainCardB = ctx.window.locator(SEL.worktree.mainCard);
    await expect(mainCardB).toBeVisible({ timeout: T_LONG });
    await expect(mainCardB).toContainText("external-commit-b2", { timeout: T_LONG });
    // B must never have surfaced project C's earlier commit.
    await expect(mainCardB).not.toContainText("external-commit-c1");

    // Switch to A, externally commit on A, then return to B and confirm B's
    // card never picked up A's change.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    writeFileSync(path.join(repoA, "rebind-isolation-a1.txt"), "a1\n");
    execSync('git add -A && git commit -m "external-commit-a1"', {
      cwd: repoA,
      stdio: "ignore",
    });

    // A's own card must reflect A's commit — proves A's port is wired to A's
    // WorkspaceClient, not contaminated by any other view.
    const mainCardA = ctx.window.locator(SEL.worktree.mainCard);
    await expect(mainCardA).toBeVisible({ timeout: T_LONG });
    await expect(mainCardA).toContainText("external-commit-a1", { timeout: T_LONG });

    // Switch back to B. Its card must still show its own most-recent commit
    // ("external-commit-b2") and must never have picked up A's commit.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);

    const mainCardBAfter = ctx.window.locator(SEL.worktree.mainCard);
    await expect(mainCardBAfter).toBeVisible({ timeout: T_LONG });
    await expect(mainCardBAfter).toContainText("external-commit-b2", { timeout: T_LONG });
    await expect(mainCardBAfter).not.toContainText("external-commit-a1");

    // Live-port durability: write an external file to B AFTER returning to it
    // and assert B's card flips to dirty. This proves B's rebound live port
    // delivers B-specific events post-round-trip — not just that the static
    // snapshot is correct.
    writeFileSync(path.join(repoB, "rebind-isolation-b3.txt"), "b3\n");

    await expect
      .poll(() => mainCardBAfter.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Project B's live port must deliver B-specific events after the round-trip",
      })
      .toContain("has uncommitted changes");
  });
});
