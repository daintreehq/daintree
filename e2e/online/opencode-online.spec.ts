import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { dismissTelemetryConsent, openAndOnboardProject } from "../helpers/project";
import { getTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

async function focusHybridEditor(page: Page, agentPanel: Locator): Promise<void> {
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
      await expect
        .poll(
          () => cmEditor.evaluate((node) => document.activeElement === node).catch(() => false),
          {
            timeout: 2_000,
            intervals: [100, 250],
          }
        )
        .toBe(true);
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to focus hybrid editor");
}

async function openFixtureProject(): Promise<void> {
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir);
}

async function launchOpenCodeAgent(): Promise<Locator> {
  const { window } = ctx;

  // Agents are unpinned by default, so the toolbar shows the Agent Tray
  // rather than a direct "Start OpenCode Agent" button. Open the tray and
  // click the OpenCode entry under "Launch".
  await window.locator(SEL.agent.trayButton).click();
  await window.getByRole("menuitem", { name: "OpenCode" }).click();

  const agentPanel = window.locator(SEL.opencodeAgent.panel);
  await expect(agentPanel).toBeVisible({ timeout: 30_000 });
  return agentPanel;
}

async function waitForOpenCodeReady(agentPanel: Locator): Promise<"ready" | "needs-restart"> {
  const { window } = ctx;

  // Windows GitHub runners take significantly longer to bring up the
  // OpenCode CLI (Node spawn + provider probe + render) — extend the
  // ready-state polling budget so we don't trip the deadline on cold-start.
  // macOS/Linux release runners need more than the local budget too: they run
  // every E2E bucket at once, and a flat 120s expired mid-cold-start on the
  // v0.29.0 macOS release run. The online gate runs with FAIL_ON_FLAKY_TESTS,
  // so a retry-recovered timeout still fails the release.
  const deadline =
    Date.now() + (process.platform === "win32" ? 360_000 : process.env.CI ? 180_000 : 120_000);

  while (Date.now() < deadline) {
    await dismissTelemetryConsent(window);

    const text = await getTerminalText(agentPanel);
    const lower = text.toLowerCase();

    if (lower.includes("update complete") && lower.includes("restart the application")) {
      return "needs-restart";
    }

    if (
      lower.includes("ask anything") ||
      /build\s+opencode/i.test(text) ||
      /\d+\.\d+\.\d+$/.test(text.trim())
    ) {
      return "ready";
    } else if (lower.includes("provider") || lower.includes("/connect")) {
      await focusHybridEditor(window, agentPanel);
      await window.keyboard.press("Enter");
      await window.waitForTimeout(2_000);
    } else if (lower.includes("api key")) {
      await focusHybridEditor(window, agentPanel);
      await window.keyboard.press("ArrowUp");
      await window.keyboard.press("Enter");
      await window.waitForTimeout(2_000);
    } else {
      await window.waitForTimeout(1_000);
    }
  }

  throw new Error("OpenCode did not reach ready state before timeout");
}

async function launchOpenCodeReady(): Promise<Locator> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const agentPanel = await launchOpenCodeAgent();
    const state = await waitForOpenCodeReady(agentPanel);
    if (state === "ready") return agentPanel;

    // OpenCode can self-update on first launch and require the embedding app
    // to restart before the new CLI process will accept input.
    await closeApp(ctx.app);
    ctx = await launchApp();
    await openFixtureProject();
  }

  throw new Error("OpenCode required restart more than once");
}

test.describe("OpenCode Online Flow", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "opencode-online" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("full OpenCode agent interaction", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "online: requires OpenCode installed and OPENCODE_E2E_ENABLED=1",
    });

    test.skip(
      !process.env.OPENCODE_E2E_ENABLED,
      "online: requires OpenCode installed and OPENCODE_E2E_ENABLED=1"
    );

    await test.step("launch app", async () => {
      ctx = await launchApp();
    });

    await test.step("open folder", async () => {
      await openFixtureProject();
    });

    await test.step("launch OpenCode agent", async () => {
      await launchOpenCodeReady();
    });

    await test.step("send hello world command", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.opencodeAgent.panel);
      await focusHybridEditor(window, agentPanel);
      await window.waitForTimeout(500);
      await window.keyboard.type("Please say hello world", { delay: 30 });
      await window.waitForTimeout(200);
      await window.keyboard.press("Enter");
    });

    await test.step("verify response contains hello", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.opencodeAgent.panel);

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
