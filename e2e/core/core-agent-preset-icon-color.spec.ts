import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  refreshActiveWindow,
  removeSingletonFiles,
  type AppContext,
} from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getPanelById } from "../helpers/panels";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

interface ActionResult<T = unknown> {
  ok?: boolean;
  result?: T;
  error?: { message?: string };
}

const CLAUDE_PRESET_ID = "e2e-claude-blue";
const CODEX_PRESET_ID = "e2e-codex-green";
const CLAUDE_COLOR = "#3366ff";
const CODEX_COLOR = "#22aa66";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;

async function dispatchAction<T = unknown>(
  page: Page,
  actionId: string,
  args?: unknown,
  options?: { source?: string; confirmed?: boolean }
): Promise<ActionResult<T>> {
  return page.evaluate(
    ([id, actionArgs, dispatchOptions]) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            actionId: string,
            args?: unknown,
            options?: { source?: string; confirmed?: boolean }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (!dispatch) return { ok: false, error: { message: "dispatch bridge missing" } };
      return dispatch(id, actionArgs, dispatchOptions);
    },
    [actionId, args, options] as const
  ) as Promise<ActionResult<T>>;
}

function writeFakeAgent(agentId: "claude" | "codex"): void {
  const scriptPath = path.join(fakeBinDir, agentId);
  const label = agentId.toUpperCase();
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      `  console.log('${agentId} fake v9.9.9');`,
      "  process.exit(0);",
      "}",
      `console.log('FAKE_${label}_READY pid=' + process.pid);`,
      `console.log('FAKE_${label}_COLOR=' + (process.env.DAINTREE_E2E_AGENT_COLOR || ''));`,
      `console.log('FAKE_${label}_PROVIDER=' + (process.env.DAINTREE_E2E_PROVIDER || ''));`,
      `console.log('FAKE_${label}_MANUAL=' + (process.env.DAINTREE_E2E_MANUAL_RUN || ''));`,
      "process.stdout.write('> ');",
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "let buffer = '';",
      "const keepAlive = setInterval(() => {}, 1000);",
      "function shutdown() {",
      `  console.log('FAKE_${label}_EXIT pid=' + process.pid);`,
      "  clearInterval(keepAlive);",
      "  process.exit(0);",
      "}",
      "function handleLine(raw) {",
      "  const line = raw.trim();",
      "  if (!line) {",
      "    process.stdout.write('> ');",
      "    return;",
      "  }",
      "  if (line === '/quit') shutdown();",
      `  console.log('FAKE_${label}_ECHO=' + line);`,
      "  process.stdout.write('> ');",
      "}",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += String(chunk).replace(/\\r/g, '\\n');",
      "  let idx = buffer.indexOf('\\n');",
      "  while (idx >= 0) {",
      "    const line = buffer.slice(0, idx);",
      "    buffer = buffer.slice(idx + 1);",
      "    handleLine(line);",
      "    idx = buffer.indexOf('\\n');",
      "  }",
      "});",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(scriptPath, 0o755);

  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, `${agentId}.cmd`),
      [`@echo off`, `node "%~dp0\\${agentId}" %*`, ""].join("\r\n")
    );
  }
}

function prepareFixture(): void {
  fixtureDir = createFixtureRepo({ name: "agent-preset-icon-color" });
  fakeBinDir = path.join(fixtureDir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeAgent("claude");
  writeFakeAgent("codex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function fakeAgentCommand(agentId: "claude" | "codex"): string {
  const scriptPath =
    process.platform === "win32"
      ? path.join(fakeBinDir, `${agentId}.cmd`)
      : path.join(fakeBinDir, agentId);
  return shellQuote(scriptPath);
}

function launchEnv(): Record<string, string> {
  return {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
    ANTHROPIC_API_KEY: "e2e-fake-key",
    OPENAI_API_KEY: "e2e-fake-key",
  };
}

async function configurePresets(page: Page): Promise<void> {
  const claudeResult = await dispatchAction(page, "agentSettings.set", {
    agentId: "claude",
    settings: {
      pinned: true,
      presetId: CLAUDE_PRESET_ID,
      customPresets: [
        {
          id: CLAUDE_PRESET_ID,
          name: "E2E Blue Provider",
          env: {
            DAINTREE_E2E_AGENT_COLOR: CLAUDE_COLOR,
            DAINTREE_E2E_PROVIDER: "blue-provider",
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
          color: CLAUDE_COLOR,
        },
      ],
    },
  });
  expect(claudeResult.ok, claudeResult.error?.message).toBe(true);

  const codexResult = await dispatchAction(page, "agentSettings.set", {
    agentId: "codex",
    settings: {
      pinned: true,
      presetId: CODEX_PRESET_ID,
      customPresets: [
        {
          id: CODEX_PRESET_ID,
          name: "E2E Green Provider",
          env: {
            DAINTREE_E2E_AGENT_COLOR: CODEX_COLOR,
            DAINTREE_E2E_PROVIDER: "green-provider",
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
          color: CODEX_COLOR,
        },
      ],
    },
  });
  expect(codexResult.ok, codexResult.error?.message).toBe(true);
}

async function expectPersistedPresetColor(
  page: Page,
  agentId: "claude" | "codex",
  presetId: string,
  color: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ targetAgentId, targetPresetId }) => {
            const settings = await window.electron.agentSettings.get();
            const preset = settings.agents[targetAgentId]?.customPresets?.find(
              (entry) => entry.id === targetPresetId
            );
            return preset?.color ?? null;
          },
          { targetAgentId: agentId, targetPresetId: presetId }
        ),
      { timeout: T_MEDIUM, intervals: [250, 500] }
    )
    .toBe(color);
}

async function launchPreset(
  page: Page,
  agentId: "claude" | "codex",
  presetId: string
): Promise<{ id: string; panel: Locator }> {
  const result = await dispatchAction<{ terminalId?: string | null }>(
    page,
    "agent.launch",
    {
      agentId,
      presetId,
      cwd: fixtureDir,
      location: "grid",
    },
    { source: "user" }
  );
  expect(result.ok, result.error?.message).toBe(true);
  const terminalId = result.result?.terminalId ?? "";
  expect(terminalId).not.toBe("");

  const panel = getPanelById(page, terminalId);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await expect(panel).toHaveAttribute("data-launch-agent-id", agentId, { timeout: T_LONG });
  return { id: terminalId, panel };
}

async function expectAgentIconColor(
  panel: Locator,
  agentId: "claude" | "codex",
  color: string
): Promise<void> {
  await expect(panel).toHaveAttribute("data-chrome-agent-id", agentId, { timeout: T_LONG });
  await expect(panel).toHaveAttribute("data-runtime-icon-id", agentId, { timeout: T_LONG });
  const icon = panel.locator(`[data-terminal-icon-id="${agentId}"]`).first();
  await expect(icon).toHaveAttribute("data-terminal-icon-color", color, { timeout: T_LONG });
  await expect(icon.locator("path").first()).toHaveAttribute("fill", color, {
    timeout: T_LONG,
  });
}

async function quitAgentOrWaitForDemotion(page: Page, panel: Locator): Promise<void> {
  await runTerminalCommand(page, panel, "/quit");
  await expect
    .poll(() => panel.getAttribute("data-runtime-kind"), {
      timeout: T_LONG,
      intervals: [250, 500],
    })
    .toBe("none");
}

async function restartTerminal(page: Page, terminalId: string, panel: Locator): Promise<void> {
  const result = await dispatchAction(
    page,
    "terminal.restart",
    { terminalId },
    { source: "user", confirmed: true }
  );
  expect(result.ok, result.error?.message).toBe(true);
  await expect(panel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_LONG });
  await expect
    .poll(() => panel.getAttribute("data-runtime-kind"), {
      timeout: T_LONG,
      intervals: [250, 500],
    })
    .toBe("none");
}

test.describe.serial("Core: Agent preset icon color", () => {
  test.beforeAll(async () => {
    prepareFixture();
    ctx = await launchApp({ env: launchEnv() });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Agent Preset Icon Color"
    );

    await configurePresets(ctx.window);
    await expectPersistedPresetColor(ctx.window, "claude", CLAUDE_PRESET_ID, CLAUDE_COLOR);
    await expectPersistedPresetColor(ctx.window, "codex", CODEX_PRESET_ID, CODEX_COLOR);

    const userDataDir = ctx.userDataDir;
    await closeApp(ctx.app);
    removeSingletonFiles(userDataDir);
    ctx = await launchApp({ userDataDir, env: launchEnv() });
    ctx.window = await refreshActiveWindow(ctx.app);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("preset color tints launch, survives app restart, and reapplies after quit/restart", async () => {
    test.setTimeout(180_000);

    const disableHybrid = await dispatchAction(
      ctx.window,
      "terminalConfig.setHybridInputEnabled",
      { enabled: false },
      { source: "user" }
    );
    expect(disableHybrid.ok, disableHybrid.error?.message).toBe(true);

    await expectPersistedPresetColor(ctx.window, "claude", CLAUDE_PRESET_ID, CLAUDE_COLOR);
    const claude = await launchPreset(ctx.window, "claude", CLAUDE_PRESET_ID);
    await expectAgentIconColor(claude.panel, "claude", CLAUDE_COLOR);
    // Wait for the fake script to finish its startup logs before sending /quit —
    // without this, keystrokes typed during the shell→script handover can be
    // dropped, leaving the agent runtime alive and stalling the demote.
    // FAKE_CLAUDE_MANUAL is the script's last startup line; once it prints the
    // stdin handler is bound and the buffer reader still sees it after reflow.
    await waitForTerminalText(claude.panel, "FAKE_CLAUDE_MANUAL=", T_LONG);

    await quitAgentOrWaitForDemotion(ctx.window, claude.panel);
    await restartTerminal(ctx.window, claude.id, claude.panel);
    await runTerminalCommand(
      ctx.window,
      claude.panel,
      `DAINTREE_E2E_MANUAL_RUN=1 ${fakeAgentCommand("claude")}`
    );
    await waitForTerminalText(claude.panel, "FAKE_CLAUDE_MANUAL=1", T_LONG);
    await waitForTerminalText(claude.panel, `FAKE_CLAUDE_COLOR=${CLAUDE_COLOR}`, T_LONG);
    await expectAgentIconColor(claude.panel, "claude", CLAUDE_COLOR);

    const codex = await launchPreset(ctx.window, "codex", CODEX_PRESET_ID);
    await expectAgentIconColor(codex.panel, "codex", CODEX_COLOR);
    await waitForTerminalText(codex.panel, "FAKE_CODEX_READY", T_LONG);
    await waitForTerminalText(codex.panel, `FAKE_CODEX_COLOR=${CODEX_COLOR}`, T_LONG);
    await waitForTerminalText(codex.panel, "FAKE_CODEX_PROVIDER=green-provider", T_LONG);
    expect(CODEX_COLOR).not.toBe(CLAUDE_COLOR);
  });
});
