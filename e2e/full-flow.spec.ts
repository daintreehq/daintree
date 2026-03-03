import { test, expect } from "@playwright/test";
import { launchApp, mockOpenDialog, type AppContext } from "./launch";
import { createFixtureRepo } from "./fixtures";

let ctx: AppContext;
let fixtureDir: string;

test.beforeAll(async () => {
  fixtureDir = createFixtureRepo("canopy-website");
  ctx = await launchApp();
});

test.afterAll(async () => {
  await ctx?.app.close();
});

// Helper: read visible text from the xterm DOM renderer within the agent panel
async function getTerminalText(ctx: AppContext): Promise<string> {
  const agentPanel = ctx.window.locator('[aria-label^="Claude agent:"]');
  return agentPanel.locator(".xterm-rows").innerText();
}

// Helper: wait for terminal output to contain a string (polls every 500ms)
async function waitForTerminalText(
  ctx: AppContext,
  text: string,
  timeoutMs = 60_000
): Promise<void> {
  await expect
    .poll(() => getTerminalText(ctx), { timeout: timeoutMs, intervals: [500] })
    .toContain(text);
}

test("open folder and complete onboarding", async () => {
  const { app, window } = ctx;

  await mockOpenDialog(app, fixtureDir);
  await window.getByRole("button", { name: "Open Folder" }).click();

  // Onboarding wizard appears
  const heading = window.locator("h2", { hasText: "Set up your project" });
  await expect(heading).toBeVisible({ timeout: 10_000 });

  // Set project name
  const nameInput = window.getByRole("textbox", { name: "Project Name" });
  await nameInput.fill("Canopy Website");

  // Pick emoji
  await window.getByRole("button", { name: "Change project emoji" }).click();
  const emojiSearch = window.getByRole("searchbox", { name: /search emojis/i });
  await expect(emojiSearch).toBeVisible({ timeout: 3_000 });
  await emojiSearch.fill("tree");
  await window.getByRole("gridcell", { name: "Palm tree" }).click();

  // Finish
  await window.getByRole("button", { name: "Finish" }).click();
  await expect(heading).not.toBeVisible({ timeout: 5_000 });

  await window.screenshot({ path: "test-results/01-project-setup.png" });
});

test("launch Claude agent", async () => {
  const { window } = ctx;

  await window.locator('[aria-label="Start Claude Agent"]').click();

  // Wait for the agent terminal panel to appear (~5s)
  const agentPanel = window.locator('[aria-label^="Claude agent:"]');
  await expect(agentPanel).toBeVisible({ timeout: 5_000 });

  await window.screenshot({ path: "test-results/02-agent-launched.png" });
});

test("trust the workspace folder", async () => {
  const { window } = ctx;

  // Wait for Claude CLI to show the trust prompt
  await waitForTerminalText(ctx, "trust", 15_000);

  await window.screenshot({ path: "test-results/03-trust-prompt.png" });

  // Press Enter on the HybridInputBar to confirm trust (empty input = raw keystroke)
  const agentPanel = window.locator('[aria-label^="Claude agent:"]');
  const cmEditor = agentPanel.locator(".cm-content");
  await cmEditor.click();
  await window.keyboard.press("Enter");

  // Wait for Claude's TUI to fully load (welcome screen appears)
  await waitForTerminalText(ctx, "Welcome", 60_000);

  await window.screenshot({ path: "test-results/04-trust-accepted.png" });
});

test("send hello world command and verify output", async () => {
  const { window } = ctx;

  const agentPanel = window.locator('[aria-label^="Claude agent:"]');

  // Type into the HybridInputBar (CodeMirror contenteditable)
  const cmEditor = agentPanel.locator(".cm-content");
  await cmEditor.click();
  await cmEditor.pressSequentially("Please say hello world", { delay: 30 });
  await window.keyboard.press("Enter");

  await window.screenshot({ path: "test-results/05-command-sent.png" });

  // Wait for Claude to process and respond
  await window.waitForTimeout(15_000);

  await window.screenshot({ path: "test-results/06-hello-world-response.png" });

  // Verify Claude responded with "hello world" (not just the command we typed).
  // The command "Please say hello world" contains it once — Claude's response adds another.
  const text = await getTerminalText(ctx);
  const matches = text.toLowerCase().split("hello world").length - 1;
  expect(matches).toBeGreaterThanOrEqual(2);
});
