import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount, getFirstGridPanel, openTerminal } from "../../helpers/panels";
import { ensureWindowFocused, expectTerminalFocused } from "../../helpers/focus";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

async function openQuickSwitcher(window: Page): Promise<void> {
  if (process.platform === "darwin") {
    await window.keyboard.press(`${mod}+P`);
    return;
  }
  await window.evaluate(() =>
    (
      window as unknown as {
        __daintreeDispatchAction: (actionId: string) => Promise<unknown>;
      }
    ).__daintreeDispatchAction("nav.quickSwitcher")
  );
}

/**
 * Open the new-terminal palette. It has no production keyboard/toolbar trigger,
 * so it is opened via its dedicated event (see useAppEventListeners) — the same
 * programmatic pattern the app uses for the theme and log-level palettes.
 */
async function openNewTerminalPalette(window: Page): Promise<void> {
  await window.evaluate(() =>
    window.dispatchEvent(new CustomEvent("daintree:open-new-terminal-palette"))
  );
}

/** Close any open palette and return keyboard focus to the main content. */
async function resetToApp(window: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await window.keyboard.press("Escape").catch(() => undefined);
    await window.waitForTimeout(120);
  }
  await window
    .locator("main")
    .click({ force: true })
    .catch(() => undefined);
  await window.waitForTimeout(150);
}

test.describe.serial("Core: Specialized Command Palettes", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "specialized-palettes",
      withMultipleFiles: true,
    });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Specialized Palette Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.afterEach(async () => {
    await resetToApp(ctx.window);
  });

  // ── Panel Palette (Cmd+N) ─────────────────────────────────

  test("panel palette opens via shortcut with first option selected", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await window.keyboard.press(`${mod}+N`);
    const dialog = window.locator(SEL.panelPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await expect(window.locator(SEL.panelPalette.searchInput)).toBeFocused({ timeout: T_SHORT });

    const options = window.locator(SEL.panelPalette.options);
    await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
  });

  test("panel palette arrow keys move the active descendant", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await window.keyboard.press(`${mod}+N`);
    const searchInput = window.locator(SEL.panelPalette.searchInput);
    await expect(window.locator(SEL.panelPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });

    const options = window.locator(SEL.panelPalette.options);
    await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
    expect(await options.count()).toBeGreaterThanOrEqual(2);

    const initial = await searchInput.getAttribute("aria-activedescendant");
    await searchInput.press("ArrowDown");
    await expect
      .poll(() => searchInput.getAttribute("aria-activedescendant"), { timeout: T_MEDIUM })
      .not.toBe(initial);
    expect(await searchInput.getAttribute("aria-activedescendant")).toMatch(/^panel-option-/);
  });

  test("panel palette resets its query between opens", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await window.keyboard.press(`${mod}+N`);
    const searchInput = window.locator(SEL.panelPalette.searchInput);
    await expect(window.locator(SEL.panelPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });

    await searchInput.fill("term");
    await expect(searchInput).toHaveValue("term");
    await searchInput.press("Escape");
    await expect(searchInput).toHaveValue("");
    await searchInput.press("Escape");
    await expect(window.locator(SEL.panelPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });

    await window.keyboard.press(`${mod}+N`);
    await expect(window.locator(SEL.panelPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.panelPalette.searchInput)).toHaveValue("");
  });

  // ── New Terminal Palette (Cmd+Alt+T) ──────────────────────

  test("new terminal palette opens with first option selected", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await openNewTerminalPalette(window);
    const dialog = window.locator(SEL.newTerminalPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await expect(window.locator(SEL.newTerminalPalette.searchInput)).toBeFocused({
      timeout: T_SHORT,
    });

    const options = window.locator(SEL.newTerminalPalette.options);
    await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
  });

  test("new terminal palette resets its query between opens", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await openNewTerminalPalette(window);
    const searchInput = window.locator(SEL.newTerminalPalette.searchInput);
    const dialog = window.locator(SEL.newTerminalPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await searchInput.fill("browser");
    await expect(searchInput).toHaveValue("browser");

    await searchInput.press("Escape");
    await expect(searchInput).toHaveValue("");
    await searchInput.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // Reopening starts from a clean query (state isolation).
    await openNewTerminalPalette(window);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.newTerminalPalette.searchInput)).toHaveValue("");
  });

  test("new terminal palette launches a panel from a selected option", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const before = await getGridPanelCount(window);

    await openNewTerminalPalette(window);
    await expect(window.locator(SEL.newTerminalPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });

    // The Terminal/Browser options are always present (agents are CLI-gated). The
    // browser option launches a grid panel deterministically.
    const browserOption = window.locator(SEL.newTerminalPalette.browserOption);
    await expect(browserOption).toBeVisible({ timeout: T_MEDIUM });
    await browserOption.click();

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
    // Confirm it is the browser panel we asked for, not some other kind.
    await expect(window.locator(SEL.browser.addressBar)).toBeVisible({ timeout: T_LONG });

    // Clean up the panel we just opened.
    const panel = window.locator(SEL.panel.gridPanel).last();
    await panel.locator(SEL.panel.close).first().click({ force: true });
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before);
  });

  // ── Theme Palette (Cmd+K Cmd+T chord) ─────────────────────

  test("theme palette opens via chord and supports keyboard navigation", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    // Two-step chord: leader (Cmd/Ctrl+K) then Cmd/Ctrl+T.
    await window.keyboard.press(`${mod}+K`);
    await window.waitForTimeout(120);
    await window.keyboard.press(`${mod}+t`);

    const dialog = window.locator(SEL.themePalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = window.locator(SEL.themePalette.searchInput);
    await expect(searchInput).toBeFocused({ timeout: T_SHORT });

    const options = window.locator(SEL.themePalette.options);
    await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
    expect(await options.count()).toBeGreaterThanOrEqual(2);

    const initial = await searchInput.getAttribute("aria-activedescendant");
    await searchInput.press("ArrowDown");
    await expect
      .poll(() => searchInput.getAttribute("aria-activedescendant"), { timeout: T_MEDIUM })
      .not.toBe(initial);
    expect(await searchInput.getAttribute("aria-activedescendant")).toMatch(/^theme-option-/);

    await test.step("Filtering narrows the result set", async () => {
      const unfiltered = await options.count();
      await searchInput.fill("zzzznomatch");
      await window.waitForTimeout(T_SETTLE);
      expect(await options.count()).toBeLessThan(unfiltered);
    });
  });

  // ── Log Level Palette (two-step, via action palette) ──────

  test("log level palette advances from module step to level step", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await test.step("Open log level palette via the action palette command", async () => {
      await window.keyboard.press(`${mod}+Shift+P`);
      const actionInput = window.locator(SEL.actionPalette.searchInput);
      await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });
      await actionInput.fill("Set Log Level");
      await window.waitForTimeout(T_SETTLE);
      const actionOptions = window.locator(SEL.palettePrefix.actionEnabledOptions);
      await expect(actionOptions.first()).toBeVisible({ timeout: T_MEDIUM });
      await actionOptions.first().press("Enter");
    });

    const step1 = window.locator(SEL.logLevelPalette.step1Dialog);
    await expect(step1).toBeVisible({ timeout: T_MEDIUM });

    const step1Rows = window.locator(SEL.logLevelPalette.rows);
    await expect(step1Rows.first()).toBeVisible({ timeout: T_MEDIUM });

    await test.step("Confirm a module to advance to the level step", async () => {
      await window.locator(SEL.logLevelPalette.searchInput).press("Enter");
      const step2 = window.locator(SEL.logLevelPalette.step2Dialog);
      await expect(step2).toBeVisible({ timeout: T_MEDIUM });
      // Level choices (Debug/Info/Warn/Error/Off/Clear override).
      await expect(step2.getByText("Debug", { exact: true })).toBeVisible({ timeout: T_MEDIUM });
      await expect(step2.getByText("Off", { exact: true })).toBeVisible({ timeout: T_MEDIUM });
      await expect(step2.getByText("Clear override", { exact: true })).toBeVisible({
        timeout: T_MEDIUM,
      });
    });
  });

  test("log level palette resets to the module step on reopen", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const openToStep1 = async () => {
      await window.keyboard.press(`${mod}+Shift+P`);
      const actionInput = window.locator(SEL.actionPalette.searchInput);
      await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });
      await actionInput.fill("Set Log Level");
      await window.waitForTimeout(T_SETTLE);
      const actionOptions = window.locator(SEL.palettePrefix.actionEnabledOptions);
      await expect(actionOptions.first()).toBeVisible({ timeout: T_MEDIUM });
      await actionOptions.first().press("Enter");
      await expect(window.locator(SEL.logLevelPalette.step1Dialog)).toBeVisible({
        timeout: T_MEDIUM,
      });
    };

    await openToStep1();
    // Advance to step 2.
    await window.locator(SEL.logLevelPalette.searchInput).press("Enter");
    await expect(window.locator(SEL.logLevelPalette.step2Dialog)).toBeVisible({
      timeout: T_MEDIUM,
    });

    // Close and reopen — it must start on the module step again, not the level step.
    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.logLevelPalette.step2Dialog)).not.toBeVisible({
      timeout: T_MEDIUM,
    });
    await resetToApp(window);

    await openToStep1();
    await expect(window.locator(SEL.logLevelPalette.step1Dialog)).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(window.locator(SEL.logLevelPalette.step2Dialog)).not.toBeVisible({
      timeout: T_SHORT,
    });
  });

  // ── Prefix routing in the action palette ──────────────────

  test("typing '#' hands off from the action palette to the panel palette", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await window.keyboard.press(`${mod}+Shift+P`);
    const actionInput = window.locator(SEL.actionPalette.searchInput);
    await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });

    await actionInput.press("#");

    await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.panelPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("typing '@' hands off from the action palette to the worktree palette", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await window.keyboard.press(`${mod}+Shift+P`);
    const actionInput = window.locator(SEL.actionPalette.searchInput);
    await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });

    await actionInput.press("@");

    await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.palettePrefix.worktreeDialog)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("typing ':' routes the action palette to the prompt-history prefix", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await window.keyboard.press(`${mod}+Shift+P`);
    const actionInput = window.locator(SEL.actionPalette.searchInput);
    await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });

    await actionInput.press(":");

    // The `:` route hands off to the prompt-history palette, dismissing the
    // action palette. The prompt-history palette itself renders inside an agent
    // panel's input bar (CLI-gated), so assert the route fired via the handoff,
    // then confirm the target too when it is available in this launch.
    await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });

    const promptHistory = window.locator(SEL.palettePrefix.promptHistoryDialog);
    if (await promptHistory.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      await expect(promptHistory).toBeVisible();
    } else {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "Prompt-history palette requires an agent input bar (not present this launch)",
      });
    }
  });

  test("quick switcher lists recent panels and restores focus on Escape", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const before = await getGridPanelCount(window);

    await test.step("Open two terminal panels so the MRU list is populated", async () => {
      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 2);
    });

    const lastPanel = window.locator(SEL.panel.gridPanel).last();
    await lastPanel.locator(SEL.terminal.xtermRows).click();
    await expectTerminalFocused(lastPanel);

    await test.step("Quick switcher shows the recent panels", async () => {
      await openQuickSwitcher(window);
      await expect(window.locator(SEL.quickSwitcher.dialog)).toBeVisible({ timeout: T_MEDIUM });
      const options = window.locator(SEL.quickSwitcher.options);
      await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
      expect(await options.count()).toBeGreaterThanOrEqual(2);
    });

    await test.step("Escape closes the switcher and restores terminal focus", async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.quickSwitcher.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
      await expectTerminalFocused(lastPanel, T_MEDIUM);
    });

    await test.step("Clean up the terminals opened for this test", async () => {
      let count = await getGridPanelCount(window);
      while (count > before) {
        await getFirstGridPanel(window).locator(SEL.panel.close).first().click({ force: true });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
        count--;
      }
    });
  });

  test("prefix discoverability row shows on empty query and hides once typing starts", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await window.keyboard.press(`${mod}+Shift+P`);
    const actionInput = window.locator(SEL.actionPalette.searchInput);
    await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });

    const row = window.locator(SEL.palettePrefix.discoverabilityRow);
    await expect(row).toBeVisible({ timeout: T_MEDIUM });

    await actionInput.fill("toggle");
    await expect(row).toHaveCount(0, { timeout: T_MEDIUM });
  });

  test("typing '>' shows the commands mode chip and backspace removes it", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await window.keyboard.press(`${mod}+Shift+P`);
    const actionInput = window.locator(SEL.actionPalette.searchInput);
    await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });

    await actionInput.press(">");
    const chip = window.locator(SEL.palettePrefix.modeChip).filter({ hasText: "Commands" });
    await expect(chip).toHaveText("Commands", { timeout: T_MEDIUM });
    // The action palette stays open in commands mode (no handoff for '>').
    await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_SHORT });

    await actionInput.press("Backspace");
    await expect(chip).toHaveCount(0, { timeout: T_MEDIUM });
  });
});
