import { test, expect } from "@playwright/test";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { dismissTelemetryConsent } from "../helpers/project";
import { getTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;
let fixtureDir: string;

test.describe("OpenCode Online Flow", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "opencode-online" });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("full OpenCode agent interaction", async () => {
    await test.step("launch app", async () => {
      ctx = await launchApp();
    });

    await test.step("open folder and complete onboarding", async () => {
      const { app, window } = ctx;

      await mockOpenDialog(app, fixtureDir);
      await window.getByRole("button", { name: "Open Folder" }).click();

      const heading = window.locator("h2", { hasText: "Set up your project" });
      await expect(heading).toBeVisible({ timeout: 10_000 });

      const nameInput = window.getByRole("textbox", { name: "Project Name" });
      await nameInput.fill("OpenCode Online Test");

      await window.getByRole("button", { name: "Finish" }).click();
      await expect(heading).not.toBeVisible({ timeout: 5_000 });

      await dismissTelemetryConsent(window);
    });

    await test.step("launch OpenCode agent", async () => {
      const { window } = ctx;

      await window.locator(SEL.opencodeAgent.startButton).click();

      const agentPanel = window.locator(SEL.opencodeAgent.panel);
      await expect(agentPanel).toBeVisible({ timeout: 5_000 });
    });

    await test.step("handle prompts and wait for ready state", async () => {
      const { window } = ctx;
      const agentPanel = window.locator(SEL.opencodeAgent.panel);
      const cmEditor = agentPanel.locator(SEL.terminal.cmEditor);

      const deadline = Date.now() + 90_000;
      let reachedReady = false;

      while (Date.now() < deadline && !reachedReady) {
        await dismissTelemetryConsent(window);

        const text = await getTerminalText(agentPanel);
        const lower = text.toLowerCase();

        // Also check the CodeMirror input placeholder for ready state
        const cmText = await cmEditor.innerText().catch(() => "");
        const cmLower = cmText.toLowerCase();

        if (
          lower.includes("ask anything") ||
          /build\s+opencode/i.test(text) ||
          cmLower.includes("type a command") ||
          lower.includes("database migration complete")
        ) {
          reachedReady = true;
        } else if (lower.includes("provider") || lower.includes("/connect")) {
          await cmEditor.click();
          await window.keyboard.press("Enter");
          await window.waitForTimeout(2_000);
        } else if (lower.includes("api key")) {
          await cmEditor.click();
          await window.keyboard.press("ArrowUp");
          await window.keyboard.press("Enter");
          await window.waitForTimeout(2_000);
        } else {
          await window.waitForTimeout(1_000);
        }
      }

      expect(reachedReady).toBe(true);
    });

    await test.step("send hello world command", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.opencodeAgent.panel);
      const cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
      await cmEditor.click();
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
