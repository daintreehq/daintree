import { test, expect, type Locator } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { expectInputBarFocused } from "../helpers/focus";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let agentPanel: Locator;
let cmEditor: Locator;

test.describe.serial("Core: HybridInputBar", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "hybrid-input-bar" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "HybridInputBar Test");

    // Agent panel requires CLI availability — skip all tests if not present
    const startBtn = ctx.window.locator(SEL.agent.startButton);
    if (!(await startBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await startBtn.click();

    agentPanel = ctx.window.locator(SEL.agent.panel);
    await expect(agentPanel).toBeVisible({ timeout: T_LONG });

    cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
    await expect(cmEditor).toBeAttached({ timeout: T_LONG });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("can type text into CodeMirror editor", async () => {
    const { window } = ctx;

    await cmEditor.click();
    await expectInputBarFocused(agentPanel);
    await cmEditor.pressSequentially("hello world", { delay: 30 });

    await expect(cmEditor).toHaveText(/hello world/);

    // Clear for next test
    await window.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
    await window.keyboard.press("Backspace");
  });

  test("Enter submits the input and clears the editor", async () => {
    const { window } = ctx;

    await cmEditor.click();
    await cmEditor.pressSequentially("e2e-submit-test", { delay: 30 });
    await expect(cmEditor).toHaveText(/e2e-submit-test/);

    await window.keyboard.press("Enter");

    // Editor should be cleared after submit — the submitted text should no longer appear
    await expect(cmEditor).not.toHaveText(/e2e-submit-test/, { timeout: T_MEDIUM });
  });

  test("Shift+Enter inserts newline without submitting", async () => {
    const { window } = ctx;

    await cmEditor.click();
    await cmEditor.pressSequentially("line1", { delay: 30 });
    await window.keyboard.press("Shift+Enter");
    await cmEditor.pressSequentially("line2", { delay: 30 });

    // Editor should contain both lines with a newline between them
    // CM6 renders each line in a separate .cm-line element
    const lines = cmEditor.locator(".cm-line");
    await expect(lines).toHaveCount(2, { timeout: T_SHORT });
    await expect(lines.nth(0)).toHaveText("line1");
    await expect(lines.nth(1)).toHaveText("line2");

    // Clear for next test
    await window.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
    await window.keyboard.press("Backspace");
  });

  test("slash autocomplete appears when typing /", async () => {
    const { window } = ctx;

    await cmEditor.click();
    await cmEditor.pressSequentially("/", { delay: 30 });

    const listbox = agentPanel.getByRole("listbox", { name: "Command autocomplete" });
    await expect(listbox).toBeVisible({ timeout: T_MEDIUM });

    // Should have at least one option
    const options = listbox.getByRole("option");
    await expect(options.first()).toBeVisible({ timeout: T_SHORT });
  });

  test("arrow keys navigate autocomplete options", async () => {
    const { window } = ctx;

    const listbox = agentPanel.getByRole("listbox", { name: "Command autocomplete" });
    const options = listbox.getByRole("option");

    const optionCount = await options.count();
    if (optionCount < 2) {
      test.skip();
      return;
    }

    // First option should be selected by default
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

    // ArrowDown should move selection to second option
    await window.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  });

  test("Enter selects autocomplete suggestion and closes menu", async () => {
    const { window } = ctx;

    const listbox = agentPanel.getByRole("listbox", { name: "Command autocomplete" });

    await window.keyboard.press("Enter");

    // Autocomplete menu should close
    await expect(listbox).toBeHidden({ timeout: T_SHORT });
  });

  test("draft is preserved across panel tab switches", async () => {
    const { window } = ctx;

    // Type draft text into the agent panel's input bar
    await cmEditor.click();
    const draftText = "my-draft-message";
    await cmEditor.pressSequentially(draftText, { delay: 30 });
    await expect(cmEditor).toHaveText(new RegExp(draftText));

    // Open a new terminal panel via toolbar
    await window.locator(SEL.toolbar.openTerminal).click();
    await window.waitForTimeout(T_SETTLE);

    // Verify the new terminal appeared
    const panels = window.locator(SEL.panel.gridPanel);
    await expect(panels).toHaveCount(2, { timeout: T_MEDIUM });

    // Switch back to the agent panel tab
    const tabList = window.locator(SEL.panel.tabList);
    // The agent tab should contain "Claude" in its label
    const agentTab = tabList
      .getByRole("tab")
      .filter({ hasText: /claude/i })
      .first();
    if (!(await agentTab.isVisible().catch(() => false))) {
      // If not in tab group, click directly on agent panel
      await agentPanel.click();
    } else {
      await agentTab.click();
    }

    // Wait for the editor to reappear and verify draft is preserved
    const restoredEditor = agentPanel.locator(SEL.terminal.cmEditor);
    await expect(restoredEditor).toBeAttached({ timeout: T_MEDIUM });
    await expect(restoredEditor).toHaveText(new RegExp(draftText), { timeout: T_MEDIUM });
  });
});
