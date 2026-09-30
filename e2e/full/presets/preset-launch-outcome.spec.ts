import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "path";
import {
  launchApp,
  closeApp,
  refreshActiveWindow,
  removeSingletonFiles,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { dispatchAction } from "../../helpers/actions";
import { getPanelById } from "../../helpers/panels";
import { runTerminalCommand, waitForTerminalText } from "../../helpers/terminal";
import {
  FAKE_AGENT_READY,
  FAKE_AGENT_STOP,
  ptyWrite,
  readFakeAgentLaunchLog,
} from "../../helpers/fakeAgent";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  getPresetOptionLabels,
  removeCcrConfig,
} from "../../helpers/presets";
import {
  installPresetAgents,
  closeSettings,
  setAgentSettings,
  waitForLaunchesSince,
  type FakeAgents,
} from "./presetHarness";

// What a preset does to the agent it launches: the colour on the agent mark,
// in the grid and on a dock chip, across a quit, a terminal restart and an app
// restart — and the env and args the CLI process itself received.

const CLAUDE_PRESET_ID = "e2e-claude-blue";
const CLAUDE_PRESET_NAME = "E2E Blue Provider";
const CLAUDE_COLOR = "#3366ff";
const CLAUDE_ARG = "--e2e-blue-arg";
const CODEX_PRESET_ID = "e2e-codex-green";
const CODEX_PRESET_NAME = "E2E Green Provider";
const CODEX_COLOR = "#22aa66";
const PANEL_PRESET_ID = "e2e-panel-preset";
const PANEL_PRESET_NAME = "E2E Panel Preset";
const PANEL_COLOR = "#7744ee";

let ctx: AppContext;
let agents: FakeAgents;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function manualClaudeCommand(): string {
  if (process.platform === "win32") {
    return `& '${path.join(agents.claudeBin, "claude.cmd").replace(/'/g, "''")}' --manual`;
  }
  return `${shellQuote(path.join(agents.claudeBin, "claude"))} --manual`;
}

async function configurePresets(page: Page): Promise<void> {
  // Settings has rendered from the agent-settings store before this write, so
  // the store's boot hydration can no longer land on top of it.
  await navigateToAgentSettings(page, "claude");
  await setAgentSettings(page, "claude", {
    pinned: true,
    customPresets: [
      {
        id: CLAUDE_PRESET_ID,
        name: CLAUDE_PRESET_NAME,
        env: { DAINTREE_E2E_AGENT_COLOR: CLAUDE_COLOR, DAINTREE_E2E_PROVIDER: "blue-provider" },
        args: [CLAUDE_ARG],
        color: CLAUDE_COLOR,
      },
      { id: PANEL_PRESET_ID, name: PANEL_PRESET_NAME, color: PANEL_COLOR },
    ],
  });
  await setAgentSettings(page, "codex", {
    pinned: true,
    customPresets: [
      {
        id: CODEX_PRESET_ID,
        name: CODEX_PRESET_NAME,
        env: { DAINTREE_E2E_AGENT_COLOR: CODEX_COLOR, DAINTREE_E2E_PROVIDER: "green-provider" },
        color: CODEX_COLOR,
      },
    ],
  });
  await expect
    .poll(() => getPresetOptionLabels(page))
    .toEqual(expect.arrayContaining([CLAUDE_PRESET_NAME, PANEL_PRESET_NAME]));
  await navigateToAgentSettings(page, "codex");
  await expect.poll(() => getPresetOptionLabels(page)).toContain(CODEX_PRESET_NAME);
  await closeSettings(page);
}

async function launchPreset(
  page: Page,
  agentId: "claude" | "codex",
  presetId: string
): Promise<{ id: string; panel: Locator }> {
  const result = await dispatchAction<{ terminalId?: string | null }>(
    page,
    "agent.launch",
    { agentId, presetId, cwd: fixtureDir, location: "grid" },
    { source: "user" }
  );
  expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
  const terminalId = (result.ok && result.result?.terminalId) || "";
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
  // The marker is the preset colour contract; the glyph itself stays on
  // `currentColor` and `.brand-mark` paints it from the inks BrandMark
  // publishes. Asserting the painted colour equals the ink for the mark's
  // current state (active or resting) proves the whole chain ran.
  await expect(icon.locator("path").first()).toHaveAttribute("fill", "currentColor");
  const svg = icon.locator("svg").first();
  await expect
    .poll(
      () =>
        svg.evaluate((el) => {
          const computed = getComputedStyle(el);
          const rest = computed.getPropertyValue("--brand-mark-rest").trim();
          const active = computed.getPropertyValue("--brand-mark-active").trim();
          const toRgb = (hex: string): string => {
            const raw = hex.replace("#", "");
            const body =
              raw.length === 3
                ? raw
                    .split("")
                    .map((c) => c + c)
                    .join("")
                : raw;
            const [r, g, b] = [0, 2, 4].map((i) => parseInt(body.slice(i, i + 2), 16));
            return `rgb(${r}, ${g}, ${b})`;
          };
          // The stylesheet's own active selectors — not `:hover`, which html and
          // body match whenever the pointer is in the window.
          const isActive =
            el.closest("[data-brand-active]") !== null ||
            el.closest('[role="tab"][aria-selected="true"]') !== null ||
            el.closest('[role="option"][aria-selected="true"]') !== null;
          const expected = isActive ? active : rest;
          return {
            restIsHex: /^#[0-9a-f]{6}$/i.test(rest),
            activeIsHex: /^#[0-9a-f]{6}$/i.test(active),
            fadesIntoTheActiveInk: rest !== active,
            paintedMatchesState: expected !== "" && computed.color === toRgb(expected),
            hasBrandClass: el.classList.contains("brand-mark"),
          };
        }),
      { timeout: T_LONG, intervals: [250, 500] }
    )
    .toEqual({
      restIsHex: true,
      activeIsHex: true,
      fadesIntoTheActiveInk: true,
      paintedMatchesState: true,
      hasBrandClass: true,
    });
}

async function expectRuntimeKind(panel: Locator, kind: string): Promise<void> {
  await expect
    .poll(() => panel.getAttribute("data-runtime-kind"), { timeout: T_LONG, intervals: [250, 500] })
    .toBe(kind);
}

test.describe("Presets: launch outcome", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    const { dir, cleanup } = createFixtureRepo({ name: "preset-launch-outcome" });
    fixtureDir = dir;
    agents = installPresetAgents(dir, { codex: true });
    fixtureCleanup = () => {
      cleanup();
      agents.dispose();
    };
    ctx = await launchApp({ env: agents.env });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Preset Launch Outcome");
    await configurePresets(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("preset env, args and color reach the agent, and the color reapplies after quit and restart", async () => {
    test.setTimeout(180_000);
    const claudeBin = agents.claudeBin;
    const codexBin = agents.codexBin as string;

    await test.step("Disable hybrid input so typed input reaches the agent's stdin", async () => {
      const result = await dispatchAction(
        ctx.window,
        "terminalConfig.setHybridInputEnabled",
        { enabled: false },
        { source: "user" }
      );
      expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
    });

    let claude!: Awaited<ReturnType<typeof launchPreset>>;
    await test.step("Launch the Claude preset: the CLI gets its env and args, the mark its color", async () => {
      const before = readFakeAgentLaunchLog(claudeBin).length;
      claude = await launchPreset(ctx.window, "claude", CLAUDE_PRESET_ID);
      const [record] = await waitForLaunchesSince(claudeBin, before);
      expect(record.env.DAINTREE_E2E_AGENT_COLOR).toBe(CLAUDE_COLOR);
      expect(record.env.DAINTREE_E2E_PROVIDER).toBe("blue-provider");
      expect(record.argv).toContain(CLAUDE_ARG);
      await expectAgentIconColor(claude.panel, "claude", CLAUDE_COLOR);
    });

    await test.step("Quit Claude: the runtime demotes to none", async () => {
      // Confirm the fake CLI's trust prompt, then send its stop token.
      await waitForTerminalText(claude.panel, "Quick safety check", T_LONG);
      expect(await ptyWrite(ctx.window, claude.id, "\r")).toBe(true);
      await waitForTerminalText(claude.panel, FAKE_AGENT_READY, T_LONG);
      await runTerminalCommand(ctx.window, claude.panel, FAKE_AGENT_STOP);
      await expectRuntimeKind(claude.panel, "none");
    });

    await test.step("Restart the terminal and run Claude by hand: env and color reapply", async () => {
      const restart = await dispatchAction(
        ctx.window,
        "terminal.restart",
        { terminalId: claude.id },
        { source: "user", confirmed: true }
      );
      expect(restart.ok, restart.ok ? "" : JSON.stringify(restart.error)).toBe(true);
      await expect(claude.panel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_LONG });
      await expectRuntimeKind(claude.panel, "none");

      const before = readFakeAgentLaunchLog(claudeBin).length;
      await runTerminalCommand(ctx.window, claude.panel, manualClaudeCommand(), {
        readyTimeout: T_LONG,
      });
      const [record] = await waitForLaunchesSince(claudeBin, before);
      expect(record.argv).toContain("--manual");
      expect(record.env.DAINTREE_E2E_AGENT_COLOR).toBe(CLAUDE_COLOR);
      await expectAgentIconColor(claude.panel, "claude", CLAUDE_COLOR);
    });

    await test.step("Launch the Codex preset: its own color and provider, not Claude's", async () => {
      const before = readFakeAgentLaunchLog(codexBin).length;
      const codex = await launchPreset(ctx.window, "codex", CODEX_PRESET_ID);
      const [record] = await waitForLaunchesSince(codexBin, before);
      expect(record.env.DAINTREE_E2E_AGENT_COLOR).toBe(CODEX_COLOR);
      expect(record.env.DAINTREE_E2E_PROVIDER).toBe("green-provider");
      expect(record.argv).not.toContain(CLAUDE_ARG);
      await expectAgentIconColor(codex.panel, "codex", CODEX_COLOR);
      await waitForTerminalText(codex.panel, FAKE_AGENT_READY, T_LONG);
    });
  });

  test.describe.serial("panel behaviour", () => {
    let presetPanelId = "";

    function tabFor(page: Page, panelId: string): Locator {
      return page.locator(`${SEL.panel.tabList} [role="tab"][data-tab-id="${panelId}"]`);
    }

    test("107. Panel launched with a preset derives its agent mark from the preset color", async () => {
      const { id, panel } = await launchPreset(ctx.window, "claude", PANEL_PRESET_ID);
      presetPanelId = id;
      await expect(panel).toHaveAttribute("data-chrome-agent-id", "claude", { timeout: T_LONG });
      const icon = panel.locator('[data-terminal-icon-id="claude"]').first();
      await expect(icon).toHaveAttribute("data-terminal-icon-color", PANEL_COLOR, {
        timeout: T_LONG,
      });
    });

    // Duplicating a running agent panel produces no second panel in this
    // harness, so the inheritance checks can't run. Inheritance itself is
    // unit-covered by panelDuplicationService.test.ts.
    test.skip(
      "108. Duplicate panel inherits the preset color on its agent icon",
      {
        annotation: {
          type: "conditional-skip",
          description: "Agent-panel duplicate-to-tab is a no-op in the headless e2e harness",
        },
      },
      async () => {
        expect(presetPanelId).not.toBe("");
        const panel = getPanelById(ctx.window, presetPanelId);
        await panel.locator(SEL.panel.duplicate).first().click({ force: true, timeout: T_MEDIUM });
        const presetMarkedIcons = ctx.window.locator(
          `[data-terminal-icon-id="claude"][data-terminal-icon-color="${PANEL_COLOR}"]`
        );
        await expect
          .poll(() => presetMarkedIcons.count(), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(2);
      }
    );

    test.skip(
      "109. Duplicate creates a distinct panel with its own tab id",
      {
        annotation: {
          type: "conditional-skip",
          description: "Agent-panel duplicate-to-tab is a no-op in the headless e2e harness",
        },
      },
      async () => {
        const presetTabs = ctx.window
          .locator(SEL.panel.tabList)
          .locator('[role="tab"][data-tab-id]');
        await expect
          .poll(() => presetTabs.count(), { timeout: T_MEDIUM })
          .toBeGreaterThanOrEqual(2);
        const ids = await presetTabs.evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-tab-id"))
        );
        const distinct = new Set(ids.filter((id): id is string => Boolean(id)));
        expect(distinct.size).toBe(ids.length);
        expect(distinct.has(presetPanelId)).toBe(true);
      }
    );

    test("110. Panel moved to the dock surfaces as a dock chip for that panel", async () => {
      const result = await dispatchAction(
        ctx.window,
        "terminal.moveToDock",
        { terminalId: presetPanelId },
        { source: "user" }
      );
      expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
      await expect(tabFor(ctx.window, presetPanelId)).toHaveCount(0, { timeout: T_MEDIUM });

      const dock = ctx.window.locator(SEL.dock.container);
      await expect(dock).toBeVisible({ timeout: T_MEDIUM });
      await expect(dock.locator(SEL.dock.chipByTitle("Claude")).first()).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("111. Dock chip carries the preset title and color", async () => {
      const chip = ctx.window
        .locator(SEL.dock.container)
        .locator(SEL.dock.chipByTitle("Claude"))
        .first();
      await expect(chip).toBeVisible({ timeout: T_MEDIUM });
      // "Claude [<Preset>]", pinned through agent detection (#10738).
      await expect(chip).toContainText(PANEL_PRESET_NAME, { timeout: T_MEDIUM });
      const icon = chip.locator('[data-terminal-icon-id="claude"]').first();
      await expect(icon).toHaveAttribute("data-terminal-icon-color", PANEL_COLOR, {
        timeout: T_LONG,
      });
    });

    test("112. After app restart, the dock chip, preset color and saved presets are restored", async () => {
      // Panel autosave is debounced and app.close() can beat its flush, so wait
      // for main to hold the docked location before restarting.
      await expect
        .poll(
          () =>
            ctx.window.evaluate(async (terminalId) => {
              const project = await window.electron.project.getCurrent();
              if (!project) return null;
              const terminals = await window.electron.project.getTerminals(project.id);
              return terminals.find((terminal) => terminal.id === terminalId)?.location ?? null;
            }, presetPanelId),
          { timeout: T_LONG, intervals: [100, 250, 500] }
        )
        .toBe("dock");

      const userDataDir = ctx.userDataDir;
      await closeApp(ctx.app);
      removeSingletonFiles(userDataDir);
      ctx = await launchApp({ userDataDir, env: agents.env });
      ctx.window = await refreshActiveWindow(ctx.app);

      const chip = ctx.window
        .locator(SEL.dock.container)
        .locator(SEL.dock.chipByTitle("Claude"))
        .first();
      await expect(chip).toBeVisible({ timeout: T_LONG });
      await expect(chip).toContainText(PANEL_PRESET_NAME, { timeout: T_MEDIUM });
      const icon = chip.locator('[data-terminal-icon-id="claude"]').first();
      await expect(icon).toHaveAttribute("data-terminal-icon-color", PANEL_COLOR, {
        timeout: T_LONG,
      });

      // The saved preset definitions themselves came back, not just the panel's
      // metadata: a fresh launch of each still carries its env, args and color.
      const claudeBefore = readFakeAgentLaunchLog(agents.claudeBin).length;
      const claude = await launchPreset(ctx.window, "claude", CLAUDE_PRESET_ID);
      const [claudeRecord] = await waitForLaunchesSince(agents.claudeBin, claudeBefore);
      expect(claudeRecord.env.DAINTREE_E2E_PROVIDER).toBe("blue-provider");
      expect(claudeRecord.argv).toContain(CLAUDE_ARG);
      await expectAgentIconColor(claude.panel, "claude", CLAUDE_COLOR);

      const codexBin = agents.codexBin as string;
      const codexBefore = readFakeAgentLaunchLog(codexBin).length;
      const codex = await launchPreset(ctx.window, "codex", CODEX_PRESET_ID);
      const [codexRecord] = await waitForLaunchesSince(codexBin, codexBefore);
      expect(codexRecord.env.DAINTREE_E2E_PROVIDER).toBe("green-provider");
      await expectAgentIconColor(codex.panel, "codex", CODEX_COLOR);
    });
  });
});
