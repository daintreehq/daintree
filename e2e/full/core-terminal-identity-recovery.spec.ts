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
import { getFirstGridPanel, openTerminal, getGridPanelCount } from "../helpers/panels";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";

// #5812: identity must survive WebContentsView eviction + rebuild. Project
// switching is the canonical eviction trigger — switching to another project
// invalidates the current view's renderer reference, and switching back
// rehydrates from backend state. capabilityAgentId is sealed at spawn and
// must replay through the rebuild; if hydration drops it, a cold-launched
// agent silently demotes to observational.
//
// Plain shells must also remain identity-clean across this round-trip — no
// data-capability-agent-id should appear on a terminal that wasn't cold-
// launched as one.
let ctx: AppContext;
const PROJECT_A = "Identity Project A";
const PROJECT_B = "Identity Project B";

async function getCurrentProjectName(page: typeof ctx.window): Promise<string> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      electron: { project: { getCurrent(): Promise<{ name: string }> } };
    };
    const project = await w.electron.project.getCurrent();
    return project.name;
  });
}

async function switchToProject(
  page: typeof ctx.window,
  projectName: string
): Promise<typeof ctx.window> {
  const current = await getCurrentProjectName(page);
  if (current === projectName) return page;

  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = page.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await page.waitForTimeout(T_SETTLE);

  // The palette options can re-render mid-click — evaluate-clicking by text
  // is the documented pattern in core-project-switch-race.spec.ts.
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

  await expect(palette)
    .not.toBeVisible({ timeout: T_LONG })
    .catch(() => undefined);

  // Refresh window after switch — past lessons #5010/#4981: stale ctx.window
  // throws "Target page has been closed" because the WebContentsView gets
  // swapped out by the main process.
  const refreshed = await refreshActiveWindow(ctx.app, page);
  await refreshed.waitForTimeout(T_SETTLE);
  ctx.window = refreshed;
  return refreshed;
}

test.describe.serial("Full: Terminal Identity Recovery", () => {
  test.beforeAll(async () => {
    const [repoA, repoB] = createFixtureRepos(2);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);

    // Add Project B without leaving Project A view chain — needed so the
    // eviction test has a real second project to swap between.
    await mockOpenDialog(ctx.app, repoB);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });
    await completeOnboarding(ctx.window, PROJECT_B);
    ctx.window = await refreshActiveWindow(ctx.app, ctx.window);

    await switchToProject(ctx.window, PROJECT_A);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("plain shell stays identity-clean across non-agent process churn", async () => {
    const { window } = ctx;
    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    const panelId = await panel.getAttribute("data-panel-id");
    expect(panelId).toBeTruthy();

    const readCapability = () =>
      window.evaluate(
        (id) =>
          document
            .querySelector(`[data-panel-id="${id}"]`)
            ?.getAttribute("data-capability-agent-id"),
        panelId
      );

    // Baseline: no capability before any process runs.
    expect(await readCapability()).toBeNull();

    // Run a bounded `node` script — this exercises the same detection chain
    // that fires `agent:detected` for processIconId. Detection of node must
    // never promote a plain shell to a "full" agent terminal.
    await runTerminalCommand(
      window,
      panel,
      `node -e "console.log('IDENTITY_SENTINEL'); setTimeout(()=>{}, 4000)"`
    );
    await waitForTerminalText(panel, "IDENTITY_SENTINEL", T_LONG);

    // capabilityAgentId is launch-intent-only — no detection event can ever
    // stamp it. Sample a few times across the process lifetime to catch any
    // mid-flight mutation.
    for (let i = 0; i < 4; i++) {
      expect(await readCapability()).toBeNull();
      await window.waitForTimeout(800);
    }
  });

  test("cold-launched agent capability identity survives view eviction + rebuild", async () => {
    const { window } = ctx;

    // Need the real Claude CLI for cold-launch — without it the toolbar
    // surfaces a non-launching button and there is no panel to evict.
    const startBtn = window.locator(SEL.agent.startButton);
    if (!(await startBtn.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      test.skip();
      return;
    }

    const initialCount = await getGridPanelCount(window);
    await startBtn.click();
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(initialCount + 1);

    const agentPanel = window.locator(SEL.agent.capabilityPanel("claude")).first();
    await expect(agentPanel).toBeVisible({ timeout: T_LONG });
    const agentPanelId = await agentPanel.getAttribute("data-panel-id");
    expect(agentPanelId).toBeTruthy();

    // Switch away — this evicts (or at least swaps) the current project's
    // WebContentsView. The page reference becomes stale; switchToProject
    // refreshes ctx.window via refreshActiveWindow.
    await switchToProject(window, PROJECT_B);
    await switchToProject(ctx.window, PROJECT_A);

    // After switch-back, hydration must replay capabilityAgentId on the
    // same panel id. Use the freshly-refreshed window — referencing the
    // pre-switch `window` would query the old (closed) view.
    const restoredPanel = ctx.window.locator(`[data-panel-id="${agentPanelId}"]`);
    await expect(restoredPanel).toBeVisible({ timeout: T_LONG });

    await expect
      .poll(
        async () =>
          ctx.window.evaluate(
            (id) =>
              document
                .querySelector(`[data-panel-id="${id}"]`)
                ?.getAttribute("data-capability-agent-id"),
            agentPanelId
          ),
        { timeout: T_LONG, intervals: [500] }
      )
      .toBe("claude");

    // And it must come back as full-mode, not observational (the latter
    // would render the chip and signal a hydration regression).
    await expect(
      ctx.window.locator(`[data-panel-id="${agentPanelId}"] ${SEL.agent.observationalChip}`)
    ).toHaveCount(0);
  });
});
