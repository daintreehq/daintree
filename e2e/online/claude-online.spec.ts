import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { dismissTelemetryConsent, openAndOnboardProject } from "../helpers/project";
import { getTerminalText, writeTerminalInput } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { configureClaudeAuthEnv, hasClaudeApiKey } from "../helpers/claudeAuth";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let claudeAgentPanel: Locator;

async function tryFocusHybridEditor(page: Page, agentPanel: Locator): Promise<boolean> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 8; attempt++) {
    const cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
    try {
      await expect(cmEditor).toBeVisible({ timeout: 5_000 });
      await cmEditor.evaluate((node) => {
        const element = node as HTMLElement;
        element.scrollIntoView({ block: "center", inline: "center" });
        element.focus();
      });
      await cmEditor.click({ force: true });
      await expect
        .poll(
          () =>
            cmEditor
              .evaluate((node) => {
                const active = document.activeElement;
                return active === node || (active instanceof Node && node.contains(active));
              })
              .catch(() => false),
          {
            timeout: process.platform === "win32" ? 5_000 : 2_000,
            intervals: [100, 250],
          }
        )
        .toBe(true);
      return true;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }

  if (lastError instanceof Error && !/cm-content/.test(lastError.message)) {
    throw lastError;
  }
  return false;
}

async function sendAgentInput(
  page: Page,
  agentPanel: Locator,
  input: string,
  options: { submit?: boolean } = {}
): Promise<void> {
  if (process.platform === "win32") {
    await writeTerminalInput(page, agentPanel, options.submit ? `${input}\r` : input);
    return;
  }

  if (await tryFocusHybridEditor(page, agentPanel)) {
    await page.keyboard.type(input, { delay: 30 });
    if (options.submit) await page.keyboard.press("Enter");
    return;
  }

  await writeTerminalInput(page, agentPanel, options.submit ? `${input}\r` : input);
}

async function pressAgentKey(
  page: Page,
  agentPanel: Locator,
  key: "Enter" | "ArrowUp"
): Promise<void> {
  if (process.platform === "win32") {
    await writeTerminalInput(page, agentPanel, key === "Enter" ? "\r" : "\x1b[A");
    return;
  }

  if (await tryFocusHybridEditor(page, agentPanel)) {
    await page.keyboard.press(key);
    return;
  }

  await writeTerminalInput(page, agentPanel, key === "Enter" ? "\r" : "\x1b[A");
}

test.describe("Claude Online Flow", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "claude-online" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("full Claude agent interaction", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "ANTHROPIC_API_KEY is required for Claude online flow",
    });

    test.skip(!hasClaudeApiKey(), "ANTHROPIC_API_KEY is required for Claude online flow");

    await test.step("launch app", async () => {
      ctx = await launchApp();
    });

    await test.step("open folder", async () => {
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir);
    });

    await configureClaudeAuthEnv(ctx.window);

    await test.step("launch Claude agent", async () => {
      const { window } = ctx;

      // Agents are unpinned by default, so the toolbar shows the launcher
      // rather than a direct "Start Claude Agent" button. Open it and click the
      // Claude row under "Launch".
      await window.locator(SEL.agent.trayButton).click();
      await window.locator(SEL.agent.launcherRow("Claude")).first().click();

      const agentPanel = window.locator(SEL.agent.panel).first();
      await expect(agentPanel).toBeVisible({ timeout: 30_000 });
      const panelId = await agentPanel.evaluate(
        (element) => element.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? ""
      );
      expect(panelId).toBeTruthy();
      claudeAgentPanel = window.locator(`[data-panel-id="${panelId}"]`);
    });

    await test.step("handle prompts and wait for Welcome", async () => {
      const { window } = ctx;
      const agentPanel = claudeAgentPanel;

      // Claude Code may prompt for trust, API key, or skip straight to Welcome
      // depending on prior configuration. Poll and handle whatever appears.
      // Windows GitHub runners are dramatically slower at first-run Claude Code
      // startup (Node spawn + auth check + render) — give them 3x the budget.
      const deadline = Date.now() + (process.platform === "win32" ? 270_000 : 90_000);
      let reachedWelcome = false;

      while (Date.now() < deadline && !reachedWelcome) {
        // Dismiss telemetry consent if it appeared after agent launch
        await dismissTelemetryConsent(window);

        const text = await getTerminalText(agentPanel);
        const lower = text.toLowerCase();

        if (lower.includes("welcome")) {
          reachedWelcome = true;
        } else if (lower.includes("trust")) {
          await pressAgentKey(window, agentPanel, "Enter");
          await window.waitForTimeout(2_000);
        } else if (lower.includes("api key")) {
          await pressAgentKey(window, agentPanel, "ArrowUp");
          await pressAgentKey(window, agentPanel, "Enter");
          await window.waitForTimeout(2_000);
        } else {
          await window.waitForTimeout(1_000);
        }
      }

      expect(reachedWelcome).toBe(true);
    });

    await test.step("send hello world command", async () => {
      const { window } = ctx;

      const agentPanel = claudeAgentPanel;
      await sendAgentInput(window, agentPanel, "Please say hello world", { submit: true });
    });

    await test.step("verify response contains hello", async () => {
      const { window } = ctx;

      const agentPanel = claudeAgentPanel;

      await expect
        .poll(
          async () => {
            const text = await getTerminalText(agentPanel);
            return text.toLowerCase().split("hello").length - 1;
          },
          { timeout: 60_000, intervals: [1_000] }
        )
        .toBeGreaterThanOrEqual(1);
    });
  });
});
