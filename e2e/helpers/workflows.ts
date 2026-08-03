import { test, expect } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import path from "path";
import { mockOpenDialog, refreshActiveWindow, waitForActiveProject } from "./launch";
import { dismissTelemetryConsent } from "./project";
import { waitForTerminalPty, waitForTerminalReady, waitForTerminalText } from "./terminal";
import { getGridPanelIds, getPanelById, openTerminal } from "./panels";
import { SEL } from "./selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "./timeouts";

const terminalShortcut = process.platform === "darwin" ? "Meta+Alt+t" : "Control+Alt+t";

export async function openProjectSwitcherPalette(window: Page): Promise<Locator> {
  const trigger = window.locator(SEL.toolbar.projectSwitcherTrigger);
  await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
  const palette = window.locator(SEL.projectSwitcher.palette);

  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await trigger.click({ force: true });
    try {
      await expect(palette).toBeVisible({ timeout: T_SHORT });
      opened = true;
    } catch {
      await window.waitForTimeout(250);
    }
  }
  if (!opened) {
    await trigger.click({ force: true });
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  }

  return palette;
}

async function dismissProjectSwitcherPalette(window: Page): Promise<void> {
  const palette = window.locator(SEL.projectSwitcher.palette);
  if (!(await palette.isVisible({ timeout: 500 }).catch(() => false))) return;

  await window.keyboard.press("Escape").catch(() => undefined);
  await expect(palette)
    .not.toBeVisible({ timeout: 1_000 })
    .catch(() => undefined);
}

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

      await openProjectSwitcherPalette(window);

      const palette = window.locator(SEL.projectSwitcher.palette);
      let clicked = false;
      for (let attempt = 0; attempt < 3 && !clicked; attempt += 1) {
        const addBtn = window.locator(SEL.projectSwitcher.addButton);
        await expect(addBtn).toBeVisible({ timeout: T_SHORT });
        try {
          await addBtn.click({ force: true, noWaitAfter: true, timeout: T_SHORT });
          clicked = true;
        } catch {
          if (!(await palette.isVisible().catch(() => false))) {
            clicked = true;
            break;
          }
          await window.waitForTimeout(250);
        }
      }
      if (!clicked) {
        const addBtn = window.locator(SEL.projectSwitcher.addButton);
        await addBtn.click({ force: true, noWaitAfter: true, timeout: T_MEDIUM });
      }
    },
    { box: true }
  );
  const newWindow = await waitForActiveProject(
    app,
    await refreshActiveWindow(app, window),
    path.basename(projectPath)
  );
  await dismissProjectSwitcherPalette(newWindow);
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
      // After a prior WebContentsView swap (e.g. addAndSwitchToProject), the
      // toolbar can still be settling on Windows runners — Playwright's
      // implicit stability check on `click()` then times out at 30s even
      // though the trigger is in the DOM. Wait for visibility explicitly,
      // then `force` past the stability check (mirroring how the in-palette
      // add button is clicked above).
      //
      // Additionally on macOS local dev, the very first click after a
      // WebContentsView swap can land before the new project view's React
      // tree has fully wired its handlers — the trigger is in the DOM and
      // visible but the popover state callback is a no-op until the next
      // microtask. Retry the click + visibility check up to 3 times so a
      // single dropped click doesn't fail the spec.
      const palette = await openProjectSwitcherPalette(window);

      // Substring match — createFixtureRepo produces directories like
      // daintree-e2e-${name}-XXXXXX and projectClient.add() derives the
      // displayed name from path.basename, so callers pass the stem. The
      // options can re-render while the active view swaps, so use the option
      // row and retry a forced click if the first target detaches mid-action.
      let selected = false;
      for (let attempt = 0; attempt < 3 && !selected; attempt++) {
        const option = palette.getByRole("option").filter({ hasText: projectName }).first();
        await expect(option).toBeVisible({ timeout: T_MEDIUM });
        try {
          await option.click({ force: true, noWaitAfter: true, timeout: T_SHORT });
          selected = true;
        } catch {
          if (!(await palette.isVisible().catch(() => false))) {
            selected = true;
            break;
          }
          await window.waitForTimeout(250);
        }
      }
      if (!selected) {
        const option = palette.getByRole("option").filter({ hasText: projectName }).first();
        await option.click({ force: true, noWaitAfter: true, timeout: T_MEDIUM });
      }
      // After WebContentsView migration the palette is rendered in the
      // outgoing project's view, which is hidden (not destroyed) once the
      // switch lands — so the close-after-click assertion can race with the
      // view swap. Best-effort wait, but don't fail if the prior view never
      // gets a chance to close the palette in its own React tree.
      await expect(palette)
        .not.toBeVisible({ timeout: 1_000 })
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
  let current = window;
  for (let attempt = 0; attempt < 3; attempt++) {
    await selectExistingProject(current, projectName);
    const refreshed = await refreshActiveWindow(app, current);
    try {
      const target = await waitForActiveProject(app, refreshed, projectName, 2_000);
      await dismissProjectSwitcherPalette(target);
      return target;
    } catch {
      current = refreshed;
      await current.waitForTimeout(250);
    }
  }
  const target = await waitForActiveProject(app, current, projectName, T_LONG);
  await dismissProjectSwitcherPalette(target);
  return target;
}

export async function spawnTerminalAndVerify(
  window: Page,
  expectedText?: string,
  options: { waitForInitialOutput?: boolean } = {}
): Promise<Locator> {
  return await test.step(
    "Spawn terminal and verify",
    async () => {
      const idsBefore = await getGridPanelIds(window);
      const idsBeforeSet = new Set(idsBefore);
      let selectedPanelId: string | null = null;

      const waitForNewGridPanel = async (timeout: number): Promise<boolean> => {
        await expect
          .poll(
            async () => {
              const ids = await getGridPanelIds(window);
              const newIds = ids.filter((id) => !idsBeforeSet.has(id));
              if (newIds.length > 0) {
                selectedPanelId = newIds[newIds.length - 1] ?? null;
                return true;
              }

              if (ids.length > idsBefore.length) {
                selectedPanelId = ids[ids.length - 1] ?? null;
                return selectedPanelId !== null;
              }

              return false;
            },
            { timeout }
          )
          .toBe(true);
        return true;
      };

      for (let attempt = 0; attempt < 4 && selectedPanelId === null; attempt += 1) {
        await openTerminal(window);
        try {
          await waitForNewGridPanel(T_LONG + T_SHORT);
        } catch (error: unknown) {
          if (attempt === 3) throw error;

          await dismissProjectSwitcherPalette(window);
          await window.keyboard.press("Escape").catch(() => undefined);
          await window.keyboard.press(terminalShortcut);
          await waitForNewGridPanel(T_MEDIUM).catch(() => undefined);
        }
      }

      const panel = selectedPanelId
        ? getPanelById(window, selectedPanelId)
        : window.locator(SEL.panel.gridPanel).last();
      await expect(panel).toBeVisible({ timeout: T_MEDIUM });
      if (options.waitForInitialOutput ?? true) {
        await waitForTerminalReady(window, panel, 60_000);
      } else {
        await waitForTerminalPty(window, panel, T_LONG);
      }

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
      await expect(window.locator(SEL.worktree.row(branchName))).toHaveAttribute(
        "aria-current",
        "true",
        {
          timeout: T_MEDIUM,
        }
      );
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
