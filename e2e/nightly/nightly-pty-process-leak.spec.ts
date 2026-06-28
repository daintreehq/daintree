import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount, getGridPanelIds, getPanelById, openTerminal } from "../helpers/panels";
import { addAndSwitchToProject } from "../helpers/workflows";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";

// Counts live PTY processes, not panels: a leaked PTY (e.g. node-pty's master
// /dev/ptmx fd never released on kill — see #9544) survives even after the
// renderer panel is gone. The pty-host reports `hasPty = !wasKilled && !isExited`
// per terminal (electron/pty-host/handlers/terminalInfo.ts), so the count of
// terminals with hasPty === true is the direct "live process" signal. Alt+click
// close sets wasKilled=true synchronously, but the registry entry is only dropped
// asynchronously once the process actually exits — hence every assertion polls.
//
// Scoped to plain terminals on purpose: agent-promoted terminals are preserved
// in the pty-host registry after close (shouldPreserveOnExit), which would
// inflate a length-based baseline. Filtering by hasPty sidesteps that, and the
// churn loop here never promotes, so the count returns cleanly to baseline.

const CHURN_COUNT = 20;
const WARMUP_CYCLES = 3;

// Scheduled hibernation currently kills no PTYs: HibernationService.ts pins
// `EXPERIMENT_HIBERNATION_DISABLED = true`, so the scheduled-kill branch is dead
// code and a test for it would be vacuous. The "project.freeMemory" test below
// covers the real background-project PTY-teardown path (gracefulKillByProject),
// which bypasses the experiment flag. Flip this to true and add a scheduled-kill
// assertion when EXPERIMENT_HIBERNATION_DISABLED is removed (#10829).
const HIBERNATION_KILL_ENABLED = false;
void HIBERNATION_KILL_ENABLED;

async function openAndCloseTerminal(window: AppContext["window"]): Promise<void> {
  const idsBefore = await getGridPanelIds(window);
  await openTerminal(window);
  await expect
    .poll(() => getGridPanelCount(window), { timeout: T_LONG })
    .toBe(idsBefore.length + 1);

  const idsAfter = await getGridPanelIds(window);
  const newId = idsAfter.find((id) => !idsBefore.includes(id));
  const panel = newId ? getPanelById(window, newId) : window.locator(SEL.panel.gridPanel).last();
  await expect(panel).toBeVisible({ timeout: T_MEDIUM });

  // Force click to handle the close button being momentarily detached from the
  // DOM during re-renders (common on Windows CI). Alt+click sets wasKilled=true.
  const closeBtn = panel.locator(SEL.panel.close);
  await closeBtn.click({ modifiers: ["Alt"], force: true, timeout: T_MEDIUM });
  await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(idsBefore.length);
}

// Live PTY count = terminals with hasPty === true, optionally scoped to one
// project. getAllTerminals() is global to the pty-host (returns terminals across
// every project), so the projectId filter isolates a single project's PTYs.
// `null` is passed for "no filter" because Playwright serialises `undefined` as
// an omitted argument, which would misfire the comparison.
async function getLivePtyCount(window: Page, projectId: string | null = null): Promise<number> {
  return window.evaluate(async (pid) => {
    const terminals: Array<{ hasPty?: boolean; projectId?: string }> = await (
      window as unknown as {
        electron: { terminal: { getAllTerminals: () => Promise<unknown[]> } };
      }
    ).electron.terminal.getAllTerminals();
    return terminals.filter((t) => t.hasPty === true && (pid === null || t.projectId === pid))
      .length;
  }, projectId);
}

test.describe.serial("Nightly: PTY process leak — terminal churn", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "pty-leak-churn" });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "PTY Leak Churn");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("live PTY count returns to baseline after terminal churn", async () => {
    test.setTimeout(600_000);
    const { window } = ctx;

    await test.step("warmup cycles", async () => {
      for (let i = 0; i < WARMUP_CYCLES; i++) {
        await openAndCloseTerminal(window);
        await window.waitForTimeout(T_SETTLE);
      }
      await window.waitForTimeout(T_SETTLE);
    });

    const baseline = await getLivePtyCount(window);
    console.log(`[pty-leak] baseline live PTYs: ${baseline}`);

    await test.step(`run ${CHURN_COUNT} open/close cycles`, async () => {
      for (let i = 0; i < CHURN_COUNT; i++) {
        await openAndCloseTerminal(window);
        await window.waitForTimeout(T_SETTLE);
      }
    });

    // hasPty flips false synchronously on kill, but the registry entry is only
    // dropped once the process exits — poll across the IPC round-trip rather
    // than a single fixed-wait read, which flakes on loaded CI.
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getLivePtyCount(window), { timeout: T_MEDIUM }).toBe(baseline);
  });
});

test.describe.serial("Nightly: PTY process leak — project.freeMemory teardown", () => {
  let ctx: AppContext;
  let fixtureCleanups: Array<() => void> = [];
  let projectAId: string;

  test.beforeAll(async () => {
    const fixtures = createFixtureRepos(2);
    fixtureCleanups = fixtures.map((f) => f.cleanup);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtures[0].dir, "PTY Free A");

    projectAId = await ctx.window.evaluate(async () => {
      const current = await (
        window as unknown as {
          electron: { project: { getCurrent: () => Promise<{ id: string }> } };
        }
      ).electron.project.getCurrent();
      return current.id;
    });
    expect(projectAId, "project A id").toBeTruthy();

    // Open a terminal in project A so it owns a live PTY, then confirm it
    // attached before switching away — getAllTerminals reports it under A's id.
    await openTerminal(ctx.window);
    await expect
      .poll(() => getLivePtyCount(ctx.window, projectAId), { timeout: T_LONG })
      .toBeGreaterThan(0);

    // Register and switch to project B — freeMemory refuses the active project
    // (it owns the visible renderer), so A must be backgrounded first. The
    // WebContentsView swap returns a fresh Page; the old reference goes stale.
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixtures[1].dir, "PTY Free B");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("background project's PTYs are torn down by project.freeMemory", async () => {
    test.setTimeout(600_000);

    // Sanity: backgrounding project A keeps its PTY alive (no teardown yet).
    const before = await getLivePtyCount(ctx.window, projectAId);
    console.log(`[pty-leak] project A live PTYs before freeMemory: ${before}`);
    expect(before).toBeGreaterThan(0);

    await ctx.window.evaluate(async (pid) => {
      await (
        window as unknown as {
          electron: { project: { freeMemory: (id: string) => Promise<unknown> } };
        }
      ).electron.project.freeMemory(pid);
    }, projectAId);

    // gracefulKillByProject sets wasKilled=true on every project-A PTY, so the
    // live count must reach exactly 0. Poll across the kill IPC round-trip.
    await expect.poll(() => getLivePtyCount(ctx.window, projectAId), { timeout: T_MEDIUM }).toBe(0);
  });
});
