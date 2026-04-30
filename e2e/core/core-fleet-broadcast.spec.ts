import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFocusedPanelId, getGridPanelIds, getPanelById, openTerminal } from "../helpers/panels";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

interface ActionResult<T = unknown> {
  ok?: boolean;
  result?: T;
  error?: { message?: string };
}

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function startClaudeAgentFromTerminal(page: Page): Promise<{ id: string; panel: Locator }> {
  const beforeIds = new Set(await getGridPanelIds(page));
  await openTerminal(page);
  await expect
    .poll(async () => (await getGridPanelIds(page)).filter((id) => !beforeIds.has(id)).length, {
      timeout: T_LONG,
      intervals: [250, 500],
    })
    .toBeGreaterThan(0);

  const terminalId = (await getGridPanelIds(page)).find((id) => !beforeIds.has(id)) ?? "";
  expect(terminalId).not.toBe("");

  const panel = getPanelById(page, terminalId);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await runTerminalCommand(page, panel, `export PATH=${shellQuote(fakeBinDir)}:$PATH`);
  await runTerminalCommand(page, panel, "claude");
  await waitForTerminalText(panel, "FAKE_FLEET_AGENT_READY", T_LONG);
  await expect
    .poll(() => panel.getAttribute("data-chrome-agent-id"), {
      timeout: T_MEDIUM,
      intervals: [250],
    })
    .toBe("claude");
  return { id: terminalId, panel };
}

async function armFleet(page: Page, terminalIds: string[]): Promise<void> {
  for (const terminalId of terminalIds) {
    const result = await dispatchAction(page, "terminal.arm", { terminalId }, { source: "user" });
    expect(result.ok, result.error?.message).toBe(true);
  }

  await expect(page.locator('[data-testid="fleet-arming-ribbon"]')).toBeVisible({
    timeout: T_MEDIUM,
  });
  await expect(page.locator('[data-testid="fleet-armed-count-chip"]')).toContainText("3", {
    timeout: T_MEDIUM,
  });
}

async function typeDirectlyIntoTerminal(
  page: Page,
  panel: Locator,
  terminalId: string,
  command: string
): Promise<void> {
  const xterm = panel.locator(SEL.terminal.xtermRows);
  await xterm.click();
  await expect
    .poll(() => getFocusedPanelId(page), { timeout: T_MEDIUM, intervals: [100, 250] })
    .toBe(terminalId);
  await page.waitForTimeout(100);
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

function prepareFixture(): void {
  fixtureDir = createFixtureRepo({ name: "fleet-broadcast" });
  fakeBinDir = path.join(fixtureDir, ".e2e bin");
  mkdirSync(fakeBinDir, { recursive: true });

  const fakeClaude = path.join(fakeBinDir, "claude");
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      "console.log('claude code v9.9.9');",
      "console.log('FAKE_FLEET_AGENT_READY pid=' + process.pid);",
      "process.stdout.write('> ');",
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "let buffer = '';",
      "const keepAlive = setInterval(() => {}, 1000);",
      "function shutdown() {",
      "  console.log('FAKE_FLEET_AGENT_EXIT pid=' + process.pid);",
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
      "  console.log('FLEET_RESPONSE pid=' + process.pid + ' text=' + line);",
      "  console.log('FLEET_DONE ' + line);",
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
  chmodSync(fakeClaude, 0o755);
}

test.describe.serial("Core: Fleet terminal broadcast", () => {
  test.beforeAll(async () => {
    prepareFixture();
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
      },
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Broadcast");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("direct xterm typing into one armed agent terminal reaches the whole fleet", async () => {
    test.setTimeout(180_000);

    const { window } = ctx;
    const disableHybrid = await dispatchAction(
      window,
      "terminalConfig.setHybridInputEnabled",
      { enabled: false },
      { source: "user" }
    );
    expect(disableHybrid.ok, disableHybrid.error?.message).toBe(true);

    const agents = [
      await startClaudeAgentFromTerminal(window),
      await startClaudeAgentFromTerminal(window),
      await startClaudeAgentFromTerminal(window),
    ];
    const terminalIds = agents.map((agent) => agent.id);
    expect(new Set(terminalIds).size).toBe(3);

    await armFleet(window, terminalIds);

    const command = `fleet-direct-${Date.now()}`;
    await typeDirectlyIntoTerminal(window, agents[0]!.panel, agents[0]!.id, command);

    for (const { panel } of agents) {
      await waitForTerminalText(panel, `FLEET_RESPONSE`, T_LONG);
      await waitForTerminalText(panel, `text=${command}`, T_LONG);
      await waitForTerminalText(panel, `FLEET_DONE ${command}`, T_LONG);
    }

    await expect(window.locator('[data-testid="fleet-arming-ribbon"]')).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(agents[0]!.panel.locator(SEL.terminal.cmEditor)).toHaveCount(0);
  });

  test("Cmd+Alt+Arrow cycles focus across the fleet grid (#5989)", async () => {
    test.setTimeout(60_000);

    const { window } = ctx;

    // Self-contained: arm whatever grid panels exist (idempotent if a prior
    // test already armed them) so this test passes when run in isolation
    // (e.g., `playwright test --grep "#5989"`).
    const gridIds = await getGridPanelIds(window);
    expect(gridIds.length).toBeGreaterThanOrEqual(2);
    for (const id of gridIds) {
      await dispatchAction(window, "terminal.arm", { terminalId: id }, { source: "user" });
    }

    // Activate fleet scope so ContentGrid renders the flat fleet grid —
    // the path where useGridNavigation regressed in #5989.
    const enter = await dispatchAction(window, "fleet.scope.enter", undefined, { source: "user" });
    expect(enter.ok, enter.error?.message).toBe(true);

    const fleetIds = await getGridPanelIds(window);
    expect(fleetIds.length).toBeGreaterThanOrEqual(2);

    // Click the first fleet panel to anchor focus.
    const firstId = fleetIds[0]!;
    await getPanelById(window, firstId).click();
    await expect
      .poll(() => getFocusedPanelId(window), { timeout: T_MEDIUM, intervals: [100, 250] })
      .toBe(firstId);

    // Pre-fix, this dispatch was a silent no-op because the nav model was
    // built from the active worktree's tab groups, not the fleet armOrder.
    const right = await dispatchAction(window, "terminal.focusRight", undefined, {
      source: "keybinding",
    });
    expect(right.ok, right.error?.message).toBe(true);

    await expect
      .poll(() => getFocusedPanelId(window), { timeout: T_MEDIUM, intervals: [100, 250] })
      .toBe(fleetIds[1]!);

    const exit = await dispatchAction(window, "fleet.scope.exit", undefined, { source: "user" });
    expect(exit.ok, exit.error?.message).toBe(true);
  });
});
