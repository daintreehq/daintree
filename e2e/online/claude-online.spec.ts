import { test, expect } from "@playwright/test";
import { launchApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { waitForTerminalText, getTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;
let fixtureDir: string;

test.describe("Claude Online Flow", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "claude-online" });
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("full Claude agent interaction", async () => {
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
      await nameInput.fill("Claude Online Test");

      await window.getByRole("button", { name: "Finish" }).click();
      await expect(heading).not.toBeVisible({ timeout: 5_000 });
    });

    await test.step("launch Claude agent", async () => {
      const { window } = ctx;

      await window.locator(SEL.agent.startButton).click();

      const agentPanel = window.locator(SEL.agent.panel);
      await expect(agentPanel).toBeVisible({ timeout: 5_000 });
    });

    await test.step("trust workspace", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.agent.panel);
      await waitForTerminalText(agentPanel, "trust", 15_000);

      const cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
      await cmEditor.click();
      await window.keyboard.press("Enter");
    });

    await test.step("accept API key", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.agent.panel);
      await waitForTerminalText(agentPanel, "API key", 15_000);

      const cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
      await cmEditor.click();
      await window.keyboard.press("ArrowUp");
      await window.keyboard.press("Enter");
    });

    await test.step("wait for Welcome screen", async () => {
      const agentPanel = ctx.window.locator(SEL.agent.panel);
      await waitForTerminalText(agentPanel, "Welcome", 60_000);
    });

    await test.step("send hello world command", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.agent.panel);
      const cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
      await cmEditor.click();
      await cmEditor.pressSequentially("Please say hello world", { delay: 30 });
      await window.keyboard.press("Enter");
    });

    await test.step("verify response contains hello", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.agent.panel);

      await expect
        .poll(
          async () => {
            const text = await getTerminalText(agentPanel);
            return text.toLowerCase().split("hello").length - 1;
          },
          { timeout: 60_000, intervals: [1_000] }
        )
        .toBeGreaterThanOrEqual(2);
    });
  });
});
