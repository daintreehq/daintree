import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { expectInputBarFocused } from "../../helpers/focus";
import { getGridPanelIds, openTerminal } from "../../helpers/panels";
import { waitForTerminalText } from "../../helpers/terminal";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;
let fixtureCleanup: (() => void) | undefined;
let agentPanel: Locator;
let cmEditor: Locator;

const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "hybrid-input-bar" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  fakeBinDir = path.join(fixtureDir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });

  const fakeClaudeImplName = process.platform === "win32" ? "claude.js" : "claude";
  const fakeClaude = path.join(fakeBinDir, fakeClaudeImplName);

  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      "console.log('Accessing workspace: Enter to confirm');",
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "let trusted = false;",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const shutdown = () => {",
      "  console.log('FAKE_CLAUDE_EXIT');",
      "  clearInterval(keepAlive);",
      "  process.exit(0);",
      "};",
      "process.stdin.on('data', (chunk) => {",
      "  const input = String(chunk);",
      "  if (!trusted && /[\\r\\n]/.test(input)) {",
      "    trusted = true;",
      "    console.log('FAKE_CLAUDE_READY');",
      "    process.stdout.write('> ');",
      "    return;",
      "  }",
      "});",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(fakeClaude, 0o755);

  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "hybrid-input-bar", version: "1.0.0", private: true }, null, 2) + "\n"
  );
  execSync("git add -A && git commit -m hybrid-input-bar-fixture", {
    cwd: fixtureDir,
    stdio: "ignore",
  });
}

async function newestPanelId(page: Page, previousIds: Set<string>): Promise<string> {
  await expect
    .poll(async () => (await getGridPanelIds(page)).filter((id) => !previousIds.has(id)).length, {
      timeout: T_LONG,
      intervals: [250],
    })
    .toBeGreaterThan(0);
  const id = (await getGridPanelIds(page)).find((candidate) => !previousIds.has(candidate));
  expect(id).toBeTruthy();
  return id!;
}

async function launchClaudePanel(page: Page): Promise<void> {
  const beforeIds = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page);
  await page.locator(SEL.agent.trayButton).click();
  await page.getByRole("menuitem", { name: "Claude" }).click();

  const panelId = await newestPanelId(page, beforeIds);
  agentPanel = page.locator(`[data-panel-id="${panelId}"]`);
  await expect(agentPanel).toHaveAttribute("data-launch-agent-id", "claude", { timeout: T_LONG });

  cmEditor = agentPanel.locator(SEL.terminal.cmEditor).first();
  await expect(cmEditor).toBeAttached({ timeout: T_LONG });
}

async function focusCmEditor(): Promise<Locator> {
  const editor = agentPanel.locator(SEL.terminal.cmEditor).first();
  await expect(editor).toBeVisible({ timeout: T_MEDIUM });
  await editor.scrollIntoViewIfNeeded().catch(() => undefined);
  await editor.click({ force: true, noWaitAfter: true, timeout: T_MEDIUM });
  await expectInputBarFocused(agentPanel);
  cmEditor = editor;
  return editor;
}

async function clearEditor(window: Page, editor: Locator): Promise<void> {
  await window.keyboard.press(`${MODIFIER}+A`);
  await window.keyboard.press("Backspace");
  // CM6 renders the placeholder widget ("Ask Claude") inside .cm-content when the
  // document is empty, so .cm-content text is never literally "". The placeholder
  // is shown if and only if the editor is empty — use it as the cleared signal.
  await expect(editor.locator(".cm-placeholder")).toBeVisible({ timeout: T_SHORT });
}

test.describe.serial("Core: HybridInputBar", () => {
  test.beforeAll(async () => {
    prepareFixture();
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
        ANTHROPIC_API_KEY: "e2e-fake-key",
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "HybridInputBar Test"
    );

    await launchClaudePanel(ctx.window);
    await waitForTerminalText(agentPanel, "FAKE_CLAUDE_READY", T_LONG).catch(() => undefined);
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

    await clearEditor(window, editor);
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

    await clearEditor(window, editor);
  });

  test("slash autocomplete appears when typing /", async () => {
    const editor = await focusCmEditor();
    await editor.pressSequentially("/", { delay: 30 });

    const listbox = agentPanel.getByRole("listbox", { name: "Command autocomplete" });
    await expect(listbox).toBeVisible({ timeout: T_MEDIUM });

    // At least two options so arrow navigation in the next test is meaningful
    const options = listbox.getByRole("option");
    await expect(options.nth(1)).toBeVisible({ timeout: T_SHORT });
  });

  test("arrow keys navigate autocomplete options", async () => {
    const { window } = ctx;

    const listbox = agentPanel.getByRole("listbox", { name: "Command autocomplete" });
    const options = listbox.getByRole("option");

    // The previous test left the menu open with multiple options rendered.
    await expect(listbox).toBeVisible({ timeout: T_SHORT });
    await expect(options.nth(1)).toBeVisible({ timeout: T_SHORT });

    // First option should be selected by default
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });

    // ArrowDown should move selection to second option
    await window.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  });

  test("Enter selects autocomplete suggestion and closes menu", async () => {
    const { window } = ctx;

    const listbox = agentPanel.getByRole("listbox", { name: "Command autocomplete" });

    // Inherit the open menu from the prior serial test — fail loudly if absent.
    await expect(listbox).toBeVisible({ timeout: T_SHORT });

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

    // Verify the new terminal appeared as a second grid panel
    const panels = window.locator(SEL.panel.gridPanel);
    await expect(panels).toHaveCount(2, { timeout: T_MEDIUM });

    // The two panels sit side-by-side in the grid (single-tab panels don't
    // render a tab strip), so refocus the agent panel by clicking back into
    // its editor rather than a non-existent shared tab.
    const restoredEditor = agentPanel.locator(SEL.terminal.cmEditor).first();
    await expect(restoredEditor).toBeAttached({ timeout: T_MEDIUM });
    await restoredEditor.click({ force: true, noWaitAfter: true, timeout: T_MEDIUM });
    await expectInputBarFocused(agentPanel);

    // The draft survived focus moving to the new panel and back
    await expect(restoredEditor).toHaveText(new RegExp(draftText), { timeout: T_MEDIUM });
  });
});

// Regression for issue #10541: launching Claude from the primary toolbar button
// left DOM focus stranded on that button (the lazy HybridInputBar chunk hadn't
// resolved when TerminalPane's focus RAF fired, so the RAF no-opped). Pressing
// Enter at the trust prompt then re-fired the focused button's click handler,
// spawning a SECOND agent panel instead of confirming the prompt. The fix has
// HybridInputBar self-claim focus on mount and AgentButton blur on launch.
test.describe.serial("Core: HybridInputBar trust-prompt focus (#10541)", () => {
  let regCtx: AppContext;
  let regPanel: Locator;

  test.beforeAll(async () => {
    // Fresh app instance so the HybridInputBar chunk is cold on first launch —
    // that cold load is the exact window the focus race lived in.
    prepareFixture();
    regCtx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
        ANTHROPIC_API_KEY: "e2e-fake-key",
      },
    });
    regCtx.window = await openAndOnboardProject(
      regCtx.app,
      regCtx.window,
      fixtureDir,
      "HybridInputBar #10541"
    );
  });

  test.afterAll(async () => {
    if (regCtx?.app) await closeApp(regCtx.app);
    fixtureCleanup?.();
  });

  test("Enter at trust prompt confirms it without spawning a second panel", async () => {
    const window = regCtx.window;
    await dismissBlockingPalette(window);

    // Launch via the PRIMARY Start button (not the tray) — this is the surface
    // that used to retain DOM focus after a fire-and-forget launch.
    const beforeIds = new Set(await getGridPanelIds(window));
    await window.locator(SEL.agent.startButton).click();

    const panelId = await newestPanelId(window, beforeIds);
    regPanel = window.locator(`[data-panel-id="${panelId}"]`);
    await expect(regPanel).toHaveAttribute("data-launch-agent-id", "claude", { timeout: T_LONG });

    // Wait for the trust prompt to render in the PTY.
    await waitForTerminalText(regPanel, "Enter to confirm", T_LONG);

    // Invariant 1: focus landed in the input bar on mount — no click needed.
    // This is what proves the AgentButton no longer holds focus.
    await expectInputBarFocused(regPanel);

    // Press Enter WITHOUT clicking into the editor first. Pre-fix this either
    // re-fired the focused button (second panel) or did nothing.
    await window.keyboard.press("Enter");

    // Invariant 2: the keystroke reached the PTY — the fake CLI flips to READY
    // only after it receives a carriage return.
    await waitForTerminalText(regPanel, "FAKE_CLAUDE_READY", T_LONG);

    // Invariant 3: exactly one agent panel exists — no duplicate spawn. Re-check
    // after a settle window since the buggy second spawn was an async addPanel.
    expect((await getGridPanelIds(window)).filter((id) => !beforeIds.has(id))).toEqual([panelId]);
    await window.waitForTimeout(T_SETTLE);
    expect((await getGridPanelIds(window)).filter((id) => !beforeIds.has(id))).toEqual([panelId]);
  });
});
