import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  closeWindow,
  focusWindow,
  getWindowPage,
  openSecondWindow,
  type AppContext,
  type WindowHandle,
} from "../../helpers/launch";
import { createFixtureRepos, type FixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { spawnTerminalAndVerify } from "../../helpers/workflows";
import { runTerminalCommand, getTerminalText, waitForTerminalText } from "../../helpers/terminal";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";

const MULTI_WINDOW_READY_TIMEOUT = process.env.CI ? T_LONG * 4 : T_LONG * 2;
const MULTI_WINDOW_SETUP_TIMEOUT = process.env.CI ? T_LONG * 8 : T_LONG * 4;

// Multi-window isolation: per-window services (PortalManager, EventBuffer,
// MessagePorts) must scope correctly while global singletons (PtyClient,
// WorkspaceClient) stay shared. The spec opens two BrowserWindows with
// distinct projects, then exercises the routing invariants from #4641,
// #4715, and #4624.
//
// Helpers in launch.ts identify windows by stable `windowId` rather than the
// Z-ordered `BrowserWindow.getAllWindows()` array — Electron 41's window list
// reorders on focus, so index-based lookups silently target the wrong view.

async function getInitialProjectId(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const initialProject = (
      window as unknown as {
        __DAINTREE_INITIAL_PROJECT__?: { id?: unknown };
      }
    ).__DAINTREE_INITIAL_PROJECT__;
    return typeof initialProject?.id === "string" ? initialProject.id : null;
  });
}

async function runCommandAndWaitForText(
  page: Page,
  panel: Locator,
  command: string,
  expectedText: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    await runTerminalCommand(page, panel, command);
    try {
      await waitForTerminalText(panel, expectedText, T_LONG);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

test.describe.serial("Multi-window isolation", () => {
  let ctx: AppContext | null = null;
  let fixtures: FixtureRepo[] = [];
  let window1Id: number;
  let window1Page: import("@playwright/test").Page;
  let window2: WindowHandle;
  let window2Page: import("@playwright/test").Page;

  test.beforeAll(async () => {
    test.setTimeout(MULTI_WINDOW_SETUP_TIMEOUT);
    fixtures = createFixtureRepos(2);

    ctx = await launchApp();
    const { app } = ctx;

    // Window 1: open project A via the standard onboarding path. Capture
    // the windowId BEFORE opening window 2 so the snapshot is unambiguous —
    // at this point only one BrowserWindow exists.
    window1Page = await openAndOnboardProject(app, ctx.window, fixtures[0].dir);
    window1Id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);

    // Window 2: opened with projectPath so the new window auto-opens
    // project B via handleDirectoryOpen — same path `app.newWindow` takes
    // when invoked with an explicit projectPath argument.
    window2 = await openSecondWindow(app, window1Page, {
      projectPath: fixtures[1].dir,
      timeoutMs: MULTI_WINDOW_READY_TIMEOUT,
    });
    window2Page = await getWindowPage(app, window2.windowId, MULTI_WINDOW_READY_TIMEOUT);

    // Wait for window 2's sidebar to be ready before any test body runs.
    await window2Page
      .locator('[aria-label="Toggle Sidebar"]')
      .waitFor({ state: "visible", timeout: MULTI_WINDOW_READY_TIMEOUT });

    // Re-resolve window 1's page by stable windowId in case the cached
    // WebContentsView was shuffled when window 2 opened. Never use
    // refreshActiveWindow here — it falls back to getAllWindows()[0],
    // which is Z-ordered and would silently reassign window1Page to the
    // newly-focused second window's view.
    window1Page = await getWindowPage(app, window1Id, MULTI_WINDOW_READY_TIMEOUT);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      await closeApp(ctx.app).catch(() => undefined);
      ctx = null;
    }
    for (const fixture of fixtures) {
      fixture.cleanup();
    }
    fixtures = [];
  });

  test("two windows host independent projects", async () => {
    // Confirm exactly two BrowserWindows are alive — guards against a
    // helper bug where openSecondWindow accidentally creates more than one
    // window or fails to detect the new one and silently grabs window 1's
    // sentinel.
    const aliveIds = await ctx!.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed())
        .map((w) => w.id)
    );
    expect(aliveIds).toHaveLength(2);
    expect(aliveIds).toContain(window1Id);
    expect(aliveIds).toContain(window2.windowId);

    await expect(window1Page.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText(
      path.basename(fixtures[0].dir),
      { timeout: T_LONG }
    );
    await expect(window2Page.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText(
      path.basename(fixtures[1].dir),
      { timeout: T_LONG }
    );

    // Sanity: the two pages are distinct BrowserWindow contents. Project
    // identity is preload-seeded now; URLs intentionally stay static so
    // per-project WebContentsViews can share the bytecode cache.
    const url1 = window1Page.url();
    const url2 = window2Page.url();
    const projectId1 = await getInitialProjectId(window1Page);
    const projectId2 = await getInitialProjectId(window2Page);
    expect(url1).toBe("app://daintree/index.html");
    expect(url2).toBe("app://daintree/index.html");
    expect(projectId1).toBeTruthy();
    expect(projectId2).toBeTruthy();
    expect(projectId1).not.toBe(projectId2);
  });

  test("terminal I/O stays scoped to its originating window", async () => {
    const app = ctx!.app;

    await focusWindow(app, window1Id, window1Page);
    const panel1 = await spawnTerminalAndVerify(window1Page, undefined, {
      waitForInitialOutput: false,
    });

    await focusWindow(app, window2.windowId, window2Page);
    const panel2 = await spawnTerminalAndVerify(window2Page, undefined, {
      waitForInitialOutput: false,
    });

    const nonceA = `mw-a-${randomUUID()}`;
    const nonceB = `mw-b-${randomUUID()}`;

    // Type nonce A in window 1's terminal — it must appear in window 1
    // and never bleed into window 2's terminal.
    await focusWindow(app, window1Id, window1Page);
    await runCommandAndWaitForText(window1Page, panel1, `echo ${nonceA}`, nonceA);
    expect(await getTerminalText(panel2)).not.toContain(nonceA);

    // Type nonce B in window 2's terminal — it must appear in window 2
    // and never bleed into window 1's terminal.
    await focusWindow(app, window2.windowId, window2Page);
    await runCommandAndWaitForText(window2Page, panel2, `echo ${nonceB}`, nonceB);
    expect(await getTerminalText(panel1)).not.toContain(nonceB);

    // Confirm the original nonces did not leak post-second-write.
    expect(await getTerminalText(panel1)).not.toContain(nonceB);
    expect(await getTerminalText(panel2)).not.toContain(nonceA);
  });

  test("worktree updates scope to the originating window's project", async () => {
    const main1 = window1Page.locator(SEL.worktree.mainCard);
    const main2 = window2Page.locator(SEL.worktree.mainCard);
    await expect(main1).toBeVisible({ timeout: T_LONG });
    await expect(main2).toBeVisible({ timeout: T_LONG });

    // Both cards start clean.
    await expect
      .poll(() => main1.getAttribute("aria-label"), { timeout: T_LONG })
      .not.toContain("has uncommitted changes");
    await expect
      .poll(() => main2.getAttribute("aria-label"), { timeout: T_LONG })
      .not.toContain("has uncommitted changes");

    // Cooldown for GIT_WATCH_SELF_TRIGGER_COOLDOWN_MS (1000ms).
    await window1Page.waitForTimeout(1500);

    // External file change in fixture A only — fixture B must remain clean.
    writeFileSync(path.join(fixtures[0].dir, "isolation-marker.txt"), "scoped\n");

    await expect
      .poll(() => main1.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Window 1's main card should detect the external change",
      })
      .toContain("has uncommitted changes");

    // Window 2 must NOT report dirty state — its WorktreeMonitor watches
    // fixture B, not fixture A. `expect.poll().not.toContain()` exits the
    // moment the negative condition holds (which is immediately, since
    // main2 starts clean), so a cross-routed event arriving 300–500ms
    // later would escape. Sustain the window with an explicit wait, then
    // snapshot-assert after the dwell.
    await window2Page.waitForTimeout(T_MEDIUM);
    expect(await main2.getAttribute("aria-label")).not.toContain("has uncommitted changes");
  });

  test("closing one window leaves the other fully functional", async () => {
    const app = ctx!.app;

    // Close window 1; assert window 2 stays alive and its services keep working.
    await closeWindow(app, window1Id, T_LONG);

    // Window 2's BrowserWindow must still be present.
    const survivors = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed())
        .map((w) => w.id)
    );
    expect(survivors).toContain(window2.windowId);
    expect(survivors).not.toContain(window1Id);

    // Re-acquire window 2's page (the closure may have nudged Z-order) and
    // confirm a fresh terminal write still flows end-to-end — proves
    // PtyClient (global) survived and window 2's per-window port routing
    // is intact.
    window2Page = await getWindowPage(app, window2.windowId, MULTI_WINDOW_READY_TIMEOUT);
    await focusWindow(app, window2.windowId, window2Page);

    const survivorNonce = `mw-survive-${randomUUID()}`;
    const survivorPanel = await spawnTerminalAndVerify(window2Page, undefined, {
      waitForInitialOutput: false,
    });
    await runTerminalCommand(window2Page, survivorPanel, `echo ${survivorNonce}`);
    await waitForTerminalText(survivorPanel, survivorNonce, T_LONG);

    // Prove window 2's worktree MessagePort is still live by triggering a
    // fresh external file change in fixture B and asserting the dirty
    // indicator appears. Checking the already-rendered toolbar label would
    // only verify cached React state, not that new worktree events flow.
    const main2 = window2Page.locator(SEL.worktree.mainCard);
    await expect(main2).toBeVisible({ timeout: T_LONG });
    await window2Page.waitForTimeout(1500); // GIT_WATCH_SELF_TRIGGER_COOLDOWN_MS
    writeFileSync(path.join(fixtures[1].dir, "post-close-marker.txt"), "alive\n");
    await expect
      .poll(() => main2.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Window 2's worktree port must still deliver updates after window 1 closes",
      })
      .toContain("has uncommitted changes");
  });
});
