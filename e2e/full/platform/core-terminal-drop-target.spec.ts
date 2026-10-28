import { test, expect, type CDPSession, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { expectInputBarFocused, expectTerminalFocused } from "../../helpers/focus";
import { getGridPanelIds, openTerminal } from "../../helpers/panels";
import { getTerminalText, waitForTerminalText } from "../../helpers/terminal";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { dispatchAction } from "../../helpers/actions";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";

/**
 * A file dropped on an agent pane lands where a click at the drop point would
 * have put the keyboard: the input bar for a drop on the bar, xterm for a drop
 * on the terminal of the selected pane, and the Focus first target for a drop
 * on the terminal of a pane that isn't selected. Same for a drag in from the
 * OS and one out of the file browser.
 */

const DROPPED = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md", "j.md"];

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;
let fixtureCleanup: (() => void) | undefined;
let agentPanel: Locator;
let cdp: CDPSession;

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "terminal-drop-target" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  fakeBinDir = path.join(fixtureDir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });

  const fakeClaudeImplName = process.platform === "win32" ? "claude.js" : "claude";
  const fakeClaude = path.join(fakeBinDir, fakeClaudeImplName);
  // Stays in cooked mode, so the PTY echoes whatever a drop types in.
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      "console.log('FAKE_CLAUDE_READY');",
      "process.stdin.resume();",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const shutdown = () => { clearInterval(keepAlive); process.exit(0); };",
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

  for (const name of DROPPED) writeFileSync(path.join(fixtureDir, name), `# ${name}\n`);
  execSync("git add -A && git commit -m terminal-drop-target-fixture", {
    cwd: fixtureDir,
    stdio: "ignore",
  });
}

async function newestPanelId(page: Page, previousIds: Set<string>): Promise<string> {
  await expect
    .poll(async () => (await getGridPanelIds(page)).filter((id) => !previousIds.has(id)).length, {
      timeout: T_LONG,
    })
    .toBeGreaterThan(0);
  return (await getGridPanelIds(page)).find((id) => !previousIds.has(id))!;
}

const xtermOf = (panel: Locator) => panel.locator(".xterm").first();
const editorOf = (panel: Locator) => panel.locator(SEL.terminal.cmEditor).first();

/** A drag in from Finder: real paths, delivered the way Chromium gets an OS drag. */
async function dropFromOs(target: Locator, name: string): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const data = { items: [], files: [path.join(fixtureDir, name)], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, x, y, data });
  }
}

/** Where `name` landed: typed into the agent's terminal, or as a chip in its input bar. */
async function expectLandedIn(surface: "xterm" | "hybridInput", name: string): Promise<void> {
  const editor = editorOf(agentPanel);
  if (surface === "xterm") {
    await waitForTerminalText(agentPanel, name, T_MEDIUM);
    await expect(editor).not.toContainText(name);
  } else {
    await expect(editor).toContainText(name, { timeout: T_MEDIUM });
    expect(await getTerminalText(agentPanel)).not.toContain(name);
  }
}

async function dispatchOk<T>(actionId: string, args?: unknown): Promise<T> {
  const dispatched = await dispatchAction<T>(ctx.window, actionId, args);
  if (!dispatched.ok) throw new Error(`${actionId}: ${dispatched.error.message}`);
  return dispatched.result;
}

async function setFocusFirstInputBar(enabled: boolean): Promise<void> {
  await dispatchOk("terminalConfig.setHybridInputAutoFocus", { enabled });
}

test.describe.serial("Core: where a file dropped on an agent pane lands", () => {
  let shellPanel: Locator;

  test.beforeAll(async () => {
    prepareFixture();
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
        ANTHROPIC_API_KEY: "e2e-fake-key",
      },
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Drop Target Test");
    cdp = await ctx.window.context().newCDPSession(ctx.window);

    await dismissBlockingPalette(ctx.window);
    const beforeShell = new Set(await getGridPanelIds(ctx.window));
    await openTerminal(ctx.window);
    shellPanel = ctx.window.locator(
      `[data-panel-id="${await newestPanelId(ctx.window, beforeShell)}"]`
    );

    const beforeAgent = new Set(await getGridPanelIds(ctx.window));
    await ctx.window.locator(SEL.agent.trayButton).click();
    await ctx.window.locator(SEL.agent.launcherRow("Claude")).first().click();
    agentPanel = ctx.window.locator(
      `[data-panel-id="${await newestPanelId(ctx.window, beforeAgent)}"]`
    );
    await expect(agentPanel).toHaveAttribute("data-launch-agent-id", "claude", { timeout: T_LONG });
    await waitForTerminalText(agentPanel, "FAKE_CLAUDE_READY", T_LONG);
    await expect(editorOf(agentPanel)).toBeVisible({ timeout: T_LONG });
  });

  test.afterAll(async () => {
    await cdp?.detach().catch(() => undefined);
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("the selected pane's terminal takes a drop while xterm has the keyboard", async () => {
    await xtermOf(agentPanel).click();
    await expectTerminalFocused(agentPanel);
    await dropFromOs(xtermOf(agentPanel), "a.md");
    await expectLandedIn("xterm", "a.md");
  });

  test("the selected pane's terminal takes a drop while the input bar has the keyboard", async () => {
    await editorOf(agentPanel).click();
    await expectInputBarFocused(agentPanel);
    await dropFromOs(xtermOf(agentPanel), "b.md");
    await expectLandedIn("xterm", "b.md");
    await expectTerminalFocused(agentPanel);
  });

  test("the input bar takes a drop let go over it while xterm has the keyboard", async () => {
    await xtermOf(agentPanel).click();
    await expectTerminalFocused(agentPanel);
    await dropFromOs(editorOf(agentPanel), "c.md");
    await expectLandedIn("hybridInput", "c.md");
    await expectInputBarFocused(agentPanel);
  });

  // A Finder drag can take the keyboard off the terminal before it reaches the
  // pane, and a press on a file-browser row does: the pane stays selected, so a
  // click on its terminal, and the drop, still go to xterm rather than home.
  test("the selected pane's terminal takes a drop after the keyboard has left it", async () => {
    await setFocusFirstInputBar(true);
    await xtermOf(agentPanel).click();
    await expectTerminalFocused(agentPanel);
    await ctx.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(xtermOf(agentPanel).locator(SEL.terminal.xtermHelperTextarea)).not.toBeFocused();
    await expect(agentPanel).toHaveClass(/\bterminal-selected\b/);

    await dropFromOs(xtermOf(agentPanel), "d.md");
    await expectLandedIn("xterm", "d.md");
  });

  test("another pane's terminal takes the drop on Focus first's surface", async () => {
    await setFocusFirstInputBar(true);
    await xtermOf(shellPanel).click();
    await expectTerminalFocused(shellPanel);
    await dropFromOs(xtermOf(agentPanel), "e.md");
    await expectLandedIn("hybridInput", "e.md");

    await setFocusFirstInputBar(false);
    await xtermOf(shellPanel).click();
    await expectTerminalFocused(shellPanel);
    await dropFromOs(xtermOf(agentPanel), "f.md");
    await expectLandedIn("xterm", "f.md");
  });

  test("a drag out of the file browser lands where a click on the drop point would", async () => {
    const { worktrees } = await dispatchOk<{ worktrees: Array<{ id: string; isMain: boolean }> }>(
      "worktree.list"
    );
    const worktreeId = worktrees.find((w) => w.isMain)?.id;
    expect(worktreeId).toBeTruthy();
    const { panelId } = await dispatchOk<{ panelId: string }>("worktree.openFileBrowserPanel", {
      worktreeId,
    });
    const browser = ctx.window.locator(`[data-panel-id="${panelId}"]${SEL.panel.gridPanel}`);
    await expect(browser).toBeVisible({ timeout: T_MEDIUM });
    const row = (name: string) => browser.locator('[role="treeitem"]', { hasText: name }).first();
    await expect(row("g.md")).toBeVisible({ timeout: T_MEDIUM });

    // With the browser selected, the agent's terminal is another pane's, so
    // Focus first decides where a click on it, and the drop, lands.
    await setFocusFirstInputBar(false);
    await expect(agentPanel).not.toHaveClass(/\bterminal-selected\b/);
    await row("g.md").dragTo(xtermOf(agentPanel));
    await expectLandedIn("xterm", "g.md");

    await setFocusFirstInputBar(true);
    await row("h.md").click();
    await expect(agentPanel).not.toHaveClass(/\bterminal-selected\b/);
    await row("h.md").dragTo(xtermOf(agentPanel));
    await expectLandedIn("hybridInput", "h.md");

    // Typing in the agent's terminal, then dragging a row over without
    // clicking it: the press focuses the tree but leaves the agent selected.
    await xtermOf(agentPanel).click();
    await expectTerminalFocused(agentPanel);
    await row("j.md").dragTo(xtermOf(agentPanel));
    await expectLandedIn("xterm", "j.md");

    await row("i.md").dragTo(editorOf(agentPanel));
    await expectLandedIn("hybridInput", "i.md");
  });
});
