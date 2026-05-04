import { test, expect } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { mockOpenDialog, refreshActiveWindow } from "./launch";
import { dismissTelemetryConsent } from "./project";
import { waitForTerminalText } from "./terminal";
import { getGridPanelCount, openTerminal } from "./panels";
import { SEL } from "./selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "./timeouts";

export async function addAndSwitchToProject(
  app: ElectronApplication,
  window: Page,
  projectPath: string,
  projectName: string
): Promise<Page> {
  await test.step(
    `Add and switch to project "${projectName}"`,
    async () => {
      await mockOpenDialog(app, projectPath);

      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      const addBtn = window.locator(SEL.projectSwitcher.addButton);
      await expect(addBtn).toBeVisible({ timeout: T_SHORT });
      await addBtn.click({ force: true });
    },
    { box: true }
  );
  const newWindow = await refreshActiveWindow(app, window);
  await dismissTelemetryConsent(newWindow);
  return newWindow;
}

/**
 * Click an existing project in the project switcher palette.
 *
 * After WebContentsView migration, switching projects creates/activates a
 * different WebContentsView, which means the caller's `Page` reference
 * becomes stale. Callers that need the new active page should use
 * {@link selectExistingProjectAndRefresh} instead.
 */
export async function selectExistingProject(window: Page, projectName: string): Promise<void> {
  await test.step(
    `Switch to existing project "${projectName}"`,
    async () => {
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      await palette.getByText(projectName, { exact: true }).first().click();
      // After WebContentsView migration the palette is rendered in the
      // outgoing project's view, which is hidden (not destroyed) once the
      // switch lands — so the close-after-click assertion can race with the
      // view swap. Best-effort wait, but don't fail if the prior view never
      // gets a chance to close the palette in its own React tree.
      await expect(palette)
        .not.toBeVisible({ timeout: T_MEDIUM })
        .catch(() => undefined);
    },
    { box: true }
  );
}

/**
 * Click an existing project in the project switcher palette and return the
 * new active project view page. Use this when the caller needs to interact
 * with the project after switching — the prior `Page` reference will be
 * pointing at the now-cached previous project's WebContentsView and most
 * locator queries will return stale or zero results.
 */
export async function selectExistingProjectAndRefresh(
  app: ElectronApplication,
  window: Page,
  projectName: string
): Promise<Page> {
  await selectExistingProject(window, projectName);
  return await refreshActiveWindow(app, window);
}

export async function spawnTerminalAndVerify(
  window: Page,
  expectedText?: string
): Promise<Locator> {
  return await test.step(
    "Spawn terminal and verify",
    async () => {
      const countBefore = await getGridPanelCount(window);

      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

      const panel = window.locator(SEL.panel.gridPanel).last();
      await expect(panel).toBeVisible({ timeout: T_MEDIUM });

      if (expectedText) {
        await waitForTerminalText(panel, expectedText);
      }

      return panel;
    },
    { box: true }
  );
}

export async function switchWorktree(window: Page, branchName: string): Promise<void> {
  await test.step(
    `Switch to worktree "${branchName}"`,
    async () => {
      const card = window.locator(SEL.worktree.card(branchName));
      // Click near the top of the card to hit the header area, avoiding
      // nested buttons (collapse/expand/details) that stopPropagation.
      await card.click({ position: { x: 100, y: 10 } });
      await expect(card).toHaveAttribute("aria-label", /selected/, {
        timeout: T_MEDIUM,
      });
    },
    { box: true }
  );
}

export async function verifyTerminalContent(
  panelLocator: Locator,
  text: string,
  timeout?: number
): Promise<void> {
  await test.step(
    `Verify terminal contains "${text}"`,
    async () => {
      await waitForTerminalText(panelLocator, text, timeout);
    },
    { box: true }
  );
}
