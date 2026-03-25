import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import { TRASH_TTL_MS } from "../../shared/config/trash";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
let fixtureDir: string;

function uniqueMarker(): string {
  return `TRASH_MARKER_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function openTerminal(window: AppContext["window"]): Promise<void> {
  const before = await getGridPanelCount(window);
  await openTerminal(window);
  await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
}

async function closeFirstPanel(window: AppContext["window"]): Promise<void> {
  const before = await getGridPanelCount(window);
  const panel = getFirstGridPanel(window);
  await panel.locator(SEL.panel.close).first().click();
  await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
}

test.describe.serial("Core: Terminal Trash & Restore", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "trash-restore" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Trash Restore Test");

    const worktreeCards = ctx.window.locator("[data-worktree-branch]");
    await expect(worktreeCards.first()).toBeVisible({ timeout: T_LONG });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Trash and Restore via Keyboard Shortcut ─────────────

  test.describe.serial("Trash and Restore via Keyboard Shortcut", () => {
    const marker = uniqueMarker();

    test("close terminal moves it to trash, Cmd+Shift+T restores with content", async () => {
      const { window } = ctx;

      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await runTerminalCommand(window, panel, `echo "${marker}"`);
      await waitForTerminalText(panel, marker, T_LONG);

      await closeFirstPanel(window);

      const trashBtn = window.locator(SEL.trash.container);
      await expect(trashBtn).toBeVisible({ timeout: T_MEDIUM });

      await window.keyboard.press(`${mod}+Shift+T`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      const restored = getFirstGridPanel(window);
      await waitForTerminalText(restored, marker, T_LONG);

      // Trash container should disappear after restore (entry consumed)
      await expect(trashBtn).not.toBeVisible({ timeout: T_MEDIUM });
    });

    test("cleanup: close restored terminal", async () => {
      const { window } = ctx;
      const count = await getGridPanelCount(window);
      if (count > 0) {
        await closeFirstPanel(window);
      }
      await window.waitForTimeout(TRASH_TTL_MS + 3_000);
    });
  });

  // ── Restore via Trash Popover UI ────────────────────────

  test.describe.serial("Restore via Trash Popover UI", () => {
    const marker = uniqueMarker();

    test("close terminal and restore via popover restore button", async () => {
      const { window } = ctx;

      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await runTerminalCommand(window, panel, `echo "${marker}"`);
      await waitForTerminalText(panel, marker, T_LONG);

      await closeFirstPanel(window);

      const trashBtn = window.locator(SEL.trash.container);
      await expect(trashBtn).toBeVisible({ timeout: T_MEDIUM });
      await trashBtn.click();

      const popover = window.locator('[role="dialog"][aria-label="Recently closed terminals"]');
      await expect(popover).toBeVisible({ timeout: T_SHORT });

      const restoreBtn = popover.getByRole("button", { name: /Restore/ });
      await restoreBtn.first().click();

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      const restored = getFirstGridPanel(window);
      await waitForTerminalText(restored, marker, T_LONG);
    });

    test("cleanup: close restored terminal", async () => {
      const { window } = ctx;
      const count = await getGridPanelCount(window);
      if (count > 0) {
        await closeFirstPanel(window);
      }
      await window.waitForTimeout(TRASH_TTL_MS + 3_000);
    });
  });

  // ── Reopen Last Restores Most Recent ────────────────────

  test.describe.serial("Reopen Last Restores Most Recent", () => {
    const markerA = uniqueMarker();
    const markerB = uniqueMarker();

    test("closing A then B, reopen-last restores B", async () => {
      const { window } = ctx;

      // Open terminal A
      await openTerminal(window);
      const panelA = getFirstGridPanel(window);
      await runTerminalCommand(window, panelA, `echo "${markerA}"`);
      await waitForTerminalText(panelA, markerA, T_LONG);

      // Open terminal B
      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);

      const panels = window.locator(SEL.panel.gridPanel);
      const panelB = panels.last();
      await runTerminalCommand(window, panelB, `echo "${markerB}"`);
      await waitForTerminalText(panelB, markerB, T_LONG);

      // Close A (first panel), then B
      await panels.first().locator(SEL.panel.close).first().click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      await closeFirstPanel(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);

      // Reopen last — should restore B
      await window.keyboard.press(`${mod}+Shift+T`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      const restored = getFirstGridPanel(window);
      await waitForTerminalText(restored, markerB, T_LONG);
    });

    test("cleanup: close all and wait for trash expiry", async () => {
      const { window } = ctx;
      let count = await getGridPanelCount(window);
      while (count > 0) {
        await closeFirstPanel(window);
        count = await getGridPanelCount(window);
      }
      await window.waitForTimeout(TRASH_TTL_MS + 3_000);
    });
  });

  // ── TTL Expiry Permanently Removes Terminal ─────────────

  test.describe.serial("TTL Expiry Permanently Removes Terminal", () => {
    test("trashed terminal is permanently removed after TTL", async () => {
      test.setTimeout(120_000);
      const { window } = ctx;
      const marker = uniqueMarker();

      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await runTerminalCommand(window, panel, `echo "${marker}"`);
      await waitForTerminalText(panel, marker, T_LONG);

      await closeFirstPanel(window);

      const trashBtn = window.locator(SEL.trash.container);
      await expect(trashBtn).toBeVisible({ timeout: T_MEDIUM });

      // Wait for TTL to expire
      await window.waitForTimeout(TRASH_TTL_MS + 2_000);

      await expect(trashBtn).not.toBeVisible({ timeout: T_MEDIUM });
      expect(await getGridPanelCount(window)).toBe(0);

      // Reopen-last should be a no-op
      await window.keyboard.press(`${mod}+Shift+T`);
      await window.waitForTimeout(T_SETTLE);
      expect(await getGridPanelCount(window)).toBe(0);
    });
  });
});
