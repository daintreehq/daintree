/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  mockOpenDialog,
  refreshActiveWindow,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { injectDelay, clearAllFaults } from "../../helpers/ipcFaults";
import { getGridPanelIds, getPanelById, openTerminal } from "../../helpers/panels";
import { waitForTerminalPty, waitForTerminalReady } from "../../helpers/terminal";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
const PROJECT_A_NAME = "project-A";
const PROJECT_B_NAME = "project-B";

/** Injected terminal:spawn delay, wide enough that a project switch lands mid-spawn. */
const SPAWN_DELAY_MS = 3000;

/**
 * How long ownership keeps being sampled once the delayed spawn has resolved,
 * so a Project-B stamp that lands just after the spawn returns is still seen.
 */
const POST_RESOLVE_SAMPLE_MS = 3000;

interface TerminalInfo {
  id: string;
  projectId?: string;
  isTrashed?: boolean;
  hasPty?: boolean;
  kind?: string;
}

interface ProjectInfo {
  id: string;
  name: string;
}

async function getAllTerminals(page: typeof ctx.window): Promise<TerminalInfo[]> {
  return page.evaluate(async () => {
    return await (window as any).electron.terminal.getAllTerminals();
  });
}

async function getCurrentProject(page: typeof ctx.window): Promise<ProjectInfo | null> {
  return page.evaluate(async () => {
    return await (window as any).electron.project.getCurrent();
  });
}

async function switchToProject(
  page: typeof ctx.window,
  projectName: string
): Promise<typeof ctx.window> {
  // Skip if already on the target project
  const current = await getCurrentProject(page);
  if (current?.name === projectName) return page;

  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = page.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await expect(palette.getByRole("option").filter({ hasText: projectName }).first()).toBeVisible({
    timeout: T_MEDIUM,
  });

  // Use evaluate to click — immune to DOM detachment from React re-renders
  await page.evaluate((name) => {
    const el = document.querySelector('[data-testid="project-switcher-palette"]');
    if (!el) throw new Error("Palette not in DOM");
    const options = el.querySelectorAll('[role="option"]');
    for (const opt of options) {
      if (opt.textContent?.includes(name)) {
        (opt as HTMLElement).click();
        return;
      }
    }
    throw new Error(`Project "${name}" not found in palette`);
  }, projectName);

  // Don't fail if the outgoing view's React tree never closes its palette
  // before we swap; the visible/attached view changes anyway.
  await expect(palette)
    .not.toBeVisible({ timeout: T_LONG })
    .catch(() => undefined);

  // Re-acquire the now-active project view's CDP page so subsequent
  // locator queries don't go to the cached outgoing view.
  const refreshed = await refreshActiveWindow(ctx.app, page);
  await expect(refreshed.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText(projectName, {
    timeout: T_LONG,
  });
  await expect
    .poll(async () => (await getCurrentProject(refreshed))?.name ?? "", { timeout: T_LONG })
    .toContain(projectName);
  ctx.window = refreshed;
  return refreshed;
}

test.describe.serial("Core: Project Switch Race Conditions", () => {
  test.beforeAll(async () => {
    const fixtures = createFixtureRepos(2);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const [repoA, repoB] = fixtures.map((f) => f.dir);

    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });

    // Every test in this file keeps Project A's view alive while Project B is
    // active — the delayed-spawn test reads A's terminals after switching away,
    // and the #11366 test evaluates directly in A's backgrounded page. The
    // default cached-view limit is 1, and a low-memory host collapses that cap
    // further and evicts A mid-spec, which closes its page and takes its
    // terminals with it. That is what failed three v0.29.0 macOS release runs
    // ("Target page, context or browser has been closed"; no project-stamped
    // terminals) while passing locally and on Linux. Same guard as
    // core-lru-project-eviction and five other multi-view specs.
    await ctx.app.evaluate((_electron) => {
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
      pvm?.setCachedViewLimit(2);
    });

    // Open and onboard Project A
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A_NAME);

    // Add Project B via project switcher
    await mockOpenDialog(ctx.app, repoB);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });

    // Re-acquire window after the WebContentsView swap.
    ctx.window = await refreshActiveWindow(ctx.app, ctx.window);

    // Switch back to Project A as the starting baseline
    await switchToProject(ctx.window, PROJECT_A_NAME);
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
  });

  test.afterAll(async () => {
    await clearAllFaults(ctx.app);
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("delayed spawn assigns terminal to originating project", async () => {
    test.slow();

    // Capture Project A's ID
    const projectA = await getCurrentProject(ctx.window);
    expect(projectA).not.toBeNull();

    // Open a terminal in Project A to confirm normal flow works, and let its
    // PTY finish spawning so only the delayed spawn below is in flight.
    await openTerminal(ctx.window);
    const firstPanel = ctx.window.locator(SEL.panel.gridPanel).first();
    await expect(firstPanel).toBeVisible({ timeout: T_LONG });
    await waitForTerminalPty(ctx.window, firstPanel, T_LONG);
    const firstPanelIds = new Set(await getGridPanelIds(ctx.window));

    // Inject a delay on terminal:spawn so the switch below lands mid-spawn
    await injectDelay(ctx.app, "terminal:spawn", SPAWN_DELAY_MS);

    // Trigger a second terminal spawn (this one will be delayed)
    await openTerminal(ctx.window);

    // openTerminal returns once the click is delivered, not once React has
    // dispatched terminal:spawn. addPanel commits the pane to the store before
    // any async work (#5789 commit-then-spawn), so a second grid pane is proof
    // the spawn is genuinely in-flight — and it lands in milliseconds, well
    // inside the 3s delay. Without this gate a loaded runner can switch away
    // before the spawn is ever sent, and addPanel's async tail then drops the
    // pane on the project switch (see panelStore.addPanel), leaving one
    // terminal instead of two.
    await expect(ctx.window.locator(SEL.panel.gridPanel)).toHaveCount(2, {
      timeout: T_LONG,
    });
    const delayedId = (await getGridPanelIds(ctx.window)).find((id) => !firstPanelIds.has(id));
    expect(delayedId, "the delayed spawn's pane should be in the grid").toBeTruthy();

    // Immediately switch to Project B — the spawn is still in-flight
    await switchToProject(ctx.window, PROJECT_B_NAME);

    // Clear the fault before polling
    await clearAllFaults(ctx.app);

    // Whether the delayed terminal SURVIVES the switch is not guaranteed and
    // must not be asserted: if the switch removes the pane before the spawn IPC
    // resolves, addPanel issues a compensating kill so the fresh PTY isn't
    // orphaned (src/store/slices/panelRegistry/addPanel.ts). Which side wins is
    // decided by how long the real PTY spawn takes on top of the injected
    // delay, and that is unbounded on a loaded runner — asserting a surviving
    // count of 2 passed locally and on Linux but failed every attempt on
    // contended macOS release runners.
    //
    // The invariant that must hold either way is ownership: no terminal may
    // ever be stamped with Project B. Assert that on every sample rather than
    // once at the end, and keep sampling for a bounded window after the
    // delayed spawn resolves so a late Project-B stamp cannot slip through.
    // When the spawn survives, its own terminal id shows up stamped; when it
    // is killed there is nothing to observe, so the fallback deadline spans
    // the injected delay plus a full spawn budget from the switch.
    const readActiveTerminals = async () =>
      (await getAllTerminals(ctx.window)).filter((t: TerminalInfo) => !t.isTrashed);

    const fallbackDeadline = Date.now() + SPAWN_DELAY_MS + T_LONG;
    let sampleDeadline = fallbackDeadline;
    let sawResolvedTerminal = false;
    let resolvedAt: number | null = null;
    while (Date.now() < sampleDeadline) {
      const withProject = (await readActiveTerminals()).filter(
        (t: TerminalInfo) => t.projectId !== undefined
      );
      for (const t of withProject) {
        expect(t.projectId, `terminal ${t.id} was stamped with the wrong project`).toBe(
          projectA!.id
        );
      }
      if (withProject.length > 0) sawResolvedTerminal = true;
      if (resolvedAt === null && withProject.some((t: TerminalInfo) => t.id === delayedId)) {
        resolvedAt = Date.now();
        sampleDeadline = Math.min(fallbackDeadline, resolvedAt + POST_RESOLVE_SAMPLE_MS);
      }
      // timer: ownership sampling interval across the bounded post-spawn window
      await ctx.window.waitForTimeout(250);
    }

    // The window must have observed real ownership data, not an empty list.
    expect(sawResolvedTerminal).toBe(true);
  });

  test("panel grid is clean after switching — no cross-project panels", async () => {
    test.slow();

    // Ensure faults are cleared from previous test before spawning
    await clearAllFaults(ctx.app);

    // Ensure we're on Project A with a fresh terminal fully spawned
    await switchToProject(ctx.window, PROJECT_A_NAME);
    const idsBeforeSpawn = new Set(await getGridPanelIds(ctx.window));
    await openTerminal(ctx.window);
    let freshId = "";
    await expect
      .poll(
        async () => {
          freshId = (await getGridPanelIds(ctx.window)).find((id) => !idsBeforeSpawn.has(id)) ?? "";
          return freshId;
        },
        // CI VMs are slow after fault-injection tests; double T_LONG for headroom
        { timeout: T_LONG * 2 }
      )
      .not.toBe("");
    await waitForTerminalReady(ctx.window, getPanelById(ctx.window, freshId), T_LONG * 2);

    const panelIdsA = await getGridPanelIds(ctx.window);
    expect(panelIdsA).toContain(freshId);

    // Project B's grid must not render any of Project A's panels. Give B a
    // panel of its own and wait for it to be live, so the grid read below is
    // a hydrated one rather than an empty grid that has not rendered yet.
    await switchToProject(ctx.window, PROJECT_B_NAME);
    const idsBeforeB = new Set(await getGridPanelIds(ctx.window));
    await openTerminal(ctx.window);
    let bPanelId = "";
    await expect
      .poll(
        async () => {
          bPanelId = (await getGridPanelIds(ctx.window)).find((id) => !idsBeforeB.has(id)) ?? "";
          return bPanelId;
        },
        { timeout: T_LONG * 2 }
      )
      .not.toBe("");
    await waitForTerminalReady(ctx.window, getPanelById(ctx.window, bPanelId), T_LONG * 2);
    const panelIdsB = await getGridPanelIds(ctx.window);
    expect(panelIdsB).toContain(bPanelId);
    expect(panelIdsB.filter((id) => panelIdsA.includes(id))).toEqual([]);

    // Switch straight back to Project A — every one of its panels reappears.
    await switchToProject(ctx.window, PROJECT_A_NAME);
    await expect
      .poll(async () => (await getGridPanelIds(ctx.window)).sort().join(","), {
        timeout: T_LONG,
      })
      .toBe([...panelIdsA].sort().join(","));
  });

  test("no orphaned terminals after rapid switching", async () => {
    test.slow();

    // Record baseline terminals. Project B legitimately owns the terminal the
    // previous test opened there, so ownership is checked on new terminals only.
    const baselineTerminals = (await getAllTerminals(ctx.window)).filter(
      (t: TerminalInfo) => !t.isTrashed
    );
    const baselineCount = baselineTerminals.length;
    const baselineIds = new Set(baselineTerminals.map((t) => t.id));
    const readNewTerminals = async () =>
      (await getAllTerminals(ctx.window)).filter(
        (t: TerminalInfo) => !t.isTrashed && !baselineIds.has(t.id)
      );

    // Switch to Project A to spawn from there
    await switchToProject(ctx.window, PROJECT_A_NAME);
    const projectA = await getCurrentProject(ctx.window);
    expect(projectA).not.toBeNull();

    // Inject delay and trigger a spawn
    await injectDelay(ctx.app, "terminal:spawn", 2000);
    await openTerminal(ctx.window);

    // Rapid switch: A -> B -> A
    await switchToProject(ctx.window, PROJECT_B_NAME);
    await switchToProject(ctx.window, PROJECT_A_NAME);

    await clearAllFaults(ctx.app);

    // Poll until the delayed spawn has landed and its projectId is resolved.
    await expect
      .poll(
        async () =>
          (await readNewTerminals()).filter((t: TerminalInfo) => t.projectId !== undefined).length,
        { timeout: T_LONG }
      )
      .toBeGreaterThanOrEqual(1);

    // Exactly one new terminal (the one we spawned), not more — and the
    // pre-existing ones are all still there.
    const activeTerminals = (await getAllTerminals(ctx.window)).filter(
      (t: TerminalInfo) => !t.isTrashed
    );
    expect(activeTerminals.length).toBe(baselineCount + 1);
    const newTerminals = await readNewTerminals();
    expect(newTerminals).toHaveLength(1);

    // It must belong to Project A — it must not have leaked to B.
    expect(newTerminals[0]!.projectId).toBe(projectA!.id);
  });

  test("backgrounded view's file browser queries its own project (#11366)", async () => {
    test.slow();

    // Start on Project A and capture its page + main worktree id while active.
    await switchToProject(ctx.window, PROJECT_A_NAME);
    const pageA = ctx.window;
    await expect
      .poll(
        () =>
          pageA
            .evaluate(() => (window as any).electron.worktree.getAll())
            .then((wts: Array<{ id: string }>) => wts.length),
        { timeout: T_LONG }
      )
      .toBeGreaterThanOrEqual(1);
    const worktreeA: string = await pageA.evaluate(async () => {
      const wts = await (window as any).electron.worktree.getAll();
      return wts[0].id;
    });

    // Switch to Project B — A's view is now cached in the same window, and
    // windowToProject points at B. pageA keeps targeting the cached view.
    const pageB = await switchToProject(ctx.window, PROJECT_B_NAME);
    await expect
      .poll(
        () =>
          pageB
            .evaluate(() => (window as any).electron.worktree.getAll())
            .then((wts: Array<{ id: string }>) => wts.length),
        { timeout: T_LONG }
      )
      .toBeGreaterThanOrEqual(1);
    const worktreeB: string = await pageB.evaluate(async () => {
      const wts = await (window as any).electron.worktree.getAll();
      return wts[0].id;
    });
    expect(worktreeB).not.toBe(worktreeA);

    // The cached A view's listing must resolve against A's own workspace
    // host — before #11366 this failed with "Worktree not found" because the
    // request routed to the active project B's host.
    const listingA = await pageA.evaluate(async (wtId: string) => {
      try {
        const entries = await (window as any).electron.fileBrowser.listDirectory({
          worktreeId: wtId,
        });
        return { ok: true as const, names: entries.map((e: { name: string }) => e.name) };
      } catch (error) {
        return { ok: false as const, error: String(error) };
      }
    }, worktreeA);
    expect(
      listingA.ok,
      `cached view listing failed: ${"error" in listingA ? listingA.error : ""}`
    ).toBe(true);
    expect((listingA as { names: string[] }).names).toContain("README.md");

    // Prove B's own host can serve its worktree right now, so the refusal
    // below is conclusively an authorization decision, not an unready host.
    const listingBFromB = await pageB.evaluate(async (wtId: string) => {
      try {
        const entries = await (window as any).electron.fileBrowser.listDirectory({
          worktreeId: wtId,
        });
        return { ok: true as const, names: entries.map((e: { name: string }) => e.name) };
      } catch (error) {
        return { ok: false as const, error: String(error) };
      }
    }, worktreeB);
    expect(
      listingBFromB.ok,
      `active view listing failed: ${"error" in listingBFromB ? listingBFromB.error : ""}`
    ).toBe(true);

    // The scoping must be tighter than before, not looser: the cached A view
    // must NOT be able to list the active project B's worktree.
    const listingB = await pageA.evaluate(async (wtId: string) => {
      try {
        await (window as any).electron.fileBrowser.listDirectory({ worktreeId: wtId });
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: String(error) };
      }
    }, worktreeB);
    expect(listingB.ok).toBe(false);
    expect((listingB as { error: string }).error).toMatch(/Worktree not found/);

    // Restore the serial suite's baseline.
    await switchToProject(ctx.window, PROJECT_A_NAME);
  });
});
