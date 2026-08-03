import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  getTerminalText,
  runTerminalCommand,
  waitForTerminalText,
  writeTerminalInput,
} from "../helpers/terminal";
import { getGridPanelIds, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import { dismissBlockingPalette } from "../helpers/overlays";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;
let fixtureCleanup: (() => void) | undefined;

const AGENT_STATE_VALUES = new Set([
  "idle",
  "working",
  "waiting",
  "directing",
  "completed",
  "exited",
]);

const T_IDENTITY = 60_000;
const T_AGENT_STICKY_REGRESSION = 45_000;
const FAKE_CLAUDE_STOP = "__DAINTREE_FAKE_CLAUDE_STOP__";
const FAKE_NPM_STOP = "__DAINTREE_FAKE_NPM_STOP__";
const fakeBuildProcess = [
  "console.log('NPM_READY');",
  "process.stdin.resume();",
  "process.stdin.setEncoding('utf8');",
  `process.stdin.on('data', (chunk) => { if (String(chunk).includes('${FAKE_NPM_STOP}')) { console.log('NPM_EXIT'); process.exit(0); } });`,
  "setTimeout(() => {}, 10000);",
].join(" ");

function panelHeaderIcon(panel: Locator): Locator {
  return panel.locator("[data-pane-chrome] [data-terminal-icon-id]").first();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function prependPathCommand(dir: string): string {
  if (process.platform === "win32") {
    return `$env:PATH = ${powershellQuote(`${dir}${path.delimiter}`)} + $env:PATH`;
  }
  return `export PATH=${shellQuote(dir)}:$PATH`;
}

function buildProcessCommand(): string {
  // Exercise the transition with the long-running process directly. Going
  // through `npm run build` makes the expected badge timing-dependent: shell
  // evidence first reports npm, then the process tree correctly promotes its
  // higher-priority Node child. npm fallback has dedicated badge coverage.
  return `node -e ${JSON.stringify(fakeBuildProcess)}`;
}

function expectedBuildProcessId(): string {
  return "node";
}

async function expectPanelHeaderIcon(panel: Locator, iconId: string): Promise<void> {
  await expect
    .poll(() => panelHeaderIcon(panel).getAttribute("data-terminal-icon-id"), {
      timeout: T_MEDIUM,
      intervals: [250],
    })
    .toBe(iconId);
}

async function confirmClaudeWorkspaceTrustIfPrompted(page: Page, panel: Locator): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const text = await getTerminalText(panel);
    const lower = text.toLowerCase();

    if (lower.includes("fake_claude_ready")) return;

    if (
      lower.includes("accessing workspace") ||
      lower.includes("yes, i trust this folder") ||
      lower.includes("enter to confirm")
    ) {
      await writeTerminalInput(page, panel, "\r");
      return;
    }

    await page.waitForTimeout(250);
  }
}

async function expectRuntimeKind(panel: Locator, runtimeKind: string): Promise<void> {
  await expect
    .poll(() => panel.getAttribute("data-runtime-kind"), {
      timeout: T_MEDIUM,
      intervals: [250],
    })
    .toBe(runtimeKind);
}

async function expectPanelHasAgentState(panel: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await panel.getAttribute("data-agent-state");
        return state !== null && AGENT_STATE_VALUES.has(state);
      },
      { timeout: T_LONG, intervals: [250, 500] }
    )
    .toBe(true);
}

async function expectPanelHasNoAgentState(panel: Locator): Promise<void> {
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), {
      timeout: T_MEDIUM,
      intervals: [250],
    })
    .toBeNull();
}

async function expandVisibleWorktreeTerminalAccordions(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      'button[aria-controls$="-terminals-panel"][aria-expanded="false"]'
    )) {
      button.click();
    }
  });
}

function worktreeTerminalRow(page: Page, terminalId: string): Locator {
  return page.locator(`[data-terminal-id="${terminalId}"][data-terminal-runtime-kind]`).first();
}

async function ptyWrite(page: Page, terminalId: string, data: string): Promise<void> {
  const result = await page.evaluate(
    ([id, payload]) => {
      const w = window as unknown as {
        electron?: { terminal?: { write?: (id: string, data: string) => void } };
      };
      if (!w.electron?.terminal?.write) {
        return { ok: false, reason: "terminal.write API missing" };
      }
      w.electron.terminal.write(id, payload);
      return { ok: true };
    },
    [terminalId, data]
  );

  if (!result.ok) throw new Error(`ptyWrite failed: ${result.reason}`);
}

async function stopFakeClaude(page: Page, panel: Locator, terminalId: string): Promise<void> {
  await ptyWrite(page, terminalId, `${FAKE_CLAUDE_STOP}\r`);
  await waitForTerminalText(panel, "FAKE_CLAUDE_EXIT", T_LONG);
}

async function stopFakeNpm(page: Page, panel: Locator, terminalId: string): Promise<void> {
  await ptyWrite(page, terminalId, `${FAKE_NPM_STOP}\r`);
  await waitForTerminalText(panel, "NPM_EXIT", T_LONG);
}

async function expectWorktreeTracksAgent(
  page: Page,
  terminalId: string,
  agentId: string
): Promise<void> {
  const row = worktreeTerminalRow(page, terminalId);
  await expect
    .poll(
      async () => {
        await expandVisibleWorktreeTerminalAccordions(page);
        return (await row.count()) > 0;
      },
      { timeout: T_LONG, intervals: [500] }
    )
    .toBe(true);
  await expect
    .poll(() => row.getAttribute("data-terminal-agent-id"), {
      timeout: T_MEDIUM,
      intervals: [250],
    })
    .toBe(agentId);
  await expect
    .poll(
      async () => {
        const state = await row.getAttribute("data-terminal-agent-state");
        return state !== null && AGENT_STATE_VALUES.has(state);
      },
      { timeout: T_LONG, intervals: [250, 500] }
    )
    .toBe(true);
}

async function expectWorktreeTracksPlainTerminal(page: Page, terminalId: string): Promise<void> {
  const row = worktreeTerminalRow(page, terminalId);
  await expect
    .poll(
      async () => {
        await expandVisibleWorktreeTerminalAccordions(page);
        return (await row.count()) > 0;
      },
      { timeout: T_LONG, intervals: [500] }
    )
    .toBe(true);
  await expect
    .poll(() => row.getAttribute("data-terminal-agent-id"), {
      timeout: T_MEDIUM,
      intervals: [250],
    })
    .toBeNull();
  await expect
    .poll(() => row.getAttribute("data-terminal-agent-state"), {
      timeout: T_MEDIUM,
      intervals: [250],
    })
    .toBeNull();
}

async function newestPanelId(page: Page, previousIds: Set<string>): Promise<string> {
  await expect
    .poll(async () => (await getGridPanelIds(page)).filter((id) => !previousIds.has(id)).length, {
      timeout: T_LONG,
      intervals: [250],
    })
    .toBeGreaterThan(0);
  const ids = await getGridPanelIds(page);
  const id = ids.find((candidate) => !previousIds.has(candidate));
  expect(id).toBeTruthy();
  return id!;
}

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "terminal-agent-promotion" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  // Keep a space in the fake CLI path so toolbar launches exercise the same
  // quoted absolute executable form that real resolved paths can use.
  fakeBinDir = path.join(fixtureDir, ".e2e bin");
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
      `const stopToken = ${JSON.stringify(FAKE_CLAUDE_STOP)};`,
      "console.log('Accessing workspace:');",
      "console.log('');",
      "console.log(' ' + process.cwd());",
      "console.log('');",
      "console.log(' Quick safety check: Is this a project you created or one you trust?');",
      "console.log('');",
      "console.log(' ❯ 1. Yes, I trust this folder');",
      "console.log('   2. No, exit');",
      "console.log('');",
      "console.log(' Enter to confirm · Esc to cancel');",
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
      "    return;",
      "  }",
      "  if (trusted && input.includes(stopToken)) {",
      "    shutdown();",
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
    JSON.stringify(
      {
        name: "terminal-agent-promotion",
        version: "1.0.0",
        private: true,
        scripts: {
          build: `node -e ${JSON.stringify(fakeBuildProcess)}`,
        },
      },
      null,
      2
    ) + "\n"
  );
  execSync("git add -A && git commit -m identity-fixture", { cwd: fixtureDir, stdio: "ignore" });
}

test.describe.serial("Core: terminal runtime agent promotion", () => {
  test.beforeAll(async () => {
    prepareFixture();
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
        DAINTREE_IDENTITY_DEBUG_PASS: "1",
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Terminal Agent Promotion"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("toolbar Claude launch and plain-terminal Claude command both activate agent chrome/state", async () => {
    test.setTimeout(360_000);

    const { window } = ctx;

    await test.step("toolbar-launched Claude promotes through live detection", async () => {
      const beforeIds = new Set(await getGridPanelIds(window));
      await dismissBlockingPalette(window);
      await window.locator(SEL.agent.trayButton).click();
      await window.getByRole("menuitem", { name: "Claude" }).click();

      const toolbarPanelId = await newestPanelId(window, beforeIds);
      const panel = window.locator(`[data-panel-id="${toolbarPanelId}"]`);
      await confirmClaudeWorkspaceTrustIfPrompted(window, panel);
      await waitForTerminalText(panel, "FAKE_CLAUDE_READY", T_LONG);

      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), {
          timeout: T_IDENTITY,
          intervals: [250, 500],
        })
        .toBe("claude");
      await expect(panel).toHaveAttribute("data-chrome-agent-id", "claude");
      await expectRuntimeKind(panel, "agent");
      await expectPanelHeaderIcon(panel, "claude");
      await expectPanelHasAgentState(panel);
      await expectWorktreeTracksAgent(window, toolbarPanelId, "claude");
      // PowerShell echoes the resolved shim path when launching a .cmd agent on
      // Windows; the Unix guard still protects against leaking the helper path
      // into the agent's own visible output.
      if (process.platform !== "win32") {
        expect(await getTerminalText(panel)).not.toContain(".e2e bin");
      }

      // Regression guard: shell-command evidence has a 30s expiry. A live
      // agent must not demote to plain terminal when that timer elapses.
      await window.waitForTimeout(T_AGENT_STICKY_REGRESSION);
      await expect(panel).toHaveAttribute("data-detected-agent-id", "claude");
      await expect(panel).toHaveAttribute("data-chrome-agent-id", "claude");
      await expectRuntimeKind(panel, "agent");
      await expectPanelHeaderIcon(panel, "claude");
      await expectPanelHasAgentState(panel);

      await stopFakeClaude(window, panel, toolbarPanelId);

      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), {
          timeout: T_IDENTITY,
          intervals: [500],
        })
        .toBeNull();
      await expect
        .poll(() => panel.getAttribute("data-chrome-agent-id"), {
          timeout: T_MEDIUM,
          intervals: [250],
        })
        .toBeNull();
      await expectRuntimeKind(panel, "none");
      await expectPanelHeaderIcon(panel, "terminal");
      await expectPanelHasNoAgentState(panel);
      await expectWorktreeTracksPlainTerminal(window, toolbarPanelId);
    });

    await test.step("plain terminal shows build process chrome without agent state", async () => {
      const beforeIds = new Set(await getGridPanelIds(window));
      await openTerminal(window);
      const plainPanelId = await newestPanelId(window, beforeIds);
      const panel = window.locator(`[data-panel-id="${plainPanelId}"]`);
      await expect(panel).toBeVisible({ timeout: T_LONG });

      await expectRuntimeKind(panel, "none");
      await expectPanelHeaderIcon(panel, "terminal");
      await expectPanelHasNoAgentState(panel);

      await runTerminalCommand(window, panel, prependPathCommand(fakeBinDir));
      await runTerminalCommand(window, panel, buildProcessCommand());
      await waitForTerminalText(panel, "NPM_READY", T_LONG);
      const buildProcessId = expectedBuildProcessId();
      await expect
        .poll(() => panel.getAttribute("data-detected-process-id"), {
          timeout: T_IDENTITY,
          intervals: [500],
        })
        .toBe(buildProcessId);
      await expectRuntimeKind(panel, "process");
      await expectPanelHeaderIcon(panel, buildProcessId);
      await expectPanelHasNoAgentState(panel);
      await expectWorktreeTracksPlainTerminal(window, plainPanelId);

      await stopFakeNpm(window, panel, plainPanelId);

      // Do not wait for the process badge to clear before starting Claude. This
      // exercises the stale process → fresh agent promotion path that regressed.
      await window.waitForTimeout(500);
      await runTerminalCommand(window, panel, "claude");
      await confirmClaudeWorkspaceTrustIfPrompted(window, panel);
      await waitForTerminalText(panel, "FAKE_CLAUDE_READY", T_LONG);

      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), {
          timeout: T_IDENTITY,
          intervals: [250, 500],
        })
        .toBe("claude");
      await expect
        .poll(() => panel.getAttribute("data-chrome-agent-id"), {
          timeout: T_MEDIUM,
          intervals: [250],
        })
        .toBe("claude");
      await expectRuntimeKind(panel, "agent");
      await expectPanelHeaderIcon(panel, "claude");
      await expectPanelHasAgentState(panel);
      await expectWorktreeTracksAgent(window, plainPanelId, "claude");

      await window.waitForTimeout(T_AGENT_STICKY_REGRESSION);
      await expect(panel).toHaveAttribute("data-detected-agent-id", "claude");
      await expect(panel).toHaveAttribute("data-chrome-agent-id", "claude");
      await expectRuntimeKind(panel, "agent");
      await expectPanelHeaderIcon(panel, "claude");
      await expectPanelHasAgentState(panel);

      await stopFakeClaude(window, panel, plainPanelId);
      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), {
          timeout: T_IDENTITY,
          intervals: [500],
        })
        .toBeNull();
      await expectRuntimeKind(panel, "none");
      await expectPanelHeaderIcon(panel, "terminal");
      await expectPanelHasNoAgentState(panel);
      await expectWorktreeTracksPlainTerminal(window, plainPanelId);
    });

    // The fake CLI should have run via the terminal, not via a mocked store
    // shortcut. This catches tests that accidentally pass without touching PTY.
    const allText = await getTerminalText(window.locator(SEL.panel.gridPanel).last());
    expect(allText).toContain("FAKE_CLAUDE_READY");
  });
});
