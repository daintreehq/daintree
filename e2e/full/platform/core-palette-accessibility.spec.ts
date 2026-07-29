import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { ensureWindowFocused } from "../../helpers/focus";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

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

/**
 * Open the new-terminal palette via its dedicated event — it has no production
 * keyboard/toolbar trigger (see useAppEventListeners).
 */
async function openNewTerminalPalette(window: Page): Promise<void> {
  await window.evaluate(() =>
    window.dispatchEvent(new CustomEvent("daintree:open-new-terminal-palette"))
  );
}

async function openPanelPalette(window: Page): Promise<void> {
  await window.evaluate(() =>
    (
      window as unknown as {
        __daintreeDispatchAction: (actionId: string) => Promise<unknown>;
      }
    ).__daintreeDispatchAction("panel.palette")
  );
}

test.describe.serial("Core: Command Palette Accessibility", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "palette-a11y",
      withMultipleFiles: true,
    });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Palette A11y Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.afterEach(async () => {
    // Restore any emulated media so later tests start from defaults.
    await ctx.window
      .emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" })
      .catch(() => undefined);
    await resetToApp(ctx.window);
  });

  test("palette dialog ships co-located polite and assertive live regions", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await openNewTerminalPalette(window);
    const dialog = window.locator(SEL.newTerminalPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    // Structural assertion — unaffected by document.ariaNotify, which can bypass
    // the DOM text path entirely on Chromium 146.
    await expect
      .poll(() => dialog.locator('.sr-only[aria-live="polite"]').count(), { timeout: T_MEDIUM })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => dialog.locator('.sr-only[aria-live="assertive"]').count(), { timeout: T_MEDIUM })
      .toBeGreaterThanOrEqual(1);
  });

  test("new terminal palette exposes a result-count live region", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    await openNewTerminalPalette(window);
    await expect(window.locator(SEL.newTerminalPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });

    // The new-terminal palette renders a hardcoded "{N} terminal types" status
    // region (not announcer-driven), so its text is a reliable signal.
    const liveRegion = window.locator(SEL.newTerminalPalette.liveRegion);
    await expect(liveRegion).toContainText(/terminal types/, { timeout: T_MEDIUM });
  });

  test("reduced motion: palette still opens and closes", async () => {
    const { window } = ctx;
    await window.emulateMedia({ reducedMotion: "reduce" });
    await ensureWindowFocused(ctx.app);

    await openPanelPalette(window);
    const dialog = window.locator(SEL.panelPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.panelPalette.options).first()).toBeVisible({
      timeout: T_MEDIUM,
    });

    await window.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("forced colors: palette opens with a non-color selection cue", async () => {
    const { window } = ctx;

    const supported = await window
      .emulateMedia({ forcedColors: "active" })
      .then(() => true)
      .catch(() => false);
    if (!supported) {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "forced-colors emulation not supported in this runtime",
      });
      test.skip();
      return;
    }

    await ensureWindowFocused(ctx.app);
    await openPanelPalette(window);
    const dialog = window.locator(SEL.panelPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    // Selection must be conveyed by aria-selected (not colour alone) so it
    // survives forced-colors mode.
    const options = window.locator(SEL.panelPalette.options);
    await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    await window.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("action palette restores focus to the triggering toolbar button on Escape", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);
    await resetToApp(window);

    const trigger = window.locator(SEL.toolbar.toggleSidebar);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await trigger.focus();
    await expect(trigger).toBeFocused({ timeout: T_SHORT });

    await window.keyboard.press(`${mod}+Shift+P`);
    await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
    const actionInput = window.locator(SEL.actionPalette.searchInput);
    await actionInput.focus();
    await expect(actionInput).toBeFocused({ timeout: T_SHORT });
    await window.waitForTimeout(T_SETTLE);

    await actionInput.press("Escape");
    await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    await expect(trigger).toBeFocused({ timeout: T_MEDIUM });
  });

  test("theme palette restores focus to the triggering toolbar button on Escape", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);
    await resetToApp(window);

    const trigger = window.locator(SEL.toolbar.toggleSidebar);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await trigger.focus();
    await expect(trigger).toBeFocused({ timeout: T_SHORT });

    await window.keyboard.press(`${mod}+K`);
    await window.waitForTimeout(120);
    await trigger.focus();
    await expect(trigger).toBeFocused({ timeout: T_MEDIUM });
    await window.keyboard.press(`${mod}+t`);
    await expect(window.locator(SEL.themePalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator('[role="tooltip"][data-state="open"]')).toHaveCount(0, {
      timeout: T_MEDIUM,
    });
    const themeInput = window.locator(SEL.themePalette.searchInput);
    await themeInput.focus();
    await expect(themeInput).toBeFocused({ timeout: T_SHORT });

    await themeInput.press("Escape");
    await expect(window.locator(SEL.themePalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    await expect(trigger).toBeFocused({ timeout: T_MEDIUM });
  });

  test("nested action -> # -> panel palette handoff releases focus on Escape", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);
    await resetToApp(window);

    await test.step("Open the action palette, then hand off to the panel palette via '#'", async () => {
      await window.keyboard.press(`${mod}+Shift+P`);
      const actionInput = window.locator(SEL.actionPalette.searchInput);
      await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });
      await actionInput.press("#");
      await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.panelPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.panelPalette.searchInput)).toBeFocused({ timeout: T_SHORT });
    });

    await test.step("Escape closes the chain and focus is not trapped in a dismissed palette", async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.panelPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.actionPalette.dialog)).toHaveCount(0, { timeout: T_MEDIUM });

      // Focus must leave the palette overlay — it must not remain inside any
      // (now-dismissed) dialog. The exact landing element after a palette-to-
      // palette handoff is an implementation detail; the contract under test is
      // that focus is released, not trapped.
      const focusInDialog = await window.evaluate(() =>
        Boolean(document.activeElement?.closest('[role="dialog"]'))
      );
      expect(focusInDialog).toBe(false);
    });
  });

  test("action palette MRU rail surfaces a recently used action after execution", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);
    await resetToApp(window);

    await test.step("Execute a benign action to populate the MRU", async () => {
      await window.keyboard.press(`${mod}+Shift+P`);
      const actionInput = window.locator(SEL.actionPalette.searchInput);
      await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });
      await actionInput.fill("Toggle sidebar");
      await window.waitForTimeout(T_SETTLE);
      const options = window.locator(SEL.palettePrefix.actionEnabledOptions);
      await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
      await actionInput.press("Enter");
      await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("Reopen with an empty query and verify the Recently used rail", async () => {
      await window.keyboard.press(`${mod}+Shift+P`);
      await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
      // MRU persists via async IPC, so poll generously for the section to appear.
      await expect(window.locator(SEL.palettePrefix.recentlyUsedHeader)).toBeVisible({
        timeout: T_LONG,
      });
      // The action we just executed must be the one recorded in the rail.
      const recentToggle = window
        .locator(SEL.palettePrefix.actionEnabledOptions)
        .filter({ hasText: "Toggle sidebar" });
      await expect(recentToggle.first()).toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("Restore the sidebar state via the same action", async () => {
      const actionInput = window.locator(SEL.actionPalette.searchInput);
      await actionInput.fill("Toggle sidebar");
      await window.waitForTimeout(T_SETTLE);
      const options = window.locator(SEL.palettePrefix.actionEnabledOptions);
      await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
      await actionInput.press("Enter");
      await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    });
  });
});
