import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function pressChord(page: Page, first: string, second: string) {
  await page.keyboard.press(first);
  await page.waitForTimeout(100);
  await page.keyboard.press(second);
}

test.describe.serial("Core: Keyboard Shortcuts", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "keyboard-shortcuts" });
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Keyboard Shortcuts Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
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
      await window.keyboard.press(`${mod}+p`);
      const dialog = window.locator(SEL.quickSwitcher.dialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await window.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Cmd+Alt+T opens a new terminal", async () => {
      const { window } = ctx;
      const before = await getGridPanelCount(window);
      await window.keyboard.press(`${mod}+Alt+t`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
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
      const sidebar = window.locator("aside").first();
      await expect(sidebar).toBeVisible({ timeout: T_SHORT });

      await window.keyboard.press(`${mod}+b`);
      await expect(sidebar).not.toBeVisible({ timeout: T_SHORT });

      await window.keyboard.press(`${mod}+b`);
      await expect(sidebar).toBeVisible({ timeout: T_SHORT });
    });

    test("Cmd+W closes focused panel", async () => {
      const { window } = ctx;
      let before = await getGridPanelCount(window);

      if (before < 2) {
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
        before = before + 1;
      }

      const panel = window.locator(SEL.panel.gridPanel).first();
      await panel.click();
      await window.waitForTimeout(T_SETTLE);

      await window.keyboard.press(`${mod}+w`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
    });
  });

  // ── Chord Sequences ────────────────────────────────────────

  test.describe.serial("Chord Sequences", () => {
    const chordIndicator = () =>
      ctx.window.locator('[role="status"]').filter({ hasText: "Esc to cancel" });

    test("Cmd+K shows chord indicator", async () => {
      const { window } = ctx;
      await window.keyboard.press(`${mod}+k`);
      await expect(chordIndicator()).toBeVisible({ timeout: T_MEDIUM });
      await window.keyboard.press("Escape");
      await expect(chordIndicator()).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Escape cancels pending chord", async () => {
      const { window } = ctx;
      await window.keyboard.press(`${mod}+k`);
      await expect(chordIndicator()).toBeVisible({ timeout: T_MEDIUM });

      await window.keyboard.press("Escape");
      await expect(chordIndicator()).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Cmd+K Cmd+S opens keyboard shortcuts reference", async () => {
      const { window } = ctx;
      await window.waitForTimeout(200);
      await pressChord(window, `${mod}+k`, `${mod}+s`);

      const title = window.locator('[role="dialog"] h1, [role="dialog"] h2').filter({
        hasText: "Keyboard Shortcuts",
      });
      await expect(title).toBeVisible({ timeout: T_MEDIUM });

      await window.keyboard.press("Escape");
      await expect(title).not.toBeAttached({ timeout: T_SHORT });
    });

    test("Cmd+K W opens worktree palette", async () => {
      const { window } = ctx;
      await pressChord(window, `${mod}+k`, "w");

      const palette = window.locator('[role="dialog"][aria-label="Worktree palette"]');
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      // Close by clicking outside the palette content area
      await window.keyboard.press("Escape");
      await window.waitForTimeout(T_SETTLE);
      // Press Escape again to ensure palette is dismissed (first may be consumed by inner input)
      await window.keyboard.press("Escape");
      await window.waitForTimeout(T_SETTLE);
    });
  });

  // ── Terminal Search Routing ────────────────────────────────

  test.describe.serial("Terminal Search Routing", () => {
    // On Linux, Ctrl+F is intercepted by xterm's TUI keybind guard
    test.skip(process.platform !== "darwin", "Cmd+F terminal search only testable on macOS");

    test("Cmd+F opens terminal search when terminal is focused", async () => {
      const { window } = ctx;

      // Ensure at least one terminal panel exists
      const count = await getGridPanelCount(window);
      if (count === 0) {
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBeGreaterThan(0);
      }

      // Click on the terminal area to ensure focus
      const xtermScreen = window.locator(SEL.terminal.xtermRows).first();
      await xtermScreen.click();
      await window.waitForTimeout(T_SETTLE);

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
