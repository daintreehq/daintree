import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getTerminalText, runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { getGridPanelIds, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;

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

function panelHeaderIcon(panel: Locator): Locator {
  return panel.locator("[data-pane-chrome] [data-terminal-icon-id]").first();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
      await panel.locator(SEL.terminal.xtermRows).click();
      await page.keyboard.press("Enter");
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
  fixtureDir = createFixtureRepo({ name: "terminal-agent-promotion" });
  // Keep a space in the fake CLI path so toolbar launches exercise the same
  // quoted absolute executable form that real resolved paths can use.
  fakeBinDir = path.join(fixtureDir, ".e2e bin");
  mkdirSync(fakeBinDir, { recursive: true });

  const fakeClaude = path.join(fakeBinDir, "claude");
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
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
      "  if (!trusted && /[\\r\\n]/.test(String(chunk))) {",
      "    trusted = true;",
      "    console.log('FAKE_CLAUDE_READY');",
      "  }",
      "});",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(fakeClaude, 0o755);

  writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "terminal-agent-promotion",
        version: "1.0.0",
        private: true,
        scripts: {
          build: "node -e \"console.log('NPM_READY'); setTimeout(() => {}, 10000)\"",
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
  });

  test("toolbar Claude launch and plain-terminal Claude command both activate agent chrome/state", async () => {
    test.setTimeout(260_000);

    const { window } = ctx;

    await test.step("toolbar-launched Claude promotes through live detection", async () => {
      const beforeIds = new Set(await getGridPanelIds(window));
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
      expect(await getTerminalText(panel)).not.toContain(".e2e bin");

      // Regression guard: shell-command evidence has a 30s expiry. A live
      // agent must not demote to plain terminal when that timer elapses.
      await window.waitForTimeout(T_AGENT_STICKY_REGRESSION);
      await expect(panel).toHaveAttribute("data-detected-agent-id", "claude");
      await expect(panel).toHaveAttribute("data-chrome-agent-id", "claude");
      await expectRuntimeKind(panel, "agent");
      await expectPanelHeaderIcon(panel, "claude");
      await expectPanelHasAgentState(panel);

      await ptyWrite(window, toolbarPanelId, "\x03");
      await waitForTerminalText(panel, "FAKE_CLAUDE_EXIT", T_LONG);

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

    await test.step("plain terminal shows npm process chrome without agent state", async () => {
      const beforeIds = new Set(await getGridPanelIds(window));
      await openTerminal(window);
      const plainPanelId = await newestPanelId(window, beforeIds);
      const panel = window.locator(`[data-panel-id="${plainPanelId}"]`);
      await expect(panel).toBeVisible({ timeout: T_LONG });

      await expectRuntimeKind(panel, "none");
      await expectPanelHeaderIcon(panel, "terminal");
      await expectPanelHasNoAgentState(panel);

      await runTerminalCommand(window, panel, `export PATH=${shellQuote(fakeBinDir)}:$PATH`);
      await runTerminalCommand(window, panel, "npm run build");
      await waitForTerminalText(panel, "NPM_READY", T_LONG);
      await expect
        .poll(() => panel.getAttribute("data-detected-process-id"), {
          timeout: T_IDENTITY,
          intervals: [500],
        })
        .toBe("npm");
      await expectRuntimeKind(panel, "process");
      await expectPanelHeaderIcon(panel, "npm");
      await expectPanelHasNoAgentState(panel);
      await expectWorktreeTracksPlainTerminal(window, plainPanelId);

      await ptyWrite(window, plainPanelId, "\x03");

      // Do not wait for the npm badge to clear before starting Claude. This
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

      await ptyWrite(window, plainPanelId, "\x03");
      await waitForTerminalText(panel, "FAKE_CLAUDE_EXIT", T_LONG);
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
