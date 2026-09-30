/**
 * Agent-terminal lifecycle integrity across LRU eviction (lifecycle ledger).
 *
 * Launches a recipe terminal with caller-resolved env and a recipe cwd, cycles
 * projects to force LRU eviction of its view, revives it, and verifies the
 * LIVE PTY retained its launch identity (cwd + env) rather than merely its
 * scrollback. Then closes it and asserts the main-process lifecycle ledger's
 * diagnostics section carries the launch facts (env provenance as key names,
 * never values) and no stale-generation / duplicate-journal anomalies.
 *
 * The same three-project, cache=2 launch then covers ordinary terminals and
 * worktree state across repeated eviction and revival.
 */

import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, createFixtureRepoWithRecipes } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  addAndSwitchToProject,
  selectExistingProjectAndRefresh,
  spawnTerminalAndVerify,
} from "../../helpers/workflows";
import { dispatchAction } from "../../helpers/actions";
import { getPtyPid, isPidAlive } from "../../helpers/stress";
import {
  runTerminalCommand,
  waitForTerminalText,
  getTerminalTextById,
} from "../../helpers/terminal";
import { getGridPanelCount, getGridPanelIds, getPanelById } from "../../helpers/panels";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

// Project name stems — waitForActiveProject matches against the
// `daintree-e2e-<stem>-XXXX` fixture directory basename via substring, so
// these must equal the fixture repo names passed to createFixtureRepo*.
const PROJECT_A = "ledger-a";
const PROJECT_B = "ledger-b";
const PROJECT_C = "ledger-c";

const RECIPE_NAME = "Ledger Recipe";
const RECIPE_ID = "inrepo-ledger-recipe";
const ENV_KEY = "LEDGER_E2E_MARKER";
const ENV_VALUE = "ledger-e2e-value";
const CACHE_LIMIT = 2;

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
let repoADir = "";
let repoABasename = "";
let projectIdA = "";
let projectIdC = "";
let recipePanelId = "";

// The identity probes use POSIX shell expansion (`$VAR`, `$(basename …)`);
// the resilience bucket also runs on Windows, where the default shell is
// PowerShell/cmd. The lifecycle paths under test are platform-independent —
// skip rather than fork per-shell probe syntax. Called at the top of every
// test (the suite is serial and each test depends on the probes).
const POSIX_SKIP_REASON = "POSIX shell probes are not portable to the Windows default shell";
function skipOnWindows(): void {
  test.info().annotations.push({ type: "platform-skip", description: POSIX_SKIP_REASON });
  test.skip(process.platform === "win32", POSIX_SKIP_REASON);
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

async function requireActiveProjectId(app: AppContext["app"], label: string): Promise<string> {
  const state = await readPvmState(app);
  if (!state.activeProjectId) {
    throw new Error(`[lifecycle-ledger] expected active project id after opening ${label}`);
  }
  return state.activeProjectId;
}

// Opens and closes the project-settings Recipes tab — the canonical trigger
// for recipeStore.loadRecipes so the in-repo recipe is available to run.
async function loadRecipesViaSettings(window: Page): Promise<void> {
  await dismissBlockingPalette(window).catch(() => undefined);
  await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = window.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await palette.locator(SEL.projectSwitcher.projectSettings).click();
  await expect(window.locator(SEL.projectSettings.heading)).toBeVisible({ timeout: T_MEDIUM });
  await window.locator(SEL.projectSettings.recipesTab).click();
  await expect(window.getByText(RECIPE_NAME, { exact: true }).first()).toBeVisible({
    timeout: T_MEDIUM,
  });
  await window.locator(SEL.projectSettings.closeButton).click();
  await expect(window.locator(SEL.projectSettings.heading)).not.toBeVisible({ timeout: T_SHORT });
}

async function findPanelContaining(window: Page, text: string): Promise<string> {
  let foundId = "";
  await expect
    .poll(
      async () => {
        const ids = await getGridPanelIds(window);
        for (const id of ids) {
          const content = await getTerminalTextById(window, id).catch(() => "");
          if (content.includes(text)) {
            foundId = id;
            return true;
          }
        }
        return false;
      },
      { timeout: T_LONG, intervals: [250, 500, 1000, 2000] }
    )
    .toBe(true);
  return foundId;
}

async function waitForProjectAToBeEvictedWithCActive(app: AppContext["app"]): Promise<void> {
  // webContents.close() is async — poll until A is no longer represented in
  // the PVM so the return to A is a genuine cold start. ResourceProfileService
  // may legitimately collapse the cache below the limit under CI pressure, so
  // assert boundedness instead of exact size.
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
      { timeout: T_LONG, intervals: [200, 400, 800, 1600] }
    )
    .toBe(true);
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

test.describe.serial("Agent lifecycle ledger and LRU project-view eviction", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);

    const repoA = createFixtureRepoWithRecipes({
      name: "ledger-a",
      inRepoRecipes: [
        {
          name: RECIPE_NAME,
          terminals: [
            {
              type: "terminal",
              title: "Ledger Term",
              command: "echo LEDGER_RECIPE_READY",
              env: { [ENV_KEY]: ENV_VALUE },
            },
          ],
        },
      ],
    });
    const repoB = createFixtureRepo({ name: "ledger-b" });
    const repoC = createFixtureRepo({ name: "ledger-c" });
    fixtureCleanups = [repoA.cleanup, repoB.cleanup, repoC.cleanup];
    // The fixture dir carries a random mkdtemp suffix — derive the expected
    // `basename $PWD` from the real path instead of assuming the stem.
    repoADir = repoA.dir;
    repoABasename = repoA.dir.split("/").pop() ?? "";

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA.dir, PROJECT_A);
    projectIdA = await requireActiveProjectId(ctx.app, PROJECT_A);

    await configurePvm(ctx.app, CACHE_LIMIT);

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoB.dir, PROJECT_B);
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoC.dir, PROJECT_C);
    projectIdC = await requireActiveProjectId(ctx.app, PROJECT_C);

    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      await configurePvm(ctx.app, 5).catch(() => undefined);
      await closeApp(ctx.app);
    }
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("recipe terminal launches with its caller-resolved env and recipe cwd", async () => {
    skipOnWindows();
    test.slow();

    await loadRecipesViaSettings(ctx.window);
    const run = await dispatchAction(
      ctx.window,
      "recipe.run",
      { recipeId: RECIPE_ID },
      { source: "menu", confirmed: true }
    );
    expect(run.ok, JSON.stringify(run)).toBe(true);

    recipePanelId = await findPanelContaining(ctx.window, "LEDGER_RECIPE_READY");
    const panel: Locator = getPanelById(ctx.window, recipePanelId);

    // Live identity probes — expansion happens in the spawned shell, so the
    // expected strings can only come from PTY output, never the echoed input.
    await runTerminalCommand(ctx.window, panel, `echo "MARKER:$${ENV_KEY}"`);
    await waitForTerminalText(panel, `MARKER:${ENV_VALUE}`);

    await runTerminalCommand(ctx.window, panel, 'echo "CWD:$(basename "$PWD")"');
    await waitForTerminalText(panel, `CWD:${repoABasename}`);
  });

  test("live PTY keeps env and cwd identity across LRU eviction and revival", async () => {
    skipOnWindows();
    test.slow();

    // A→B→C with cache=2 evicts A's view; poll until it is really gone so the
    // return is a genuine cold start.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
    await waitForProjectAToBeEvictedWithCActive(ctx.app);

    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // The revived view rehydrates the panel with restored scrollback — find it
    // by the marker that only ever existed in PTY output.
    const revivedId = await findPanelContaining(ctx.window, "LEDGER_RECIPE_READY");
    const revivedPanel = getPanelById(ctx.window, revivedId);

    // Fresh probes against the LIVE pty: identity must hold on the reattached
    // process, not just in restored scrollback.
    await runTerminalCommand(ctx.window, revivedPanel, `echo "MARKER2:$${ENV_KEY}"`);
    await waitForTerminalText(revivedPanel, `MARKER2:${ENV_VALUE}`);

    await runTerminalCommand(ctx.window, revivedPanel, 'echo "CWD2:$(basename "$PWD")"');
    await waitForTerminalText(revivedPanel, `CWD2:${repoABasename}`);

    recipePanelId = revivedId;
  });

  test("close is clean and the lifecycle ledger reports coherent facts with no anomalies", async () => {
    skipOnWindows();
    test.slow();

    // Hard kill so the close reaches the PTY (trash would keep it alive under
    // the TTL) — the exit event is what stamps the main ledger's close.
    const kill = await dispatchAction(
      ctx.window,
      "terminal.kill",
      { terminalId: recipePanelId, confirmed: true },
      { source: "menu", confirmed: true }
    );
    expect(kill.ok, JSON.stringify(kill)).toBe(true);
    await expect
      .poll(async () => (await getGridPanelIds(ctx.window)).includes(recipePanelId), {
        timeout: T_LONG,
        intervals: [200, 400, 800],
      })
      .toBe(false);

    // Main-process lifecycle ledger: launch facts are auditable in the support
    // bundle — env as key names only, never values — and the whole flow
    // (spawn, LRU cycle, revive, close) produced no stale-generation or
    // duplicate-journal rejections for this terminal. Poll: panel removal in
    // the renderer can precede the main-side exit event that stamps the close.
    interface LedgerSection {
      terminals: Array<{
        terminalId: string;
        facts: { env?: { keys: string[] }; worktreeId?: string };
        closedAt?: number;
      }>;
      anomalies: Array<{ terminalId: string; reason: string }>;
    }
    const collectLedger = (): Promise<LedgerSection> =>
      ctx.window.evaluate(async () => {
        const review = await (
          window as unknown as {
            electron: {
              system: {
                collectDiagnosticsForReview: () => Promise<{ payload: Record<string, unknown> }>;
              };
            };
          }
        ).electron.system.collectDiagnosticsForReview();
        return review.payload.lifecycleLedger as LedgerSection;
      });

    await expect
      .poll(
        async () => {
          const ledger = await collectLedger();
          const entry = ledger.terminals.find((t) => t.terminalId === recipePanelId);
          return entry?.closedAt !== undefined;
        },
        { timeout: T_LONG, intervals: [500, 1000, 2000] }
      )
      .toBe(true);

    const ledger = await collectLedger();
    const entry = ledger.terminals.find((t) => t.terminalId === recipePanelId);
    expect(entry?.facts.env?.keys).toContain(ENV_KEY);
    expect(JSON.stringify(ledger)).not.toContain(ENV_VALUE);
    expect(ledger.anomalies.filter((a) => a.terminalId === recipePanelId)).toEqual([]);
  });

  test("terminal stays usable after its project view is evicted and revived", async () => {
    test.slow();

    // Re-anchor on A — selectExistingProjectAndRefresh is the only call that
    // returns a fresh Page bound to the active view.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    const initialPanel: Locator = await spawnTerminalAndVerify(ctx.window);
    await runTerminalCommand(ctx.window, initialPanel, "echo LRU_BEFORE_EVICT");
    await waitForTerminalText(initialPanel, "LRU_BEFORE_EVICT");
    const ptyPidBefore = await getPtyPid(ctx.window, initialPanel);

    // A→B→C with cache=2: B's switch caches A; C's switch caches B and evicts
    // A as the LRU. After this sequence A's WebContentsView is gone.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
    await waitForProjectAToBeEvictedWithCActive(ctx.app);

    // Return to A — cold-start: new WebContentsView, fresh renderer, must
    // re-broker PTY and worktree MessagePorts.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // Guard against #5009 — panel state must be flushed before view teardown.
    await expect
      .poll(() => getGridPanelCount(ctx.window), {
        timeout: T_LONG,
        intervals: [200, 400, 800, 1600],
      })
      .toBeGreaterThanOrEqual(1);

    // History written before the eviction must survive it, on the same live
    // process — not a respawned shell with a blank screen.
    const revivedId = await findPanelContaining(ctx.window, "LRU_BEFORE_EVICT");
    const revivedPanel = getPanelById(ctx.window, revivedId);
    expect(await getPtyPid(ctx.window, revivedPanel)).toBe(ptyPidBefore);
    expect(isPidAlive(ptyPidBefore)).toBe(true);

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
    writeFileSync(join(repoADir, markerFile), `${markerMsg}\n`);
    execSync(`git add ${JSON.stringify(markerFile)}`, { cwd: repoADir, stdio: "pipe" });
    execSync(`git commit -m ${JSON.stringify(markerMsg)}`, {
      cwd: repoADir,
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
