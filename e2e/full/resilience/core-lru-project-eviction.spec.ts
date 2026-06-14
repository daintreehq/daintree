import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  addAndSwitchToProject,
  selectExistingProjectAndRefresh,
  spawnTerminalAndVerify,
} from "../../helpers/workflows";
import { runTerminalCommand, waitForTerminalText } from "../../helpers/terminal";
import { getGridPanelCount, getGridPanelIds, getPanelById } from "../../helpers/panels";
import { T_LONG } from "../../helpers/timeouts";

// Project name stems — match against the `daintree-e2e-<stem>-XXXX` directory
// basename via substring (see `waitForActiveProject` + palette `hasText`).
const PROJECT_A = "project-A";
const PROJECT_B = "project-B";
const PROJECT_C = "project-C";

// Hold the cache at 2 throughout: with three projects, every A→B→C cycle
// evicts exactly one LRU view per switch — the determinism the issue asks
// for, without the cascading double-evictions that setCachedViewLimit(1)
// triggers when called against a populated cache.
const CACHE_LIMIT = 2;

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
let repoDirs: string[] = [];
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
    // Disable the low-memory cap override so CI memory pressure can't
    // collapse the cache to 1 mid-spec and invalidate the assertions.
    pvm?.setLowMemoryFreeThresholdMb?.(null);
    pvm?.setCachedViewLimit(n);
  }, limit);
}

async function readPvmState(app: AppContext["app"]): Promise<{
  viewCount: number;
  projectIds: string[];
  activeProjectId: string | null;
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
    if (!pvm) return { viewCount: -1, projectIds: [], activeProjectId: null };
    const views = pvm.getAllViews();
    return {
      viewCount: views.length,
      projectIds: views.map((v) => v.projectId),
      activeProjectId: pvm.getActiveProjectId(),
    };
  });
}

async function fetchAllWorktreesJson(window: Page): Promise<string> {
  return window.evaluate(() => {
    const api = (
      window as unknown as {
        electron?: { worktree?: { getAll: () => Promise<unknown[]> } };
      }
    ).electron?.worktree;
    if (typeof api?.getAll !== "function") return "[]";
    return api.getAll().then((wts) => JSON.stringify(wts));
  });
}

async function requireActiveProjectId(app: AppContext["app"], label: string): Promise<string> {
  const state = await readPvmState(app);
  if (!state.activeProjectId) {
    throw new Error(`[lru-eviction] expected active project id after opening ${label}`);
  }
  return state.activeProjectId;
}

async function waitForProjectAToBeEvictedWithCActive(app: AppContext["app"]): Promise<void> {
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
      {
        timeout: T_LONG,
        intervals: [200, 400, 800, 1600],
      }
    )
    .toBe(true);
}

test.describe.serial("Core: LRU project-view eviction with active terminal/worktree state", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const fixtures = createFixtureRepos(3);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    repoDirs = fixtures.map((f) => f.dir);
    const [repoA, repoB, repoC] = repoDirs;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);
    projectIdA = await requireActiveProjectId(ctx.app, PROJECT_A);

    // Freeze the cache limit BEFORE adding B and C. The default of 5 would
    // keep all three views alive and prevent the deterministic single-view
    // eviction we want to exercise.
    await configurePvm(ctx.app, CACHE_LIMIT);

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoB, PROJECT_B);
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoC, PROJECT_C);
    projectIdC = await requireActiveProjectId(ctx.app, PROJECT_C);

    // Return to A so the first test starts with A active and a fresh terminal.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      // Restore a permissive limit so app shutdown doesn't fight eviction.
      await configurePvm(ctx.app, 5).catch(() => undefined);
      await closeApp(ctx.app);
    }
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("terminal stays usable after its project view is evicted and revived", async () => {
    test.slow();

    // Re-anchor on A — the prior test (or beforeAll) may have left us on a
    // different project, and selectExistingProjectAndRefresh is the only call
    // that returns a fresh Page bound to the active view.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    const initialPanel: Locator = await spawnTerminalAndVerify(ctx.window);
    await runTerminalCommand(ctx.window, initialPanel, "echo LRU_BEFORE_EVICT");
    await waitForTerminalText(initialPanel, "LRU_BEFORE_EVICT");

    // A→B→C with cache=2: B's switch caches A; C's switch caches B and evicts
    // A as the LRU. After this sequence A's WebContentsView is gone.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);

    // webContents.close() is async — poll until A is no longer represented in
    // the PVM before re-opening it, so the cold-start path actually runs.
    // ResourceProfileService may legitimately collapse the cache below the
    // user limit under CI pressure, so assert boundedness instead of exact size.
    // The LRU mechanism itself (and the projectId-level eviction assertion)
    // is covered by `e2e/nightly/nightly-evicted-view-leak.spec.ts`.
    await waitForProjectAToBeEvictedWithCActive(ctx.app);

    // Return to A — cold-start: new WebContentsView, fresh renderer, must
    // re-broker PTY and worktree MessagePorts.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // Guard against #5009 — panel state must be flushed before view teardown.
    // If the revived A has zero panels there's nothing to type into.
    await expect
      .poll(() => getGridPanelCount(ctx.window), {
        timeout: T_LONG,
        intervals: [200, 400, 800, 1600],
      })
      .toBeGreaterThanOrEqual(1);

    // The `initialPanel` Locator targets the discarded webContents — fetch a
    // fresh one from the rehydrated DOM.
    const freshIds = await getGridPanelIds(ctx.window);
    expect(freshIds.length).toBeGreaterThan(0);
    const revivedPanel = getPanelById(ctx.window, freshIds[0]);

    await runTerminalCommand(ctx.window, revivedPanel, "echo LRU_AFTER_REVIVE");
    await waitForTerminalText(revivedPanel, "LRU_AFTER_REVIVE");
  });

  test("worktree state reflects git changes made while the view was evicted", async () => {
    test.slow();

    // Start on A so the upcoming A→B→C cycle evicts A again.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);

    await waitForProjectAToBeEvictedWithCActive(ctx.app);

    // Commit a new file in A's repo while A's view is destroyed. After cold-
    // start the WorktreePortBroker re-brokering must pick this up; a stale
    // pre-eviction snapshot would mean the port handoff missed.
    const markerSuffix = Date.now().toString(36);
    const markerFile = `lru-marker-${markerSuffix}.txt`;
    const markerMsg = `lru-marker-commit-${markerSuffix}`;
    writeFileSync(join(repoDirs[0], markerFile), `${markerMsg}\n`);
    execSync(`git add ${JSON.stringify(markerFile)}`, { cwd: repoDirs[0], stdio: "pipe" });
    execSync(`git commit -m ${JSON.stringify(markerMsg)}`, {
      cwd: repoDirs[0],
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Daintree Test",
        GIT_AUTHOR_EMAIL: "test@daintree.dev",
        GIT_COMMITTER_NAME: "Daintree Test",
        GIT_COMMITTER_EMAIL: "test@daintree.dev",
      },
    });

    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // The marker may surface via `summary` (last-commit message) or
    // `worktreeChanges.lastCommitMessage`; containment over JSON tolerates both.
    await expect
      .poll(() => fetchAllWorktreesJson(ctx.window), {
        timeout: T_LONG,
        intervals: [500, 1000, 2000],
      })
      .toContain(markerMsg);
  });

  test("PVM cache stays bounded across repeated project switches", async () => {
    test.slow();

    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);

    await waitForProjectAToBeEvictedWithCActive(ctx.app);

    const state = await readPvmState(ctx.app);
    expect(state.viewCount).toBeGreaterThanOrEqual(1);
    expect(state.viewCount).toBeLessThanOrEqual(CACHE_LIMIT);
    expect(state.activeProjectId).toBe(projectIdC);
    expect(state.projectIds).toContain(projectIdC);
    expect(state.projectIds).not.toContain(projectIdA);
  });
});
