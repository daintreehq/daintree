/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron / __daintree* hooks are untyped in Playwright evaluate() */
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  mockOpenDialog,
  refreshActiveWindow,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject, dismissTelemetryConsent } from "../../helpers/project";
import { openTerminal } from "../../helpers/panels";
import { runTerminalCommand, waitForTerminalPty, getTerminalText } from "../../helpers/terminal";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

// Switch-back invariant guard for the "agent terminals render garbled until you
// click Redraw" bug. It drives the real flow — two projects, a backgrounded
// terminal still emitting, switch away/back, window resize during the 10s resize
// suppression window — and asserts the grid re-fits to the new container by
// reading the RENDERED rows (not xterm.cols alone).
//
// SCOPE / HONESTY: this is a GEOMETRY-recovery guard. It runs with the DOM
// renderer (WebGL is disabled in E2E), so it CANNOT catch the WebGL
// paint-staleness variant — a correct buffer/grid whose pixels are stale —
// which is the part of this bug that only a screenshot would show and that the
// existing recovery layers (reconcileGeometryFresh at reveal, ResizeObserver
// after the lock) already self-heal here. For the paint/alt-buffer/settled-agent
// variant, repro manually with e2e/fixtures/fake-claude-agent.cjs (full-screen
// alt-buffer + DEC 2026 synchronized output, like a real agent TUI).

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
const PROJECT_A_NAME = "project-A";
const PROJECT_B_NAME = "project-B";

interface ProjectInfo {
  id: string;
  name: string;
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
  const current = await getCurrentProject(page);
  if (current?.name === projectName) return page;

  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = page.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await page.waitForTimeout(T_SETTLE);

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

  await expect(palette)
    .not.toBeVisible({ timeout: T_LONG })
    .catch(() => undefined);

  const refreshed = await refreshActiveWindow(ctx.app, page);
  await refreshed.waitForTimeout(T_SETTLE);
  ctx.window = refreshed;
  return refreshed;
}

/** Parse the width the PTY most recently rendered against from its output. */
function latestPtyWidth(bufferText: string): number {
  const matches = [...bufferText.matchAll(/RULER:(\d+):/g)];
  if (matches.length === 0) return -1;
  return Number(matches[matches.length - 1]![1]);
}

/**
 * Classify the rendered terminal text (DOM visual rows). The emitter prints a
 * single logical line `RULER:<w>:###...Z` exactly `<w>` glyphs wide. When the
 * grid is wide enough it renders as ONE visual row ending in `Z` (complete).
 * When the grid is NARROWER than `<w>` the line wraps across visual rows, so
 * the row carrying the `RULER:` prefix loses its trailing `Z` (a wrapped head)
 * and the `Z` lands on an orphan continuation row — the literal "garbled line
 * flow" this bug produces.
 */
function analyzeRuler(text: string): {
  completeCount: number;
  wrappedCount: number;
  lastComplete: number | null;
  /** Classification of the most recent emission (bottom-most RULER head row). */
  lastKind: "complete" | "wrapped" | "none";
  lastWidth: number | null;
} {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const complete: number[] = [];
  let wrappedCount = 0;
  for (const line of lines) {
    const whole = line.match(/^RULER:(\d+):#*Z$/);
    if (whole) complete.push(Number(whole[1]));
    else if (/^RULER:(\d+):#+$/.test(line)) wrappedCount += 1;
  }
  // Most recent emission: scan bottom-up for the row carrying a RULER prefix.
  let lastKind: "complete" | "wrapped" | "none" = "none";
  let lastWidth: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const whole = lines[i]!.match(/^RULER:(\d+):#*Z$/);
    if (whole) {
      lastKind = "complete";
      lastWidth = Number(whole[1]);
      break;
    }
    const cut = lines[i]!.match(/^RULER:(\d+):#+$/);
    if (cut) {
      lastKind = "wrapped";
      lastWidth = Number(cut[1]);
      break;
    }
  }
  return {
    completeCount: complete.length,
    wrappedCount,
    lastComplete: complete.length ? complete[complete.length - 1]! : null,
    lastKind,
    lastWidth,
  };
}

/** Resize the host OS window while a project is backgrounded. */
async function resizeAppWindow(app: AppContext["app"], deltaW: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, dw) => {
    const win =
      BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()) ??
      BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No BrowserWindow to resize");
    const [w, h] = win.getSize();
    win.setSize(Math.max(640, w + dw), h);
  }, deltaW);
}

test.describe.serial("Core: Terminal redraw after project switch-back", () => {
  test.beforeAll(async () => {
    const fixtures = createFixtureRepos(2);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const [repoA, repoB] = fixtures.map((f) => f.dir);

    ctx = await launchApp();

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A_NAME);

    await mockOpenDialog(ctx.app, repoB);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });

    ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
    await dismissTelemetryConsent(ctx.window);

    await switchToProject(ctx.window, PROJECT_A_NAME);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("agent terminal grid re-syncs to the PTY after switch-away + window resize", async () => {
    test.slow();

    // 1. Project A: open a terminal and start the width-keyed emitter.
    await switchToProject(ctx.window, PROJECT_A_NAME);
    await openTerminal(ctx.window);
    const panelBefore = ctx.window.locator(SEL.panel.gridPanel).first();
    await expect(panelBefore).toBeVisible({ timeout: T_LONG });
    await waitForTerminalPty(ctx.window, panelBefore, T_LONG);

    const emitterPath = path.join(process.cwd(), "e2e/fixtures/ruler-emitter.cjs");
    await runTerminalCommand(ctx.window, panelBefore, `node ${JSON.stringify(emitterPath)}`);

    await expect
      .poll(async () => latestPtyWidth(await getTerminalText(panelBefore)), {
        timeout: T_LONG,
        intervals: [300, 600, 1000],
      })
      .toBeGreaterThan(1);
    const before = analyzeRuler(await getTerminalText(panelBefore));
    expect(before.lastKind).toBe("complete");
    const baselineWidth = before.lastComplete!;
    expect(baselineWidth).toBeGreaterThan(1);

    // 2. Switch away to B and straight back to A. Switching TO A re-arms the
    //    10s project-switch resize SUPPRESSION on A's terminals.
    await switchToProject(ctx.window, PROJECT_B_NAME);
    const page = await switchToProject(ctx.window, PROJECT_A_NAME);
    const panelBack = page.locator(SEL.panel.gridPanel).first();
    await expect(panelBack).toBeVisible({ timeout: T_LONG });

    // 3. GROW the window NOW — INSIDE A's suppression window. The reveal repaint
    //    already ran (grid matched the old size), so a fresh size change here is
    //    the one the system mishandles: the ResizeObserver fires but the resize
    //    lock drops it, and nothing re-fits the grid. The PTY likewise stays at
    //    the old width, so the emitter keeps printing the OLD width and the grid
    //    is now narrower than the container — "the layout flow hasn't happened
    //    and we're not doing the redraw". Only a post-suppression redraw re-syncs
    //    the grid (and PTY) to the new container width.
    await resizeAppWindow(ctx.app, 500);

    // 4. The grid+PTY must grow to the new container. Without the
    //    suppression-clear redraw the grid stays stuck at the old width forever
    //    (the dropped ResizeObserver never re-fires), so the emitted width never
    //    changes. Poll across the full recovery window, including the 10s
    //    suppression-clear redraw that is the hard guarantee.
    await expect
      .poll(
        async () => {
          const a = analyzeRuler(await getTerminalText(panelBack));
          return a.lastKind === "complete" && (a.lastWidth ?? 0) > baselineWidth;
        },
        { timeout: 25_000, intervals: [1000, 2000, 2000, 2000] }
      )
      .toBe(true);

    // The grid re-fit to the grown container — the emitter now reports a wider
    // width, rendered whole.
    const after = analyzeRuler(await getTerminalText(panelBack));
    expect(after.lastKind).toBe("complete");
    expect(after.lastWidth).toBeGreaterThan(baselineWidth);
  });
});
