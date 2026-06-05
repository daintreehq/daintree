import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openProject, dismissTelemetryConsent } from "../../helpers/project";
import { refreshActiveWindow } from "../../helpers/launch";
import {
  waitForTerminalText,
  runTerminalCommand,
  selectAllTerminalText,
  openTerminalContextMenu,
  clickTerminalContextMenuItem,
} from "../../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

async function ensureProjectIsOpen(): Promise<void> {
  if (ctx.window.isClosed()) {
    ctx.window = await refreshActiveWindow(ctx.app);
  }

  const worktreeCard = ctx.window.locator("[data-worktree-branch]").first();
  if (await worktreeCard.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  await openProject(ctx.app, ctx.window, fixtureDir);
  ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
  await dismissTelemetryConsent(ctx.window);
  await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
    timeout: T_LONG,
  });
}

async function ensureTerminalPanel() {
  await ensureProjectIsOpen();
  let panel = getFirstGridPanel(ctx.window);
  const hasTerminal = await panel
    .locator(SEL.terminal.xtermRows)
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!hasTerminal) {
    await openTerminal(ctx.window);
    panel = getFirstGridPanel(ctx.window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
    await expect(panel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_LONG });
  }

  return panel;
}

test.describe.serial("Core: Terminal Context Menu", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "terminal-context-menu",
    }));
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Project Open ───────────────────────────────────────────

  test.describe.serial("Project Open", () => {
    test("open folder and switch to project view", async () => {
      await openProject(ctx.app, ctx.window, fixtureDir);

      ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
      await dismissTelemetryConsent(ctx.window);
    });

    test("worktree dashboard appears", async () => {
      await ensureProjectIsOpen();
    });
  });

  // ── Context Menu Tests ─────────────────────────────────────

  test.describe.serial("Context Menu", () => {
    test("open terminal and produce output", async () => {
      await ensureProjectIsOpen();
      const { window } = ctx;
      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });

      await runTerminalCommand(window, panel, "echo CONTEXT_MENU_TEST");
      await waitForTerminalText(panel, "CONTEXT_MENU_TEST", T_LONG);
    });

    test("right-click opens context menu with expected items", async () => {
      const panel = await ensureTerminalPanel();
      const { window } = ctx;

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
        await expect(
          window.getByRole("menuitem", { name: new RegExp(`^${name}\\b`, "i") })
        ).toBeVisible({
          timeout: T_SHORT,
        });
      }

      await window.keyboard.press("Escape");
      await expect(menu).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Copy is disabled when no text is selected", async () => {
      const panel = await ensureTerminalPanel();
      const { window } = ctx;

      await openTerminalContextMenu(panel);

      const copyItem = window.getByRole("menuitem", { name: "Copy" });
      await expect(copyItem).toBeVisible({ timeout: T_SHORT });
      await expect(copyItem).toHaveAttribute("data-disabled", { timeout: T_SHORT });

      await window.keyboard.press("Escape");
    });

    test("Copy is enabled after selecting text", async () => {
      const panel = await ensureTerminalPanel();
      const { window } = ctx;

      await selectAllTerminalText(panel);
      await openTerminalContextMenu(panel, { preserveSelection: true });

      const copyItem = window.getByRole("menuitem", { name: "Copy" });
      await expect(copyItem).toBeVisible({ timeout: T_SHORT });
      await expect(copyItem).not.toHaveAttribute("data-disabled", { timeout: T_SHORT });

      await window.keyboard.press("Escape");
    });

    test("clicking Rename Terminal dispatches rename event and closes menu", async () => {
      const panel = await ensureTerminalPanel();
      const { window } = ctx;
      const panelId = await panel.getAttribute("data-panel-id");
      expect(panelId).toBeTruthy();

      await window.evaluate(() => {
        const target = window as Window & {
          __daintreeTerminalRenameEvents?: unknown[];
        };
        target.__daintreeTerminalRenameEvents = [];
        window.addEventListener(
          "daintree:rename-terminal",
          (event) => {
            target.__daintreeTerminalRenameEvents?.push((event as CustomEvent).detail);
          },
          { once: true }
        );
      });

      await openTerminalContextMenu(panel);
      await clickTerminalContextMenuItem(panel, "Rename Terminal");

      const menu = window.locator(SEL.contextMenu.content);
      await expect(menu).not.toBeVisible({ timeout: T_SHORT });
      await expect
        .poll(
          () =>
            window.evaluate(
              () =>
                (
                  window as Window & {
                    __daintreeTerminalRenameEvents?: Array<{ id?: string }>;
                  }
                ).__daintreeTerminalRenameEvents?.at(0)?.id ?? null
            ),
          { timeout: T_SHORT }
        )
        .toBe(panelId);
    });

    test("context menu closes on Escape", async () => {
      const panel = await ensureTerminalPanel();
      const { window } = ctx;

      await openTerminalContextMenu(panel);

      const menu = window.locator(SEL.contextMenu.content);
      await expect(menu).toBeVisible({ timeout: T_SHORT });

      await window.keyboard.press("Escape");
      await expect(menu).not.toBeVisible({ timeout: T_SHORT });
    });

    test("selecting menu item closes menu and performs action", async () => {
      const panel = await ensureTerminalPanel();
      const { window } = ctx;

      await openTerminalContextMenu(panel);

      const menu = window.locator(SEL.contextMenu.content);
      await clickTerminalContextMenuItem(panel, "Lock Input");

      await expect(menu).not.toBeVisible({ timeout: T_SHORT });

      // Verify the action toggled — re-open menu should show "Unlock Input"
      await openTerminalContextMenu(panel);
      await expect(window.getByRole("menuitem", { name: "Unlock Input" })).toBeVisible({
        timeout: T_SHORT,
      });

      // Toggle back
      await clickTerminalContextMenuItem(panel, "Unlock Input");
    });

    test("close terminal", async () => {
      const panel = await ensureTerminalPanel();
      const { window } = ctx;
      await panel.locator(SEL.panel.close).first().click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
    });
  });
});
