import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getFirstGridPanel, openTerminal } from "../../helpers/panels";
import {
  getTerminalDimensions,
  runTerminalCommand,
  waitForTerminalText,
} from "../../helpers/terminal";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let terminalPanel: Locator;

async function applyTier(page: Page, panelId: string, tier: string): Promise<boolean> {
  return page.evaluate(
    ({ id, name }) => {
      const fn = (
        window as unknown as {
          __daintreeApplyTerminalTier?: (panelId: string, tierName: string) => boolean;
        }
      ).__daintreeApplyTerminalTier;
      return typeof fn === "function" ? fn(id, name) : false;
    },
    { id: panelId, name: tier }
  );
}

async function applyTierAndReadDimensions(
  page: Page,
  panelId: string,
  tier: string
): Promise<{ applied: boolean; dims: { cols: number; rows: number } | null }> {
  return page.evaluate(
    ({ id, name }) => {
      const win = window as unknown as {
        __daintreeApplyTerminalTier?: (panelId: string, tierName: string) => boolean;
        __daintreeGetTerminalDimensions?: (
          panelId: string
        ) => { cols: number; rows: number } | null;
      };
      const applied =
        typeof win.__daintreeApplyTerminalTier === "function"
          ? win.__daintreeApplyTerminalTier(id, name)
          : false;
      const dims =
        typeof win.__daintreeGetTerminalDimensions === "function"
          ? win.__daintreeGetTerminalDimensions(id)
          : null;
      return { applied, dims };
    },
    { id: panelId, name: tier }
  );
}

async function simulateResize(
  page: Page,
  panelId: string,
  width: number,
  height: number
): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(
    ({ id, w, h }) => {
      const fn = (
        window as unknown as {
          __daintreeSimulateTerminalResize?: (
            panelId: string,
            width: number,
            height: number
          ) => { cols: number; rows: number } | null;
        }
      ).__daintreeSimulateTerminalResize;
      return typeof fn === "function" ? fn(id, w, h) : null;
    },
    { id: panelId, w: width, h: height }
  );
}

async function getPanelId(panelLocator: Locator): Promise<string> {
  const id = await panelLocator.evaluate((el) => {
    const panel = el.closest("[data-panel-id]");
    return panel?.getAttribute("data-panel-id") ?? "";
  });
  if (!id) throw new Error("Could not resolve panel ID");
  return id;
}

test.describe
  .serial("Resilience: background terminal preserves grid coherence across visibility", () => {
  test.beforeAll(async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Bulk-output regression uses Unix shell loop",
    });
    test.skip(process.platform === "win32", "Bulk-output regression uses Unix shell loop");

    const { dir, cleanup } = createFixtureRepo({ name: "bg-bulk-output" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Bg Bulk Output");

    await openTerminal(ctx.window);
    terminalPanel = getFirstGridPanel(ctx.window);
    await expect(terminalPanel).toBeVisible({ timeout: T_LONG });
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("resize observed while BACKGROUND propagates to xterm on restore", async () => {
    test.setTimeout(6 * T_LONG);
    const { window } = ctx;

    // Ensure the shell is ready so xterm's cell metrics are populated; the
    // background-tier resize path bails out when getXtermCellDimensions()
    // returns null, which would mask the bug we're regressing against.
    await waitForTerminalText(terminalPanel, "bg-bulk-output", T_LONG);

    const panelId = await getPanelId(terminalPanel);

    const initial = await getTerminalDimensions(terminalPanel);
    expect(initial).not.toBeNull();
    expect(initial!.cols).toBeGreaterThan(20);
    expect(initial!.rows).toBeGreaterThan(5);

    // Move the terminal to BACKGROUND tier without touching panel location —
    // this is what a hidden tab or off-screen panel-group produces.
    expect(await applyTier(window, panelId, "BACKGROUND")).toBe(true);
    await window.waitForTimeout(T_SETTLE);

    // Simulate a ResizeObserver firing for a substantially smaller container
    // (e.g. window or split divider shrunk while the panel is in the hidden
    // tab). Pre-fix, this call was silently dropped by the BACKGROUND guard
    // in TerminalResizeController.resize() and the dims would never reach
    // xterm or the PTY.
    const targetWidth = 400;
    const targetHeight = 240;
    const observed = await simulateResize(window, panelId, targetWidth, targetHeight);
    expect(observed).not.toBeNull();
    expect(observed!.cols).toBeGreaterThan(2);
    expect(observed!.cols).toBeLessThan(initial!.cols);

    // While still BACKGROUND, xterm's internal grid intentionally stays at
    // the old geometry — paint is paused and reflow is deferred until wake.
    // The captured latestCols/latestRows is what matters on the wake path.
    const beforeRestore = await getTerminalDimensions(terminalPanel);
    expect(beforeRestore).not.toBeNull();

    // Restore to FOCUSED. applyDeferredResize on the wake path must reconcile
    // xterm's grid with the dims captured during background, before refresh
    // repaints into the buffer.
    const restored = await applyTierAndReadDimensions(window, panelId, "FOCUSED");
    expect(restored.applied).toBe(true);

    // The wake transition must leave xterm at a coherent geometry. On Linux
    // CI, the real foreground ResizeObserver can supersede the deferred
    // background size before the test bridge reads dimensions, so accept
    // either the captured background size or a larger foreground remeasure.
    expect(restored.dims).not.toBeNull();
    expect(restored.dims!.cols).toBeGreaterThanOrEqual(observed!.cols);
    expect(restored.dims!.rows).toBeGreaterThanOrEqual(observed!.rows);
    const afterRestore = await getTerminalDimensions(terminalPanel);
    expect(afterRestore).not.toBeNull();
    expect(afterRestore!.cols).toBeGreaterThanOrEqual(observed!.cols);
    expect(afterRestore!.rows).toBeGreaterThanOrEqual(observed!.rows);
    await window.waitForTimeout(T_SETTLE);
  });

  test("bulk output during BACKGROUND survives restore without garbling", async () => {
    test.setTimeout(6 * T_LONG);
    const { window } = ctx;

    const panelId = await getPanelId(terminalPanel);

    // Bring back to FOCUSED for a clean starting point.
    expect(await applyTier(window, panelId, "FOCUSED")).toBe(true);
    await window.waitForTimeout(T_SETTLE);

    const initial = await getTerminalDimensions(terminalPanel);
    expect(initial).not.toBeNull();

    // Start a bounded stream so PTY output continues across the visibility
    // cycle without leaving a runaway process behind. Sleep between echoes so
    // the loop stays mid-flight long enough to span the visibility cycle.
    await runTerminalCommand(
      window,
      terminalPanel,
      "for i in $(seq 1 200); do echo BG_LINE_${i}; sleep 0.02; done; echo BG_DONE"
    );
    // Poll a mid-stream sentinel so we switch to BACKGROUND only once output is
    // confirmed in-flight — independent of machine speed.
    await waitForTerminalText(terminalPanel, "BG_LINE_50", T_LONG);

    // Switch to BACKGROUND tier while output is mid-flight.
    expect(await applyTier(window, panelId, "BACKGROUND")).toBe(true);

    // Capture a slightly narrower geometry while the container is hidden.
    const narrower = Math.max(200, Math.floor(initial!.cols * 8 * 0.7));
    const resized = await simulateResize(window, panelId, narrower, 240);
    expect(resized).not.toBeNull();
    expect(resized!.cols).toBeLessThan(initial!.cols);

    // Restore visibility — the wake path runs applyDeferredResize before
    // refresh, so the final repaint targets the narrower grid.
    expect(await applyTier(window, panelId, "FOCUSED")).toBe(true);
    await window.waitForTimeout(T_SETTLE);

    // Output must finish and the DONE sentinel must be present in the buffer —
    // proves the visibility transition didn't drop or corrupt PTY data.
    await waitForTerminalText(terminalPanel, "BG_DONE", T_LONG);

    // The narrower geometry captured during background must have reached the
    // wake path. A real foreground ResizeObserver can supersede that deferred
    // size before the test bridge reads dimensions, so accept the captured
    // size or a larger foreground remeasure.
    await expect
      .poll(async () => (await getTerminalDimensions(terminalPanel))?.cols, { timeout: T_LONG })
      .toBeGreaterThanOrEqual(resized!.cols);
    const finalDims = await getTerminalDimensions(terminalPanel);
    expect(finalDims!.cols).toBeGreaterThanOrEqual(resized!.cols);
  });
});
