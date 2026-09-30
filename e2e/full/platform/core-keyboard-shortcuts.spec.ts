import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { expectTerminalFocused } from "../../helpers/focus";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
const mod = process.platform === "darwin" ? "Meta" : "Control";

// Wait for the HUD between strokes so the second key lands in the pending chord.
async function pressChord(page: Page, first: string, second: string) {
  await page.keyboard.press(first);
  await expect(page.locator("[data-command-hud]")).toBeVisible({ timeout: T_MEDIUM });
  await page.keyboard.press(second);
}

test.describe.serial("Core: Keyboard Shortcuts", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
    const { dir, cleanup } = createFixtureRepo({ name: "keyboard-shortcuts" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Keyboard Shortcuts Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Single-Key Shortcuts ───────────────────────────────────

  test.describe.serial("Single-Key Shortcuts", () => {
    test("Cmd+Shift+P opens action palette", async () => {
      const { window } = ctx;
      await window.keyboard.press(`${mod}+Shift+p`);
      const dialog = window.locator(SEL.actionPalette.dialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await window.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Cmd+P opens quick switcher", async () => {
      const { window } = ctx;
      await window.locator(SEL.toolbar.projectSwitcherTrigger).focus();
      await window.keyboard.press(`${mod}+p`);
      const dialog = window.locator(SEL.quickSwitcher.dialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await window.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Cmd+Alt+T opens a new terminal each press", async () => {
      const { window } = ctx;
      for (let press = 0; press < 2; press++) {
        const before = await getGridPanelCount(window);
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
      }
    });

    test("Cmd+, opens settings", async () => {
      const { window } = ctx;
      await window.keyboard.press(`${mod}+,`);
      const dialog = window.getByRole("dialog").filter({
        has: window.locator(SEL.settings.heading),
      });
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      const closeBtn = window.locator(SEL.settings.closeButton);
      await closeBtn.click();
      await expect(dialog).not.toBeAttached({ timeout: T_SHORT });
    });

    test("Cmd+B toggles sidebar off and on", async () => {
      const { window } = ctx;
      const aside = window.locator(SEL.sidebar.aside);
      await expect(aside).toHaveAttribute("aria-hidden", "false", { timeout: T_SHORT });

      await window.locator(SEL.toolbar.projectSwitcherTrigger).focus();
      await window.keyboard.press(`${mod}+b`);
      await expect(aside).toHaveAttribute("aria-hidden", "true", { timeout: T_SHORT });

      await window.keyboard.press(`${mod}+b`);
      await expect(aside).toHaveAttribute("aria-hidden", "false", { timeout: T_SHORT });
    });

    test("toolbar button toggles sidebar off and on", async () => {
      const { window } = ctx;
      const aside = window.locator(SEL.sidebar.aside);
      await expect(aside).toHaveAttribute("aria-hidden", "false", { timeout: T_MEDIUM });

      await window.locator(SEL.toolbar.toggleSidebar).click();
      await expect(aside).toHaveAttribute("aria-hidden", "true", { timeout: T_SHORT });

      await window.locator(SEL.toolbar.toggleSidebar).click();
      await expect(aside).toHaveAttribute("aria-hidden", "false", { timeout: T_SHORT });
    });

    test("Cmd+W closes the focused panel, down to the last one", async () => {
      const { window } = ctx;
      // Keep a second panel around so Cmd+W never closes the last one (which quits).
      if ((await getGridPanelCount(window)) < 3) {
        const before = await getGridPanelCount(window);
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
      }

      for (let close = 0; close < 2; close++) {
        const before = await getGridPanelCount(window);
        expect(before).toBeGreaterThanOrEqual(2);
        const panel = window.locator(SEL.panel.gridPanel).first();
        const closeButton = panel.locator(SEL.panel.close).first();
        await panel.click();
        // The click hands focus to the terminal on a later frame; park focus on
        // the panel's close button (so Cmd/Ctrl+W can't reach the PTY) once
        // that handoff has happened.
        await expect(async () => {
          await closeButton.focus();
          await expect(closeButton).toBeFocused({ timeout: 500 });
        }).toPass({ timeout: T_MEDIUM });

        await window.keyboard.press(`${mod}+w`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
      }
    });
  });

  // ── Chord Sequences ────────────────────────────────────────

  test.describe.serial("Chord Sequences", () => {
    const chordIndicator = () => ctx.window.locator("[data-command-hud]");

    test("Cmd+K shows command HUD and Escape cancels it", async () => {
      const { window } = ctx;
      await window.locator(SEL.toolbar.projectSwitcherTrigger).focus();
      await window.keyboard.press(`${mod}+k`);
      await expect(chordIndicator()).toBeVisible({ timeout: T_MEDIUM });
      await window.keyboard.press("Escape");
      await expect(chordIndicator()).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Cmd+K Cmd+S opens keyboard shortcuts reference", async () => {
      const { window } = ctx;
      await expect(chordIndicator()).not.toBeVisible({ timeout: T_SHORT });
      await window.locator(SEL.toolbar.projectSwitcherTrigger).focus();
      await pressChord(window, `${mod}+k`, `${mod}+s`);

      const title = window.locator('[role="dialog"] h1, [role="dialog"] h2').filter({
        hasText: "Keyboard Shortcuts",
      });
      await expect(title).toBeVisible({ timeout: T_MEDIUM });

      const closeBtn = window.getByRole("button", { name: "Close dialog" });
      await closeBtn.click();
      await expect(title).not.toBeAttached({ timeout: T_SHORT });
    });

    test("Cmd+K Cmd+O opens worktree palette", async () => {
      const { window } = ctx;
      await window.locator(SEL.toolbar.projectSwitcherTrigger).focus();
      await pressChord(window, `${mod}+k`, `${mod}+o`);

      const palette = window.locator('[role="dialog"][aria-label="Worktree palette"]');
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      await window.keyboard.press("Escape");
      await expect(palette).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Terminal Search Routing ────────────────────────────────

  test.describe.serial("Terminal Search Routing", () => {
    // On Linux, Ctrl+F is intercepted by xterm's TUI keybind guard
    test.beforeAll(() => {
      test.info().annotations.push({
        type: "platform-skip",
        description: "Cmd+F terminal search only testable on macOS",
      });

      test.skip(process.platform !== "darwin", "Cmd+F terminal search only testable on macOS");
    });

    test("Cmd+F opens terminal search when terminal is focused", async () => {
      const { window } = ctx;

      // Ensure at least one terminal panel exists
      const count = await getGridPanelCount(window);
      if (count === 0) {
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBeGreaterThan(0);
      }

      const panel = window
        .locator(SEL.panel.gridPanel)
        .filter({ has: window.locator(SEL.terminal.xtermRows) })
        .first();
      await panel.locator(SEL.terminal.xtermRows).click();
      await expectTerminalFocused(panel);

      await window.keyboard.press(`${mod}+f`);
      const searchInput = window.locator(SEL.terminal.searchInput);
      await expect(searchInput).toBeVisible({ timeout: T_MEDIUM });

      // Close search
      const searchClose = window.locator(SEL.terminal.searchClose);
      await searchClose.click();
      await expect(searchInput).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
