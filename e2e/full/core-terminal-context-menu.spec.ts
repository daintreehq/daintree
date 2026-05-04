import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openProject, dismissTelemetryConsent } from "../helpers/project";
import { refreshActiveWindow } from "../helpers/launch";
import {
  waitForTerminalText,
  runTerminalCommand,
  selectAllTerminalText,
  openTerminalContextMenu,
} from "../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Terminal Context Menu", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "terminal-context-menu" });
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Project Open ───────────────────────────────────────────

  test.describe.serial("Project Open", () => {
    test("open folder and switch to project view", async () => {
      await openProject(ctx.app, ctx.window, fixtureDir);

      ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
      await dismissTelemetryConsent(ctx.window);
    });

    test("worktree dashboard appears", async () => {
      const worktreeCards = ctx.window.locator("[data-worktree-branch]");
      await expect(worktreeCards.first()).toBeVisible({ timeout: T_LONG });
    });
  });

  // ── Context Menu Tests ─────────────────────────────────────

  test.describe.serial("Context Menu", () => {
    test("open terminal and produce output", async () => {
      const { window } = ctx;
      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });

      await runTerminalCommand(window, panel, "echo CONTEXT_MENU_TEST");
      await waitForTerminalText(panel, "CONTEXT_MENU_TEST", T_LONG);
    });

    test("right-click opens context menu with expected items", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await openTerminalContextMenu(panel);

      const menu = window.locator(SEL.contextMenu.content);
      await expect(menu).toBeVisible({ timeout: T_SHORT });

      const expectedItems = [
        "Copy",
        "Paste",
        "Restart Terminal",
        "Rename Terminal",
        "Kill Terminal",
      ];
      for (const name of expectedItems) {
        await expect(window.getByRole("menuitem", { name })).toBeVisible({ timeout: T_SHORT });
      }

      await window.keyboard.press("Escape");
      await expect(menu).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Copy is disabled when no text is selected", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await openTerminalContextMenu(panel);

      const copyItem = window.getByRole("menuitem", { name: "Copy" });
      await expect(copyItem).toBeVisible({ timeout: T_SHORT });
      await expect(copyItem).toHaveAttribute("data-disabled", { timeout: T_SHORT });

      await window.keyboard.press("Escape");
    });

    test("Copy is enabled after selecting text", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await selectAllTerminalText(panel);
      await openTerminalContextMenu(panel);

      const copyItem = window.getByRole("menuitem", { name: "Copy" });
      await expect(copyItem).toBeVisible({ timeout: T_SHORT });
      await expect(copyItem).not.toHaveAttribute("data-disabled", { timeout: T_SHORT });

      await window.keyboard.press("Escape");
    });

    test("clicking Rename Terminal dispatches action and closes menu", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await openTerminalContextMenu(panel);

      const renameItem = window.getByRole("menuitem", { name: "Rename Terminal" });
      await renameItem.click();

      const menu = window.locator(SEL.contextMenu.content);
      await expect(menu).not.toBeVisible({ timeout: T_SHORT });

      // Verify the rename input appeared (proves the action dispatched)
      const titleInput = panel.locator('input[aria-label="Edit terminal title"]');
      await expect(titleInput).toBeVisible({ timeout: T_SHORT });

      // Wait for any context menu animation/overlay to fully clear
      await window.waitForTimeout(200);

      // Focus the input and type the new name via keyboard
      await titleInput.focus();
      await window.keyboard.type("Renamed Terminal");
      await window.keyboard.press("Enter");
      await expect(panel.locator('[role="button"][aria-label*="Renamed Terminal"]')).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("context menu closes on Escape", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await openTerminalContextMenu(panel);

      const menu = window.locator(SEL.contextMenu.content);
      await expect(menu).toBeVisible({ timeout: T_SHORT });

      await window.keyboard.press("Escape");
      await expect(menu).not.toBeVisible({ timeout: T_SHORT });
    });

    test("selecting menu item closes menu and performs action", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await openTerminalContextMenu(panel);

      const menu = window.locator(SEL.contextMenu.content);
      const lockItem = window.getByRole("menuitem", { name: "Lock Input" });
      await expect(lockItem).toBeVisible({ timeout: T_SHORT });
      await lockItem.click();

      await expect(menu).not.toBeVisible({ timeout: T_SHORT });

      // Verify the action toggled — re-open menu should show "Unlock Input"
      await openTerminalContextMenu(panel);
      await expect(window.getByRole("menuitem", { name: "Unlock Input" })).toBeVisible({
        timeout: T_SHORT,
      });

      // Toggle back
      await window.getByRole("menuitem", { name: "Unlock Input" }).click();
    });

    test("close terminal", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      await panel.locator(SEL.panel.close).first().click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
    });
  });
});
