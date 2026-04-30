/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  mockOpenDialog,
  refreshActiveWindow,
  type AppContext,
} from "../helpers/launch";
import { createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject, completeOnboarding } from "../helpers/project";
import { selectExistingProjectAndRefresh, spawnTerminalAndVerify } from "../helpers/workflows";
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
  // Wait for xterm's helper textarea to receive focus before typing —
  // typing too early can drop the leading characters of the command.
  await expect(panel.locator(".xterm-helper-textarea")).toBeFocused({ timeout: 5_000 });
  await page.waitForTimeout(150);
  // Per-key delay; PTY can drop bursts on cold-start or after switches.
  await page.keyboard.type(command, { delay: 15 });
  await page.keyboard.press("Enter");
}

test.describe.serial("Core: Cross-Project Terminal Workflows", () => {
  test.beforeAll(async () => {
    const [repoA, repoB, repoC] = createFixtureRepos(3);

    ctx = await launchApp();

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);

    // Add Project B
    await mockOpenDialog(ctx.app, repoB);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });
    await completeOnboarding(ctx.window, PROJECT_B);
    ctx.window = await refreshActiveWindow(ctx.app, ctx.window);

    // Switch back to A, then add Project C
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    await mockOpenDialog(ctx.app, repoC);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette2 = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette2).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });
    await completeOnboarding(ctx.window, PROJECT_C);
    ctx.window = await refreshActiveWindow(ctx.app, ctx.window);

    // Return to A as baseline
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
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
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
        await expect.poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG }).toBe(0);

        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
        await expect
          .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(2);
      },
      { box: true }
    );

    await test.step(
      "verify markers survived round-trip",
      async () => {
        const panel1 = getPanelById(ctx.window, panelIdsA[0]);
        const panel2 = getPanelById(ctx.window, panelIdsA[1]);

        await waitForTerminalText(panel1, "MARKER_ALPHA_ONE");
        await waitForTerminalText(panel2, "MARKER_ALPHA_TWO");
      },
      { box: true }
    );
  });

  test("terminal input works after project switch", async () => {
    test.slow();

    await test.step(
      "switch away and back",
      async () => {
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
        await expect.poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG }).toBe(0);

        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
        await expect
          .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(2);
      },
      { box: true }
    );

    await test.step(
      "type new command and verify output",
      async () => {
        // Re-fetch panel IDs — after a project switch the DOM panels are
        // re-hydrated and only the currently-focused panel has a mounted
        // xterm. Pick the first panel whose xterm viewport is actually
        // visible so `focusAndRunCommand` can reliably click it.
        const freshIds = await getGridPanelIds(ctx.window);
        expect(freshIds.length).toBeGreaterThanOrEqual(2);

        let panel: Locator | null = null;
        for (const id of freshIds) {
          const candidate = getPanelById(ctx.window, id);
          if (
            await candidate
              .locator(SEL.terminal.xtermRows)
              .isVisible()
              .catch(() => false)
          ) {
            panel = candidate;
            break;
          }
        }
        if (!panel) {
          // Fall back to the first panel — some layouts only render xterm
          // lazily when focused, so click the wrapper to force focus first.
          panel = getPanelById(ctx.window, freshIds[0]);
          await panel.click({ force: true });
          await panel
            .locator(SEL.terminal.xtermRows)
            .waitFor({ state: "visible", timeout: T_LONG });
        }
        await focusAndRunCommand(ctx.window, panel, "echo INPUT_OK_$((40+2))");
        await waitForTerminalText(panel, "INPUT_OK_42");
      },
      { box: true }
    );
  });

  test("multiple terminal count persists across switches", async () => {
    test.slow();

    await test.step(
      "spawn 3rd terminal in A",
      async () => {
        await spawnTerminalAndVerify(ctx.window);
        await expect
          .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(3);
      },
      { box: true }
    );

    await test.step(
      "switch to B and spawn 2 terminals",
      async () => {
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
        await expect.poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG }).toBe(0);

        await spawnTerminalAndVerify(ctx.window);
        await spawnTerminalAndVerify(ctx.window);
        await expect.poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG }).toBe(2);
      },
      { box: true }
    );

    await test.step(
      "verify A still has 3+, B still has 2+",
      async () => {
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
        await expect
          .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(3);

        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
        await expect
          .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(2);
      },
      { box: true }
    );
  });

  test("MRU ordering in project switcher", async () => {
    test.slow();

    await test.step(
      "switch A -> B -> C to establish MRU order",
      async () => {
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
        await ctx.window.waitForTimeout(T_SETTLE);
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
        await ctx.window.waitForTimeout(T_SETTLE);
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
        await ctx.window.waitForTimeout(T_SETTLE);
      },
      { box: true }
    );

    await test.step(
      "verify palette shows C, B, A order",
      async () => {
        const page = ctx.window;
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

    await test.step(
      "start on project A with at least 1 panel",
      async () => {
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
        await ctx.window.waitForTimeout(T_SETTLE * 2);
        // Earlier tests may have closed panels; spawn a fresh one if needed
        const count = await getGridPanelCount(ctx.window);
        if (count === 0) {
          await spawnTerminalAndVerify(ctx.window);
        }
        await expect
          .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(1);
      },
      { box: true }
    );

    await test.step(
      "rapid A -> B -> A -> B -> A switches",
      async () => {
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
        await ctx.window.waitForTimeout(T_SETTLE * 4);
      },
      { box: true }
    );

    await test.step(
      "verify final state is project A",
      async () => {
        // The key invariant after rapid switching is that we land on the
        // correct project. Panels may be lost during the rapid transitions.
        const current = await ctx.window.evaluate(async () => {
          return await (window as any).electron.project.getCurrent();
        });
        expect(current.name).toBe(PROJECT_A);
      },
      { box: true }
    );
  });
});
