import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { readFakeAgentLaunchLog, type FakeAgentLaunchRecord } from "../../helpers/fakeAgent";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  navigateToAgentSettings,
  waitForCcrPresets,
  waitForCcrPresetsRemoved,
  getPresetOptionLabels,
  getPresetRowByName,
  getSelectedPresetLabel,
} from "../../helpers/presets";
import {
  installPresetAgents,
  closeSettings,
  readCustomPresets,
  setAgentSettings,
  waitForLaunchesSince,
  type FakeAgents,
} from "./presetHarness";

// Every place a preset can be launched from — the launcher's flat preset rows,
// the toolbar button's context menu, a plain toolbar click with a saved
// default, and the new-terminal palette — and what the launched CLI actually
// received. The fake `claude` records its argv and env on every launch.

const CUSTOM_ID = "user-e2e-surface-custom";
const CUSTOM_NAME = "Surface Custom";
const CUSTOM_ENV = "surface-custom";
const CUSTOM_ARG = "--e2e-surface-arg";

let ctx: AppContext;
let agents: FakeAgents;
let fixtureCleanup: (() => void) | undefined;

const launcher = () => ctx.window.getByRole("dialog", { name: "Launch" });
const search = () =>
  ctx.window.getByRole("combobox", { name: "Search agents, panels, and recipes" });
const claudeRow = () => launcher().locator('[role="option"][aria-label^="Claude,"]');
const claudeExpandable = () =>
  launcher().locator('[role="option"][data-row-kind="item"][aria-expanded][aria-label^="Claude,"]');
const presetRows = () => launcher().locator(SEL.preset.trayLaunchPresetItem);

async function closeLauncher(): Promise<void> {
  if (!(await launcher().isVisible())) return;
  // Two presses: the first spends itself clearing a non-empty query.
  await ctx.window.keyboard.press("Escape");
  if (await launcher().isVisible()) await ctx.window.keyboard.press("Escape");
  await expect(launcher()).toBeHidden({ timeout: T_MEDIUM });
}

/** Open the launcher narrowed to Claude, so its row is the only agent listed. */
async function openLauncher(): Promise<void> {
  await closeSettings(ctx.window);
  await closeLauncher();
  await ctx.window.locator(SEL.agent.trayButton).click();
  await expect(launcher()).toBeVisible({ timeout: T_MEDIUM });
  await expect(search()).toBeVisible({ timeout: T_MEDIUM });
  await search().fill("Claude");
  await expect(claudeRow().first()).toBeVisible({ timeout: T_MEDIUM });
}

async function openLauncherWithClaudePresets(): Promise<void> {
  await openLauncher();
  await expect(claudeExpandable()).toBeVisible({ timeout: T_MEDIUM });
  await search().press("ArrowRight");
  await expect(presetRows().first()).toBeVisible({ timeout: T_MEDIUM });
}

const claudeToolbarButton = () =>
  ctx.window
    .getByRole("toolbar", { name: "Main toolbar" })
    .locator('[data-toolbar-button-id="claude"]')
    .getByRole("button", { name: /^Start Claude/i })
    .first();

async function openContextPresetSubmenu() {
  await closeSettings(ctx.window);
  const button = claudeToolbarButton();
  await expect(button).toBeVisible({ timeout: T_LONG });
  await button.click({ button: "right" });
  const contextMenu = ctx.window.locator(SEL.contextMenu.content);
  await expect(contextMenu).toBeVisible({ timeout: T_MEDIUM });
  const trigger = contextMenu.getByText(/Launch with Preset/i);
  await expect(trigger).toBeVisible({ timeout: T_SHORT });
  await trigger.hover();
  const submenu = ctx.window.locator('[data-testid="context-submenu-content"]');
  await expect(submenu).toBeVisible({ timeout: T_MEDIUM });
  return submenu;
}

async function dismissContextMenu(): Promise<void> {
  await ctx.window.keyboard.press("Escape");
  if (await ctx.window.locator(SEL.contextMenu.content).isVisible()) {
    await ctx.window.keyboard.press("Escape");
  }
  await expect(ctx.window.locator(SEL.contextMenu.content)).toHaveCount(0, { timeout: T_MEDIUM });
}

/**
 * Clear the agent default and any worktree-scoped pick an earlier launch saved,
 * so the launch under test resolves only what the test chose.
 */
async function resetClaudeSelection(page: Page, presetId?: string): Promise<void> {
  await setAgentSettings(page, "claude", { presetId, worktreePresets: {} });
}

async function launchFrom(gesture: () => Promise<void>): Promise<FakeAgentLaunchRecord> {
  const before = readFakeAgentLaunchLog(agents.claudeBin).length;
  await gesture();
  const [record] = await waitForLaunchesSince(agents.claudeBin, before);
  return record;
}

async function openNewTerminalPalette(page: Page) {
  // Its only opener is this event — there is no production keyboard or toolbar
  // trigger (see useAppEventListeners).
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("daintree:open-new-terminal-palette"))
  );
  const dialog = page.locator(SEL.newTerminalPalette.dialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  return dialog;
}

test.describe("Presets: launch surfaces", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    const { dir, cleanup } = createFixtureRepo({ name: "preset-launch-surfaces" });
    agents = installPresetAgents(dir);
    fixtureCleanup = () => {
      cleanup();
      agents.dispose();
    };
    ctx = await launchApp({ env: agents.env });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Preset Surfaces Test");

    // A broken harness must fail here, not read as passing launch tests.
    await openLauncher();
    await closeLauncher();
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("101. Without presets: Claude appears as a plain launcher row (no disclosure)", async () => {
    removeCcrConfig();
    await navigateToAgentSettings(ctx.window, "claude");
    await setAgentSettings(ctx.window, "claude", { customPresets: [], presetId: undefined });
    await expect.poll(() => getPresetOptionLabels(ctx.window)).toEqual(["Default settings"]);

    await openLauncher();
    await expect(claudeRow().first()).toBeVisible({ timeout: T_MEDIUM });
    await expect(claudeExpandable()).toHaveCount(0);
    await closeLauncher();
  });

  test.describe("with CCR and custom presets", () => {
    test.beforeAll(async () => {
      writeCcrConfig([
        {
          id: "tray-a",
          name: "Tray Model A",
          model: "tray-model-a",
          baseUrl: "https://tray-a.local/v1",
        },
        { id: "tray-b", name: "Tray Model B", model: "tray-model-b" },
      ]);
      await waitForCcrPresets(ctx.window, ["Tray Model A", "Tray Model B"]);
      // Settings has rendered from the store by now, so this write can't be
      // overtaken by the store's boot hydration.
      await setAgentSettings(ctx.window, "claude", {
        pinned: true,
        presetId: undefined,
        worktreePresets: {},
        customPresets: [
          {
            id: CUSTOM_ID,
            name: CUSTOM_NAME,
            env: { DAINTREE_E2E_PRESET: CUSTOM_ENV },
            args: [CUSTOM_ARG],
          },
        ],
      });
      await expect.poll(() => getPresetOptionLabels(ctx.window)).toContain(CUSTOM_NAME);
      await closeSettings(ctx.window);
    });

    test.afterAll(async () => {
      removeCcrConfig();
      await waitForCcrPresetsRemoved(ctx.window, ["Tray Model A", "Tray Model B"]);
      await closeSettings(ctx.window);
    });

    test.afterEach(async () => {
      await closeLauncher();
      await closeSettings(ctx.window);
    });

    test.describe("launcher", () => {
      test("102. Claude's row advertises an expandable preset list", async () => {
        await openLauncher();
        await expect(claudeExpandable()).toBeVisible({ timeout: T_MEDIUM });
        await expect(claudeExpandable()).toHaveAttribute("aria-expanded", "false");
      });

      test("103. Right Arrow expands the preset list in place", async () => {
        await openLauncherWithClaudePresets();
        // "Default" leads the list; its position is a deliberate contract.
        await expect(presetRows().first()).toContainText(/default/i, { timeout: T_MEDIUM });
        await expect(claudeExpandable()).toHaveAttribute("aria-expanded", "true");
      });

      test("104. The expansion lists all available CCR presets", async () => {
        await openLauncherWithClaudePresets();
        await expect
          .poll(async () => (await presetRows().allTextContents()).map((t) => t.trim()))
          .toEqual(
            expect.arrayContaining([
              expect.stringContaining("Tray Model A"),
              expect.stringContaining("Tray Model B"),
            ])
          );
      });

      test("106. The expansion also shows custom presets alongside CCR presets", async () => {
        await openLauncherWithClaudePresets();
        const texts = await presetRows().allTextContents();
        // Default + 2 CCR + 1 custom.
        expect(texts.length).toBeGreaterThanOrEqual(4);
        expect(texts.some((t) => t.includes(CUSTOM_NAME))).toBe(true);
        expect(texts.some((t) => t.includes("Tray Model A"))).toBe(true);
      });

      test("105. Activating the agent row launches the default without expanding", async () => {
        await resetClaudeSelection(ctx.window);
        await openLauncher();
        await expect(claudeExpandable()).toBeVisible({ timeout: T_MEDIUM });

        const record = await launchFrom(async () => {
          await claudeRow().first().click();
          await expect(launcher()).toBeHidden({ timeout: T_MEDIUM });
        });
        await expect(presetRows()).toHaveCount(0);
        // No preset was chosen, so none of the presets' overrides may leak in.
        expect(record.env.DAINTREE_E2E_PRESET).toBeUndefined();
        expect(record.env.ANTHROPIC_MODEL).toBeUndefined();
        expect(record.argv).not.toContain(CUSTOM_ARG);
      });

      test("Activating a custom preset row launches with its env and args", async () => {
        await resetClaudeSelection(ctx.window);
        await openLauncherWithClaudePresets();
        const record = await launchFrom(async () => {
          await presetRows().filter({ hasText: CUSTOM_NAME }).click();
          await expect(launcher()).toBeHidden({ timeout: T_MEDIUM });
        });
        expect(record.env.DAINTREE_E2E_PRESET).toBe(CUSTOM_ENV);
        expect(record.argv).toContain(CUSTOM_ARG);
      });
    });

    test.describe("toolbar", () => {
      test("A plain toolbar click launches with the default chosen in Settings", async () => {
        await resetClaudeSelection(ctx.window);
        await navigateToAgentSettings(ctx.window, "claude");
        await getPresetRowByName(ctx.window, CUSTOM_NAME);
        await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe(CUSTOM_NAME);
        await closeSettings(ctx.window);

        const record = await launchFrom(async () => {
          await expect(claudeToolbarButton()).toBeVisible({ timeout: T_LONG });
          await claudeToolbarButton().click();
        });
        expect(record.env.DAINTREE_E2E_PRESET).toBe(CUSTOM_ENV);
        expect(record.argv).toContain(CUSTOM_ARG);
      });

      test("93/94. The context menu's 'Launch with Preset' lists every preset", async () => {
        const submenu = await openContextPresetSubmenu();
        const labels = (await submenu.locator('[role^="menuitem"]').allTextContents()).map((l) =>
          l.trim()
        );
        // "Agent default" + 2 CCR presets + the custom one.
        expect(labels.length).toBeGreaterThanOrEqual(4);
        expect(labels).toEqual(
          expect.arrayContaining([
            expect.stringContaining("Agent default"),
            expect.stringContaining("Tray Model A"),
            expect.stringContaining("Tray Model B"),
            expect.stringContaining(CUSTOM_NAME),
          ])
        );
        await dismissContextMenu();
      });

      test("95. A CCR preset from the context menu launches with its routing env", async () => {
        await resetClaudeSelection(ctx.window);
        const submenu = await openContextPresetSubmenu();
        const item = submenu.locator('[role^="menuitem"]').filter({ hasText: "Tray Model A" });
        await expect(item.first()).toBeVisible({ timeout: T_MEDIUM });

        const record = await launchFrom(() => item.first().click());
        expect(record.env.ANTHROPIC_MODEL).toBe("tray-model-a");
        expect(record.env.ANTHROPIC_BASE_URL).toBe("https://tray-a.local/v1");
        expect(record.env.DAINTREE_E2E_PRESET).toBeUndefined();

        const agentPanel = ctx.window.locator(
          '[aria-label^="Claude agent:"], [aria-label^="Claude Agent"]'
        );
        await expect(agentPanel.first()).toBeVisible({ timeout: T_LONG });
      });

      test("96. The saved default preset is checked in the context menu", async () => {
        await resetClaudeSelection(ctx.window, "ccr-tray-b");
        const submenu = await openContextPresetSubmenu();
        const checked = submenu.locator('[role^="menuitem"][aria-checked="true"]');
        await expect(checked).toHaveCount(1, { timeout: T_MEDIUM });
        await expect(checked.first()).toContainText("Tray Model B");
        await dismissContextMenu();
      });
    });

    test.describe("new-terminal palette", () => {
      test.afterEach(async () => {
        if (await ctx.window.locator(SEL.newTerminalPalette.dialog).isVisible()) {
          await ctx.window.keyboard.press("Escape");
        }
        await expect(ctx.window.locator(SEL.newTerminalPalette.dialog)).toBeHidden();
      });

      test("89. The palette lists the installed Claude agent option", async () => {
        const dialog = await openNewTerminalPalette(ctx.window);
        const claudeOption = dialog.locator("#new-terminal-option-claude");
        await expect(claudeOption).toBeVisible({ timeout: T_MEDIUM });
        await expect(claudeOption).toContainText(/Claude/i);
      });

      test("90. The palette always lists the plain terminal and browser options", async () => {
        const dialog = await openNewTerminalPalette(ctx.window);
        await expect(dialog.locator(SEL.newTerminalPalette.terminalOption)).toBeVisible({
          timeout: T_MEDIUM,
        });
        await expect(dialog.locator(SEL.newTerminalPalette.browserOption)).toBeVisible({
          timeout: T_SHORT,
        });
        // It offers agents, not preset counts.
        await expect(
          dialog.locator(SEL.newTerminalPalette.options).getByText(/preset/i)
        ).toHaveCount(0);
      });

      test("91/92. Launching Claude from the palette spawns a panel with presets present", async () => {
        expect((await readCustomPresets(ctx.window)).map((p) => p.id)).toContain(CUSTOM_ID);
        await resetClaudeSelection(ctx.window);
        const claudePanels = ctx.window.locator(
          `${SEL.panel.gridPanel}[data-launch-agent-id="claude"]`
        );
        const panelsBefore = await claudePanels.count();
        const dialog = await openNewTerminalPalette(ctx.window);
        const claudeOption = dialog.locator("#new-terminal-option-claude");
        await expect(claudeOption).toBeVisible({ timeout: T_MEDIUM });

        await launchFrom(async () => {
          await claudeOption.click();
          await expect(dialog).toBeHidden({ timeout: T_MEDIUM });
        });
        await expect.poll(() => claudePanels.count(), { timeout: T_LONG }).toBe(panelsBefore + 1);
      });
    });
  });
});
