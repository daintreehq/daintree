import { test, expect, type Locator } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount } from "../../helpers/panels";
import { ensureWindowFocused } from "../../helpers/focus";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

function worktreeRow(card: Locator): Locator {
  return card.locator("xpath=ancestor::*[@data-worktree-row][1]");
}

async function dispatchAction<Result = unknown>(
  ctx: AppContext,
  actionId: string,
  args?: unknown
): Promise<Result> {
  return await ctx.window.evaluate(
    async (payload) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            actionId: string,
            args?: unknown,
            options?: { source?: string; confirmed?: boolean }
          ) => Promise<{ ok: true; result: unknown } | { ok: false; error?: unknown }>;
        }
      ).__daintreeDispatchAction;
      if (typeof dispatch !== "function") {
        throw new Error("__daintreeDispatchAction is not available");
      }

      const result = await dispatch(payload.actionId, payload.args, { source: "menu" });
      if (!result?.ok) {
        throw new Error(`Action ${payload.actionId} failed: ${String(result?.error ?? "unknown")}`);
      }
      return result.result as Result;
    },
    { actionId, args }
  );
}

async function focusPanelByIndex(ctx: AppContext, index: number): Promise<void> {
  await dispatchAction(ctx, "panel.focusIndex", { index });
}

async function pressTerminalFocusShortcut(ctx: AppContext, shift = false): Promise<void> {
  await dispatchAction(ctx, shift ? "terminal.focusPrevious" : "terminal.focusNext");
}

async function getFocusedPanelId(ctx: AppContext): Promise<string | null> {
  const result = await dispatchAction<{ focusedPanelId: string | null }>(ctx, "panel.list");
  return result.focusedPanelId;
}

// ── Block 1: Terminal Navigation ──────────────────────────────

test.describe.serial("Core: Keyboard Terminal Navigation", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    ctx = await launchApp();
    const { dir, cleanup } = createFixtureRepo({ name: "kbd-nav-terminal" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Kbd Nav Terminal");

    // Wait for worktree detection to complete
    await ctx.window
      .locator("[data-worktree-branch]")
      .first()
      .waitFor({ state: "visible", timeout: T_LONG });

    // Spawn terminals until we have 3 in the grid
    const initial = await getGridPanelCount(ctx.window);
    const needed = 3 - initial;
    for (let i = 0; i < needed; i++) {
      await ctx.window.keyboard.press(`${mod}+Alt+t`);
      await expect
        .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
        .toBe(initial + i + 1);
    }

    // Wait for the last terminal to be ready
    await ctx.window
      .locator(SEL.terminal.xtermRows)
      .last()
      .waitFor({ state: "visible", timeout: T_LONG });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("Ctrl+Tab cycles forward through terminals", async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Ctrl+Tab is intercepted by the Linux window manager",
    });

    test.skip(process.platform === "linux", "Ctrl+Tab is intercepted by the Linux window manager");
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    // Click the first terminal to set a known starting point
    await window.locator(SEL.panel.gridPanel).first().locator(SEL.terminal.xtermRows).click();
    await focusPanelByIndex(ctx, 1);
    await window.waitForTimeout(T_SETTLE);
    const startId = await getFocusedPanelId(ctx);
    expect(startId).toBeTruthy();

    // Cycle forward: should move to a different panel
    await pressTerminalFocusShortcut(ctx);
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getFocusedPanelId(ctx), { timeout: T_LONG }).not.toBe(startId);
    const secondId = await getFocusedPanelId(ctx);

    // Cycle forward again: should move to yet another panel
    await pressTerminalFocusShortcut(ctx);
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getFocusedPanelId(ctx), { timeout: T_LONG }).not.toBe(secondId);
    const thirdId = await getFocusedPanelId(ctx);
    expect(new Set([startId, secondId, thirdId]).size).toBe(3);

    // Cycle once more: should wrap back to start
    await pressTerminalFocusShortcut(ctx);
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getFocusedPanelId(ctx), { timeout: T_LONG }).toBe(startId);
  });

  test("Ctrl+Shift+Tab cycles backward through terminals", async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Ctrl+Tab is intercepted by the Linux window manager",
    });

    test.skip(process.platform === "linux", "Ctrl+Tab is intercepted by the Linux window manager");
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    // Click the first terminal to set a known starting point
    await window.locator(SEL.panel.gridPanel).first().locator(SEL.terminal.xtermRows).click();
    await focusPanelByIndex(ctx, 1);
    await window.waitForTimeout(T_SETTLE);
    const startId = await getFocusedPanelId(ctx);
    expect(startId).toBeTruthy();

    // First discover the forward order by pressing Ctrl+Tab twice
    await pressTerminalFocusShortcut(ctx);
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getFocusedPanelId(ctx), { timeout: T_LONG }).not.toBe(startId);
    const forwardSecond = await getFocusedPanelId(ctx);

    await pressTerminalFocusShortcut(ctx);
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getFocusedPanelId(ctx), { timeout: T_LONG }).not.toBe(forwardSecond);
    const forwardThird = await getFocusedPanelId(ctx);

    // Return to start
    await window.locator(SEL.panel.gridPanel).first().locator(SEL.terminal.xtermRows).click();
    await focusPanelByIndex(ctx, 1);
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getFocusedPanelId(ctx), { timeout: T_LONG }).toBe(startId);

    // Cycle backward: should wrap to last panel (same as forward's third)
    await pressTerminalFocusShortcut(ctx, true);
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getFocusedPanelId(ctx), { timeout: T_LONG }).toBe(forwardThird);

    // Cycle backward again: should go to the second panel (reverse of forward)
    await pressTerminalFocusShortcut(ctx, true);
    await window.waitForTimeout(T_SETTLE);
    await expect.poll(() => getFocusedPanelId(ctx), { timeout: T_MEDIUM }).toBe(forwardSecond);
  });

  test("cycling with single panel is no-op", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    // Close panels until only 1 remains
    while ((await getGridPanelCount(window)) > 1) {
      const panel = window.locator(SEL.panel.gridPanel).last();
      await panel.locator(SEL.panel.close).first().click({ force: true });
      await window.waitForTimeout(T_SETTLE);
    }
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

    // Click the remaining panel to ensure focus
    const panel = window.locator(SEL.panel.gridPanel).first();
    await panel.locator(SEL.terminal.xtermRows).click();
    await focusPanelByIndex(ctx, 1);
    await window.waitForTimeout(T_SETTLE);
    const onlyId = await getFocusedPanelId(ctx);
    expect(onlyId).toBeTruthy();

    // Ctrl+Tab should stay on same panel
    await pressTerminalFocusShortcut(ctx);
    await window.waitForTimeout(T_SETTLE);
    expect(await getFocusedPanelId(ctx)).toBe(onlyId);

    // Ctrl+Shift+Tab should also stay
    await pressTerminalFocusShortcut(ctx, true);
    await window.waitForTimeout(T_SETTLE);
    expect(await getFocusedPanelId(ctx)).toBe(onlyId);
  });
});

// ── Block 2: Worktree Navigation ──────────────────────────────

const FEATURE_BRANCH = "feature/test-branch";

test.describe.serial("Core: Keyboard Worktree Navigation", () => {
  let ctx: AppContext;
  let mainBranch: string;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir: fixtureDir, cleanup } = createFixtureRepo({
      name: "kbd-nav-worktree",
      withFeatureBranch: true,
    });
    fixtureCleanup = cleanup;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Kbd Nav Worktree");

    // Wait for both worktree cards to appear
    const cards = ctx.window.locator("[data-worktree-branch]");
    await expect(cards).toHaveCount(2, { timeout: T_LONG });

    // Capture the main branch name
    mainBranch =
      (await ctx.window.locator(SEL.worktree.mainCard).getAttribute("data-worktree-branch")) ?? "";
    expect(mainBranch.length).toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("Cmd+Alt+] cycles to next worktree", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    // Verify main is initially current
    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });

    // Cycle next → feature
    await window.keyboard.press(`${mod}+Alt+]`);
    const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));
    await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });

    // Cycle next → main (wrap)
    await window.keyboard.press(`${mod}+Alt+]`);
    await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });
  });

  test("Cmd+Alt+[ cycles to previous worktree", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    // Main should be current from previous test
    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });

    // Cycle previous → feature (wrap)
    await window.keyboard.press(`${mod}+Alt+[`);
    const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));
    await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });

    // Cycle previous → main
    await window.keyboard.press(`${mod}+Alt+[`);
    await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });
  });

  test("Cmd+Alt+N jumps to worktree by index", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));

    // Jump to worktree 2 (feature)
    await window.keyboard.press(`${mod}+Alt+2`);
    await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });

    // Jump to out-of-range worktree 9 while on worktree 2 — should be no-op
    await window.keyboard.press(`${mod}+Alt+9`);
    await window.waitForTimeout(T_SETTLE);
    await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_SHORT,
    });

    // Jump to worktree 1 (main) to leave clean state
    await window.keyboard.press(`${mod}+Alt+1`);
    await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });
  });

  test("focus state visible via DOM attributes after keyboard navigation", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    // Switch to feature via keyboard
    await window.keyboard.press(`${mod}+Alt+2`);
    const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));
    await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });

    // Verify DOM attributes are correct
    await expect(featureCard).toHaveAttribute("data-worktree-branch", FEATURE_BRANCH);

    // Main row should NOT be current
    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(worktreeRow(mainCard)).not.toHaveAttribute("aria-current", "true", {
      timeout: T_SHORT,
    });

    // Switch back to main to leave clean state
    await window.keyboard.press(`${mod}+Alt+1`);
    await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
      timeout: T_MEDIUM,
    });
  });
});
