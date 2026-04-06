import { test, expect } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { mockOpenDialog, refreshActiveWindow } from "./launch";
import { completeOnboarding } from "./project";
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

      await completeOnboarding(window, projectName);
    },
    { box: true }
  );
  return await refreshActiveWindow(app, window);
}

export async function selectExistingProject(window: Page, projectName: string): Promise<void> {
  await test.step(
    `Switch to existing project "${projectName}"`,
    async () => {
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      await palette.locator(`text="${projectName}"`).click();
      await expect(palette).not.toBeVisible({ timeout: T_MEDIUM });
    },
    { box: true }
  );
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
