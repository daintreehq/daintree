/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject, completeOnboarding } from "../helpers/project";
import { selectExistingProject, spawnTerminalAndVerify } from "../helpers/workflows";
import { waitForTerminalText } from "../helpers/terminal";
import { getGridPanelCount, getGridPanelIds, getPanelById } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import type { Locator, Page } from "@playwright/test";

const PROJECT_A = "Cross Project A";
const PROJECT_B = "Cross Project B";
const PROJECT_C = "Cross Project C";

let ctx: AppContext;
let panelIdsA: string[] = [];

async function focusAndRunCommand(page: Page, panel: Locator, command: string): Promise<void> {
  const xterm = panel.locator(SEL.terminal.xtermRows);
  await xterm.click();
  // Wait for focus to settle before typing — prevents keystroke loss
  await page.waitForTimeout(200);
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function switchViaEvaluate(page: typeof ctx.window, projectName: string): Promise<void> {
  const current = await page.evaluate(async () => {
    return await (window as any).electron.project.getCurrent();
  });
  if (current.name === projectName) return;

  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = page.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await page.waitForTimeout(T_SETTLE);

  await page.evaluate((name) => {
    const el = document.querySelector('[data-testid="project-switcher-palette"]');
    if (!el) throw new Error("Palette not in DOM");
    const options = el.querySelectorAll('[role="option"]');
    for (const opt of options) {
      if (opt.textContent?.includes(name)) {
        (opt as HTMLElement).click();
        return;
      }
    }
    throw new Error(`Project "${name}" not found in palette`);
  }, projectName);

  await expect(palette).not.toBeVisible({ timeout: T_LONG });
  await page.waitForTimeout(T_SETTLE);
}

test.describe.serial("Core: Cross-Project Terminal Workflows", () => {
  test.beforeAll(async () => {
    const [repoA, repoB, repoC] = createFixtureRepos(3);

    ctx = await launchApp();

    await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);

    // Add Project B
    await mockOpenDialog(ctx.app, repoB);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });
    await completeOnboarding(ctx.window, PROJECT_B);
    await ctx.window.waitForTimeout(2000);

    // Switch back to A, then add Project C
    await selectExistingProject(ctx.window, PROJECT_A);

    await mockOpenDialog(ctx.app, repoC);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette2 = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette2).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });
    await completeOnboarding(ctx.window, PROJECT_C);
    await ctx.window.waitForTimeout(2000);

    // Return to A as baseline
    await selectExistingProject(ctx.window, PROJECT_A);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("terminal content preservation across project switch", async () => {
    test.slow();
    const { window } = ctx;
    const page = window;

    await test.step(
      "spawn 2 terminals with unique markers",
      async () => {
        await spawnTerminalAndVerify(window);
        await spawnTerminalAndVerify(window);

        panelIdsA = await getGridPanelIds(window);
        expect(panelIdsA).toHaveLength(2);

        const panel1 = getPanelById(page, panelIdsA[0]);
        const panel2 = getPanelById(page, panelIdsA[1]);

        await focusAndRunCommand(page, panel1, "echo MARKER_ALPHA_ONE");
        await waitForTerminalText(panel1, "MARKER_ALPHA_ONE");

        await focusAndRunCommand(page, panel2, "echo MARKER_ALPHA_TWO");
        await waitForTerminalText(panel2, "MARKER_ALPHA_TWO");
      },
      { box: true }
    );

    await test.step(
      "switch to project B and back to A",
      async () => {
        await selectExistingProject(window, PROJECT_B);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);

        await selectExistingProject(window, PROJECT_A);
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(2);
      },
      { box: true }
    );

    await test.step(
      "verify markers survived round-trip",
      async () => {
        const panel1 = getPanelById(page, panelIdsA[0]);
        const panel2 = getPanelById(page, panelIdsA[1]);

        await waitForTerminalText(panel1, "MARKER_ALPHA_ONE");
        await waitForTerminalText(panel2, "MARKER_ALPHA_TWO");
      },
      { box: true }
    );
  });

  test("terminal input works after project switch", async () => {
    test.slow();
    const { window } = ctx;
    const page = window;

    await test.step(
      "switch away and back",
      async () => {
        await selectExistingProject(window, PROJECT_B);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);

        await selectExistingProject(window, PROJECT_A);
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(2);
      },
      { box: true }
    );

    await test.step(
      "type new command and verify output",
      async () => {
        const panel = getPanelById(page, panelIdsA[0]);
        await focusAndRunCommand(page, panel, "echo INPUT_OK_$((40+2))");
        await waitForTerminalText(panel, "INPUT_OK_42");
      },
      { box: true }
    );
  });

  test("multiple terminal count persists across switches", async () => {
    test.slow();
    const { window } = ctx;

    await test.step(
      "spawn 3rd terminal in A",
      async () => {
        await spawnTerminalAndVerify(window);
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(3);
      },
      { box: true }
    );

    await test.step(
      "switch to B and spawn 2 terminals",
      async () => {
        await selectExistingProject(window, PROJECT_B);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);

        await spawnTerminalAndVerify(window);
        await spawnTerminalAndVerify(window);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(2);
      },
      { box: true }
    );

    await test.step(
      "verify A still has 3+, B still has 2+",
      async () => {
        await selectExistingProject(window, PROJECT_A);
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(3);

        await selectExistingProject(window, PROJECT_B);
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(2);
      },
      { box: true }
    );
  });

  test("MRU ordering in project switcher", async () => {
    test.slow();
    const { window } = ctx;
    const page = window;

    await test.step(
      "switch A -> B -> C to establish MRU order",
      async () => {
        await selectExistingProject(window, PROJECT_A);
        await page.waitForTimeout(T_SETTLE);
        await selectExistingProject(window, PROJECT_B);
        await page.waitForTimeout(T_SETTLE);
        await selectExistingProject(window, PROJECT_C);
        await page.waitForTimeout(T_SETTLE);
      },
      { box: true }
    );

    await test.step(
      "verify palette shows C, B, A order",
      async () => {
        await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
        const palette = page.locator(SEL.projectSwitcher.palette);
        await expect(palette).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_SETTLE);

        const optionTexts = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="project-switcher-palette"]');
          if (!el) return [];
          const options = el.querySelectorAll('[role="option"]');
          return Array.from(options).map((o) => o.textContent ?? "");
        });

        // Find positions of each project in the option list
        const posC = optionTexts.findIndex((t) => t.includes("Cross Project C"));
        const posB = optionTexts.findIndex((t) => t.includes("Cross Project B"));
        const posA = optionTexts.findIndex((t) => t.includes("Cross Project A"));

        expect(posC).toBeGreaterThanOrEqual(0);
        expect(posB).toBeGreaterThanOrEqual(0);
        expect(posA).toBeGreaterThanOrEqual(0);
        expect(posC).toBeLessThan(posB);
        expect(posB).toBeLessThan(posA);

        await page.keyboard.press("Escape");
        await expect(palette).not.toBeVisible({ timeout: T_MEDIUM });
      },
      { box: true }
    );
  });

  test("rapid switching resilience", async () => {
    test.slow();
    const { window } = ctx;
    const page = window;

    await test.step(
      "start on project A",
      async () => {
        await switchViaEvaluate(page, PROJECT_A);
        // Panels may take extra time to re-hydrate after prior test switches
        await page.waitForTimeout(T_SETTLE * 2);
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG * 2 })
          .toBeGreaterThanOrEqual(3);
      },
      { box: true }
    );

    await test.step(
      "rapid A -> B -> A -> B -> A switches",
      async () => {
        await switchViaEvaluate(page, PROJECT_B);
        await switchViaEvaluate(page, PROJECT_A);
        await switchViaEvaluate(page, PROJECT_B);
        await switchViaEvaluate(page, PROJECT_A);
        await page.waitForTimeout(T_SETTLE * 4);
      },
      { box: true }
    );

    await test.step(
      "verify final state is A with at least 1 panel",
      async () => {
        const current = await page.evaluate(async () => {
          return await (window as any).electron.project.getCurrent();
        });
        expect(current.name).toBe(PROJECT_A);

        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(1);

        // Verify original terminal markers survived rapid switching
        const panel1 = getPanelById(page, panelIdsA[0]);
        await waitForTerminalText(panel1, "MARKER_ALPHA_ONE");
      },
      { box: true }
    );
  });
});
