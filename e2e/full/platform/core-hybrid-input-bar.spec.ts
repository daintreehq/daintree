import { test, expect, type Locator } from "@playwright/test";
import { launchApp, closeApp, refreshActiveWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { expectInputBarFocused } from "../../helpers/focus";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

import { openTerminal } from "../../helpers/panels";
let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let agentPanel: Locator;
let cmEditor: Locator;

async function ensureProjectViewOpen(): Promise<void> {
  ctx.window = await refreshActiveWindow(ctx.app, ctx.window).catch(() => ctx.window);

  const worktreeVisible = await ctx.window
    .locator("[data-worktree-branch]")
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (worktreeVisible) return;

  if (
    await ctx.window
      .getByRole("button", { name: "Open folder" })
      .isVisible({ timeout: 500 })
      .catch(() => false)
  ) {
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "HybridInputBar Test"
    );
  }
}

async function bindVisibleAgentPanel(timeout = 1_000): Promise<boolean> {
  const launchedAgentPanel = ctx.window.locator(SEL.agent.panel).first();
  if (!(await launchedAgentPanel.isVisible({ timeout }).catch(() => false))) {
    return false;
  }

  const panelId = await launchedAgentPanel.evaluate(
    (element) => element.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? ""
  );
  if (!panelId) return false;

  agentPanel = ctx.window.locator(`[data-panel-id="${panelId}"]`);
  cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
  await expect(cmEditor).toBeAttached({ timeout: T_LONG });
  return true;
}

async function ensureAgentPanelReady(): Promise<boolean> {
  await ensureProjectViewOpen();

  if (agentPanel) {
    const existingEditor = agentPanel.locator(SEL.terminal.cmEditor).first();
    if (await existingEditor.isVisible({ timeout: 500 }).catch(() => false)) {
      cmEditor = existingEditor;
      return true;
    }
  }

  if (await bindVisibleAgentPanel()) return true;

  const startBtn = ctx.window.locator(SEL.agent.startButton);
  if (!(await startBtn.isVisible({ timeout: 1_000 }).catch(() => false))) {
    return false;
  }
  await startBtn.click({ force: true });
  ctx.window = await refreshActiveWindow(ctx.app, ctx.window).catch(() => ctx.window);
  return bindVisibleAgentPanel(T_LONG);
}

async function focusCmEditor(): Promise<Locator> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await ensureAgentPanelReady())) {
      throw new Error("Claude agent panel is not available");
    }
    const editor = agentPanel.locator(SEL.terminal.cmEditor).first();
    try {
      await expect(editor).toBeAttached({ timeout: T_MEDIUM });
      await editor.scrollIntoViewIfNeeded().catch(() => undefined);
      await editor.click({ force: true, noWaitAfter: true, timeout: 5_000 });
      await expectInputBarFocused(agentPanel);
      cmEditor = editor;
      return editor;
    } catch (error) {
      lastError = error;
      await ctx.window.waitForTimeout(250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to focus CodeMirror editor");
}

test.describe.serial("Core: HybridInputBar", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "hybrid-input-bar" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "HybridInputBar Test"
    );

    // Agent panel requires CLI availability — skip all tests if not present
    if (!(await ensureAgentPanelReady())) {
        test.info().annotations.push({
          type: "conditional-skip",
          description: "Required element or state not available in this launch",
        });

      test.skip();
      return;
    }
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("can type text into CodeMirror editor", async () => {
    const { window } = ctx;

    const editor = await focusCmEditor();
    await editor.pressSequentially("hello world", { delay: 30 });

    await expect(editor).toHaveText(/hello world/);

    // Clear for next test
    await window.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
    await window.keyboard.press("Backspace");
  });

  test("Enter submits the input and clears the editor", async () => {
    const { window } = ctx;

    const editor = await focusCmEditor();
    await editor.pressSequentially("e2e-submit-test", { delay: 30 });
    await expect(editor).toHaveText(/e2e-submit-test/);

    await window.keyboard.press("Enter");

    // Editor should be cleared after submit — the submitted text should no longer appear
    await expect(editor).not.toHaveText(/e2e-submit-test/, { timeout: T_MEDIUM });
  });

  test("Shift+Enter inserts newline without submitting", async () => {
    const { window } = ctx;

    const editor = await focusCmEditor();
    await editor.pressSequentially("line1", { delay: 30 });
    await window.keyboard.press("Shift+Enter");
    await editor.pressSequentially("line2", { delay: 30 });

    // Editor should contain both lines with a newline between them
    // CM6 renders each line in a separate .cm-line element
    const lines = editor.locator(".cm-line");
    await expect(lines).toHaveCount(2, { timeout: T_SHORT });
    await expect(lines.nth(0)).toHaveText("line1");
    await expect(lines.nth(1)).toHaveText("line2");

    // Clear for next test
    await window.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
    await window.keyboard.press("Backspace");
  });

  test("slash autocomplete appears when typing /", async () => {
    const editor = await focusCmEditor();
    await editor.pressSequentially("/", { delay: 30 });

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
        test.info().annotations.push({
          type: "conditional-skip",
          description: "Required state not available in this launch",
        });

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
    const editor = await focusCmEditor();
    const draftText = "my-draft-message";
    await editor.pressSequentially(draftText, { delay: 30 });
    await expect(editor).toHaveText(new RegExp(draftText));

    // Open a new terminal panel via toolbar
    await openTerminal(window);
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
