import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, openTerminal, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_SHORT, T_SETTLE } from "../helpers/timeouts";

// #5812: cross-process terminal identity is the contract that decides
// whether a panel is treated as a "full" agent (cold-launched: capabilities
// sealed at spawn) vs an "observational" agent (runtime detection in a plain
// shell). The DOM discriminator is `data-capability-agent-id` — present only
// for cold-launched agents, absent for plain shells and observational ones.
//
// These tests assert the launch-intent identity at the point users care about:
// the panel root attribute, plus the absence of the observational chip when
// the panel is full-mode. Detection-driven UI for non-agent processes is
// covered by core-process-badge.spec.ts; runtime observational chip behavior
// requires real Claude and lives in e2e/online/.
let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Terminal Identity", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "terminal-identity" });
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Terminal Identity Test"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("plain shell terminal never carries data-capability-agent-id", async () => {
    const { window } = ctx;
    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    const panelId = await panel.getAttribute("data-panel-id");
    expect(panelId).toBeTruthy();

    // capabilityAgentId is sealed at spawn — a plain shell never gets it.
    // Read directly from the DOM so we catch any later mutation too.
    expect(
      await window.evaluate(
        (id) =>
          document
            .querySelector(`[data-panel-id="${id}"]`)
            ?.getAttribute("data-capability-agent-id"),
        panelId
      )
    ).toBeNull();

    // Observational chip belongs only to plain shells where a real agent
    // process was detected (Claude/Gemini/etc.). A bare shell has neither
    // launch intent nor detection, so the chip must stay hidden.
    await expect(panel.locator(SEL.agent.observationalChip)).toHaveCount(0);
  });

  test("cold-launched Claude agent panel exposes capability identity", async () => {
    const { window } = ctx;

    // Skip when Claude CLI isn't on PATH — the toolbar surfaces a different
    // aria-label ("Claude CLI not installed") and routes clicks to settings.
    const startBtn = window.locator(SEL.agent.startButton);
    if (!(await startBtn.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      test.skip();
      return;
    }

    const initialCount = await getGridPanelCount(window);
    await startBtn.click();

    // Wait for the new agent panel to land in the grid (panel-count poll
    // is the deterministic anchor — a sleep would race the spawn).
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(initialCount + 1);

    const agentPanel = window.locator(SEL.agent.capabilityPanel("claude")).first();
    await expect(agentPanel).toBeVisible({ timeout: T_LONG });

    // Cold launch path stamps capabilityAgentId at spawn — assert on the
    // DOM attribute so we exercise the renderer→panel-store→panel-root
    // pipeline that real users see.
    expect(await agentPanel.getAttribute("data-capability-agent-id")).toBe("claude");

    // Full-mode panels never render the observational chip. The chip is
    // gated on `detectedAgentId && !capabilityAgentId`, so its absence
    // proves the cold launch sealed capability identity correctly.
    await expect(agentPanel.locator(SEL.agent.observationalChip)).toHaveCount(0);
  });

  test("restart preserves capability identity on a full-mode agent panel", async () => {
    const { window } = ctx;

    // Same skip predicate — without Claude there's no full-mode panel to
    // restart. The test above is the gate that proves the panel exists;
    // re-check here so this test is independently runnable.
    const agentPanel = window.locator(SEL.agent.capabilityPanel("claude")).first();
    if (!(await agentPanel.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      test.skip();
      return;
    }

    const panelId = await agentPanel.getAttribute("data-panel-id");
    expect(panelId).toBeTruthy();

    // Restart flows through the panel overflow menu; capability identity
    // must survive PTY teardown + respawn (otherwise hydration regresses to
    // observational mode).
    await agentPanel.hover();
    await agentPanel.locator(SEL.panel.overflowMenu).first().click();
    const restartBtn = window.locator(SEL.panel.restart).first();
    await expect(restartBtn).toBeVisible({ timeout: T_SHORT });
    await restartBtn.click();

    const confirmBtn = window.locator(SEL.panel.restartConfirm).first();
    await expect(confirmBtn).toBeVisible({ timeout: T_SHORT });
    await confirmBtn.click();

    // Give the respawn a beat to settle, then re-assert the attribute on
    // the same panel-id. capabilityAgentId is read from store state at
    // render time — if respawn dropped it, the attribute disappears.
    await window.waitForTimeout(T_SETTLE);
    await expect
      .poll(
        async () =>
          window.evaluate(
            (id) =>
              document
                .querySelector(`[data-panel-id="${id}"]`)
                ?.getAttribute("data-capability-agent-id"),
            panelId
          ),
        { timeout: T_LONG, intervals: [500] }
      )
      .toBe("claude");

    // Restart must not flip the panel into observational mode either.
    await expect(
      window.locator(`[data-panel-id="${panelId}"] ${SEL.agent.observationalChip}`)
    ).toHaveCount(0);
  });
});
