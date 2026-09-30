import path from "path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  expectToolbarButtonReachable,
  openSettings,
  selectSettingsScope,
} from "../../helpers/panels";
import { selectGitHubSettingsProvider } from "../../helpers/githubHelpers";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  GLOBAL_SETTINGS_TAB_IDS,
  PROJECT_SETTINGS_TAB_IDS,
  type GlobalSettingsTab,
  type ProjectSettingsTab,
  type SettingsTab,
} from "../../../src/components/Settings/settingsTabIds";

// One launch for the Settings dialog: the welcome-screen shell first, then every
// global and project tab, their interactive controls, search, scope, and the
// project-switcher entry point once a project is open.

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

function settingsDialog(window: Page): Locator {
  return window.getByRole("dialog").filter({ has: window.locator(SEL.settings.navSidebar) });
}

/** The dialog title the dialog's aria-labelledby points at. */
async function settingsTitle(window: Page): Promise<Locator> {
  const titleId = await settingsDialog(window).getAttribute("aria-labelledby");
  expect(titleId, "settings dialog has no aria-labelledby").toBeTruthy();
  return window.locator(`[id="${titleId}"]`);
}

function navTab(window: Page, id: SettingsTab): Locator {
  return window.locator(`${SEL.settings.navSidebar} [id="settings-tab-${id}"]`);
}

function tabPanel(window: Page, id: SettingsTab): Locator {
  return window.locator(`[id="settings-panel-${id}"]`);
}

async function selectTab(window: Page, id: SettingsTab): Promise<Locator> {
  await navTab(window, id).click();
  await expect(navTab(window, id)).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
  const panel = tabPanel(window, id);
  await expect(panel).toBeVisible({ timeout: T_SHORT });
  return panel;
}

async function openSettingsTab(
  window: Page,
  id: SettingsTab,
  scope: "Global" | "Project" = id.startsWith("project:") ? "Project" : "Global"
): Promise<Locator> {
  await openSettings(window);
  await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  if (scope === "Project") await selectSettingsScope(window, "Project");
  return selectTab(window, id);
}

async function closeSettingsWithEscape(window: Page): Promise<void> {
  await window.keyboard.press("Escape");
  await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
}

/** Light local reset: no settings dialog (or anything layered on it) left open. */
async function ensureSettingsClosed(window: Page): Promise<void> {
  const heading = window.locator(SEL.settings.heading);
  for (let i = 0; i < 3 && (await heading.isVisible()); i++) {
    await window.keyboard.press("Escape");
    await expect(heading)
      .not.toBeVisible({ timeout: T_SHORT })
      .catch(() => undefined);
  }
  await expect(heading).not.toBeVisible({ timeout: T_SHORT });
}

/**
 * Every `role="tab"` must point at a panel that is actually in the document. Search
 * used to replace the tab panels outright, which left the whole sidebar pointing at
 * ids that no longer existed — invisible on screen, broken for assistive tech.
 */
async function danglingTabControls(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tab"][aria-controls]'))
      .map((tab) => tab.getAttribute("aria-controls") ?? "")
      .filter((id) => id && !document.getElementById(id))
  );
}

async function selectSubtab(window: Page, tablist: string, name: string): Promise<void> {
  const list = window.getByRole("tablist", { name: tablist });
  await list.getByRole("tab", { name }).click();
  await expect(list.getByRole("tab", { name, selected: true })).toBeVisible({ timeout: T_SHORT });
}

interface TabExpectation {
  /** Title text when it is more than the nav label (`headerTitle` in the registry). */
  title?: string;
  content?: (window: Page, panel: Locator) => Promise<void>;
}

// Keyed by the registry's own id tuples, so a tab added to Settings without an
// entry here fails to compile rather than silently going unchecked.
const GLOBAL_TABS: Record<GlobalSettingsTab, TabExpectation> = {
  general: {
    content: async (window) => {
      await expect(settingsDialog(window).locator("text=System Status")).toBeVisible({
        timeout: T_SHORT,
      });
      await selectSubtab(window, "General settings sections", "Hibernation");
      await expect(window.locator("#general-hibernation")).toBeVisible({ timeout: T_MEDIUM });
      await selectSubtab(window, "General settings sections", "Display");
      await expect(window.locator("#general-project-pulse")).toBeVisible({ timeout: T_SHORT });
    },
  },
  terminalAppearance: {
    content: async (window) => {
      await expect(settingsDialog(window).getByText("Accent color", { exact: true })).toBeVisible({
        timeout: T_SHORT,
      });
      await selectSubtab(window, "Appearance settings sections", "Terminal");
      await expect(window.locator(SEL.settings.fontSizeInput)).toBeVisible({ timeout: T_SHORT });
    },
  },
  keyboard: {
    title: "Keyboard shortcuts",
    content: async (window) => {
      await expect(window.locator(SEL.settings.shortcutsSearchInput)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.settings.shortcutResetAllButton).first()).toBeVisible({
        timeout: T_SHORT,
      });
      const rows = window.locator(SEL.settings.shortcutRow);
      await expect(rows.first()).toBeVisible({ timeout: T_SHORT });
      expect(await rows.count()).toBeGreaterThan(0);
    },
  },
  notifications: {
    content: async (window) => {
      await expect(window.locator(SEL.settings.notifCompletedCheckbox)).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(window.locator(SEL.settings.notifWaitingCheckbox)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.settings.notifSoundToggle)).toBeVisible({
        timeout: T_SHORT,
      });
    },
  },
  privacy: {
    content: async (window) => {
      await expect(window.locator("text=No data is collected").first()).toBeVisible({
        timeout: T_SHORT,
      });
      await selectSubtab(window, "Privacy and data sections", "Data & Storage");
      await expect(window.locator("button", { hasText: "Clear Cache" })).toBeVisible({
        timeout: T_SHORT,
      });
    },
  },
  "import-export": {
    content: async (_window, panel) => {
      await expect(panel.getByRole("button", { name: "Export…" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(panel.getByRole("button", { name: "Import…" })).toBeVisible();
    },
  },
  terminal: {
    content: async (window) => {
      await expect(window.locator(SEL.settings.performanceModeToggle)).toBeVisible({
        timeout: T_SHORT,
      });
      for (const subtab of ["Input", "Layout", "Scrollback", "Accessibility"]) {
        await selectSubtab(window, "Terminal settings sections", subtab);
      }
    },
  },
  worktree: {
    title: "Worktree paths",
    content: async (window) => {
      await expect(window.getByRole("heading", { name: "Path pattern" })).toBeVisible({
        timeout: T_MEDIUM,
      });
    },
  },
  toolbar: { title: "Toolbar customization" },
  environment: {
    title: "Environment variables",
    content: async (window) => {
      await expect(
        window.getByRole("heading", { name: /environment variables/i }).first()
      ).toBeVisible({ timeout: T_SHORT });
    },
  },
  assistant: {},
  agents: {
    content: async (window) => {
      await expect(window.locator(SEL.settings.agentDropdownTrigger)).toBeVisible({
        timeout: T_MEDIUM,
      });
    },
  },
  "code-forge": {
    content: async (window) => {
      await selectGitHubSettingsProvider(window);
      await expect(window.locator("#github-token")).toBeVisible({ timeout: T_MEDIUM });
    },
  },
  integrations: {
    content: async (window) => {
      await expect(window.locator("h4", { hasText: "External editor" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator("h4", { hasText: "Image viewer" })).toBeVisible({
        timeout: T_SHORT,
      });
    },
  },
  voice: {},
  portal: { title: "Portal links" },
  mcp: {
    content: async (window) => {
      const mcpToggle = window.locator(SEL.settings.mcpServerToggle);
      await expect(mcpToggle).toBeVisible({ timeout: T_SHORT });
      await expect(mcpToggle).not.toBeDisabled({ timeout: T_MEDIUM });
    },
  },
  plugins: {},
  "plugin-actions": { title: "Plugin actions" },
  "run-history": { title: "Run history" },
  troubleshooting: {
    content: async (window) => {
      const devModeToggle = window.locator(SEL.settings.developerModeToggle);
      await expect(devModeToggle).toBeVisible({ timeout: T_SHORT });
      await expect(devModeToggle).toHaveRole("switch");
      for (const label of ["Run Health Check", "Clear Logs", "Download Diagnostics"]) {
        await expect(window.locator("button", { hasText: label })).toBeVisible({
          timeout: T_SHORT,
        });
      }
    },
  },
};

const PROJECT_TABS: Record<ProjectSettingsTab, TabExpectation> = {
  "project:general": {
    content: async (_window, panel) => {
      await expect(panel.locator("#project-name-input")).toBeVisible({ timeout: T_SHORT });
    },
  },
  "project:context": {},
  "project:variables": {
    content: async (window) => {
      await expect(
        window.getByRole("heading", { name: /environment variables/i }).first()
      ).toBeVisible({ timeout: T_SHORT });
      await expect(window.getByRole("button", { name: "Add Variable" }).first()).toBeVisible({
        timeout: T_SHORT,
      });
    },
  },
  "project:automation": {
    // Runs before the resource-environment journey below adds any environment.
    content: async (_window, panel) => {
      await expect(panel.locator("h4", { hasText: "Resource environments" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(
        panel.getByText("Add an environment to run worktrees off this machine")
      ).toBeVisible({ timeout: T_SHORT });
      await expect(panel.getByText("Default worktree mode")).toHaveCount(0);
    },
  },
  "project:recipes": {},
  "project:commands": {},
  "project:notifications": {},
  "project:code-forge": {},
  "project:plugins": {},
};

async function expectTabRenders(
  window: Page,
  id: SettingsTab,
  expectation: TabExpectation
): Promise<void> {
  const tab = navTab(window, id);
  await expect(tab, `nav tab for ${id}`).toBeVisible({ timeout: T_SHORT });
  const label = (await tab.innerText()).trim();
  expect(label, `nav label for ${id}`).not.toBe("");

  const panel = await selectTab(window, id);
  const title = await settingsTitle(window);
  await expect(title).toContainText(expectation.title ?? label, { timeout: T_SHORT });
  // A blank or crashed panel would pass a click-through; require real content.
  await expect(
    panel.locator('h3, h4, button, input, textarea, [role="switch"], [role="radio"]').first(),
    `${id} panel renders no content`
  ).toBeVisible({ timeout: T_MEDIUM });
  await expect(settingsDialog(window).locator(SEL.errorBoundary.fallback)).toHaveCount(0);
  await expectation.content?.(window, panel);
}

async function renderedNavTabIds(window: Page): Promise<string[]> {
  return window
    .locator(`${SEL.settings.navSidebar} [role="tab"][data-tab]`)
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab") ?? ""));
}

async function openShortcutRecorder(
  window: Page,
  search: string,
  rowText: string
): Promise<{ row: Locator; recordPrompt: Locator; searchInput: Locator }> {
  const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
  await searchInput.fill(search);
  await expect(searchInput).toHaveValue(search, { timeout: T_SHORT });

  const row = window.locator(SEL.settings.shortcutRow).filter({ hasText: rowText }).first();
  await expect(row).toBeVisible({ timeout: T_MEDIUM });
  await row.scrollIntoViewIfNeeded();
  await row.hover();

  const editBtn = row.getByRole("button", { name: "Edit" });
  await expect(editBtn).toBeVisible({ timeout: T_MEDIUM });
  await editBtn.click();

  // Edit starts recording straight away; the field is the recorder.
  const recordPrompt = row.locator(SEL.settings.shortcutRecordPrompt);
  await expect(recordPrompt).toBeVisible({ timeout: T_MEDIUM });
  return { row, recordPrompt, searchInput };
}

function recorderSaveButton(window: Page): Locator {
  return window.locator(SEL.settings.shortcutCancelButton).locator("..").locator("button", {
    hasText: "Save",
  });
}

async function addEnvironment(panel: Locator, name: string): Promise<void> {
  await panel.getByRole("button", { name: "Add environment" }).click();
  const nameInput = panel.locator("#new-environment-name");
  await expect(nameInput).toBeVisible({ timeout: T_SHORT });
  await nameInput.fill(name);
  await panel
    .locator('[data-testid="add-environment-form"]')
    .locator("button", { hasText: "Add" })
    .click();
  await expect(nameInput).toHaveCount(0, { timeout: T_SHORT });
}

test.describe("Core: Settings", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({ name: "settings-dialog" }));
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.describe.serial("Before a project opens", () => {
    test("app shell: title, version, toolbar and welcome screen", async () => {
      const { window } = ctx;
      expect(await window.title()).toContain("Daintree");
      const version = await ctx.app.evaluate(({ app }) => app.getVersion());
      expect(version).toMatch(/^\d+\.\d+\.\d+/);

      await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible({ timeout: T_MEDIUM });
      await expectToolbarButtonReachable(window, SEL.toolbar.openSettings, T_SHORT);
      await expect(window.getByRole("button", { name: "Open project", exact: true })).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("settings opens on General without a project and closes via Escape", async () => {
      const { window } = ctx;
      const heading = window.locator("h2", { hasText: "Settings" });
      await openSettings(window);
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });
      await expect(navTab(window, "general")).toHaveAttribute("aria-selected", "true");
      await expect(await settingsTitle(window)).toContainText("General");

      await window.keyboard.press("Escape");
      await expect(heading).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  test.describe("With a project open", () => {
    test.beforeAll(async () => {
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Settings Dialog");
    });

    test.beforeEach(async () => {
      await ensureSettingsClosed(ctx.window);
    });

    test("every global settings tab renders its title and content", async () => {
      const { window } = ctx;
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
      await expect(navTab(window, "general")).toHaveAttribute("aria-selected", "true");

      expect([...(await renderedNavTabIds(window))].sort()).toEqual(
        [...GLOBAL_SETTINGS_TAB_IDS].sort()
      );
      for (const id of GLOBAL_SETTINGS_TAB_IDS) {
        await test.step(id, () => expectTabRenders(window, id, GLOBAL_TABS[id]));
      }
      await closeSettingsWithEscape(window);
    });

    test("every project settings tab renders its title and content", async () => {
      const { window } = ctx;
      await openSettings(window);
      await selectSettingsScope(window, "Project");

      expect([...(await renderedNavTabIds(window))].sort()).toEqual(
        [...PROJECT_SETTINGS_TAB_IDS].sort()
      );
      for (const id of PROJECT_SETTINGS_TAB_IDS) {
        await test.step(id, () => expectTabRenders(window, id, PROJECT_TABS[id]));
      }
      await closeSettingsWithEscape(window);
    });

    test("ThemeBrowser: selecting a theme applies its CSS tokens live", async () => {
      const { window } = ctx;
      const html = window.locator("html");
      await openSettingsTab(window, "terminalAppearance");
      await selectSubtab(window, "Appearance settings sections", "App");

      await window.locator(SEL.settings.changeThemeButton).click();
      const themeBrowser = window.locator(SEL.settings.themeBrowserDialog);
      await expect(themeBrowser).toBeVisible({ timeout: T_SHORT });
      const themeListbox = themeBrowser.locator(SEL.settings.themeListbox);
      await expect(themeListbox).toBeVisible({ timeout: T_SHORT });

      // Capture the active theme and accent token so the change is proven, not
      // merely present.
      const initialTheme = await html.getAttribute("data-theme");
      const initialAccentToken = await html.evaluate((el) =>
        (el as HTMLElement).style.getPropertyValue("--theme-accent-primary").trim()
      );

      const options = themeListbox.locator('[role="option"]');
      const optionCount = await options.count();
      expect(optionCount).toBeGreaterThanOrEqual(2);
      let targetOption = options.first();
      for (let i = 0; i < optionCount; i++) {
        const option = options.nth(i);
        if ((await option.getAttribute("aria-selected")) !== "true") {
          targetOption = option;
          break;
        }
      }

      await targetOption.click();
      await expect(targetOption).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });

      // Token writes are RAF-coalesced; poll.
      await expect
        .poll(async () => html.getAttribute("data-theme"), { timeout: T_MEDIUM })
        .not.toBe(initialTheme);
      await expect
        .poll(
          async () =>
            html.evaluate((el) =>
              (el as HTMLElement).style.getPropertyValue("--theme-accent-primary").trim()
            ),
          { timeout: T_MEDIUM }
        )
        .not.toBe(initialAccentToken);
      const accentToken = await html.evaluate((el) =>
        (el as HTMLElement).style.getPropertyValue("--theme-accent-primary").trim()
      );
      expect(accentToken).not.toBe("");

      await window.locator('[aria-label="Close theme browser"]').click();
      await expect(themeBrowser).not.toBeVisible({ timeout: T_SHORT });
      await closeSettingsWithEscape(window);
    });

    test("AppThemePicker: accent override shows low-contrast warning, reset clears it", async () => {
      const { window } = ctx;
      const html = window.locator("html");
      await openSettingsTab(window, "terminalAppearance");
      await selectSubtab(window, "Appearance settings sections", "App");

      const accentInput = window.locator(SEL.settings.accentColorInput);
      await expect(accentInput).toBeAttached({ timeout: T_SHORT });

      // Accent ≈ surface ⇒ ~1:1 contrast ⇒ a guaranteed WCAG AA failure.
      const surface = await html.evaluate((el) =>
        (el as HTMLElement).style.getPropertyValue("--theme-surface-canvas").trim()
      );
      expect(surface).not.toBe("");
      const lowContrastHex = /^#[0-9a-f]{3,6}$/i.test(surface) ? surface : "#808080";

      // The colour input can't be driven by fill(); set value + dispatch input/change.
      await accentInput.evaluate((el, color) => {
        const input = el as HTMLInputElement;
        input.value = color;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, lowContrastHex);

      await expect(window.locator(SEL.settings.accentContrastWarning)).toBeVisible({
        timeout: T_SHORT,
      });
      await window.locator(SEL.settings.accentColorReset).click();
      await expect(window.locator(SEL.settings.accentContrastWarning)).not.toBeVisible({
        timeout: T_SHORT,
      });
      await closeSettingsWithEscape(window);
    });

    test("AppThemePicker: random theme changes the applied scheme", async () => {
      const { window } = ctx;
      const html = window.locator("html");
      await openSettingsTab(window, "terminalAppearance");
      await selectSubtab(window, "Appearance settings sections", "App");

      const initialTheme = await html.getAttribute("data-theme");
      const randomButton = window.locator(SEL.settings.randomThemeButton);
      await expect(randomButton).toBeEnabled({ timeout: T_SHORT });
      await randomButton.click();
      await expect
        .poll(async () => html.getAttribute("data-theme"), { timeout: T_MEDIUM })
        .not.toBe(initialTheme);
      await closeSettingsWithEscape(window);
    });

    test("Appearance: terminal font size commits a new value", async () => {
      const { window } = ctx;
      await openSettingsTab(window, "terminalAppearance");
      await selectSubtab(window, "Appearance settings sections", "Terminal");

      const fontSizeInput = window.locator(SEL.settings.fontSizeInput);
      await expect(fontSizeInput).toBeVisible({ timeout: T_SHORT });
      const newValue = (await fontSizeInput.inputValue()) === "16" ? "18" : "16";
      await fontSizeInput.fill(newValue);
      await fontSizeInput.blur();
      // The input shows its draft immediately, so read the committed value back
      // from main: only a real save (debounced on blur) changes it.
      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              const config = await globalThis.window.electron.terminalConfig.get();
              return config?.fontSize;
            }),
          { timeout: T_MEDIUM }
        )
        .toBe(Number(newValue));
      await closeSettingsWithEscape(window);
    });

    test("CLI agents: selector lists General plus agents and switches the active one", async () => {
      const { window } = ctx;
      const panel = await openSettingsTab(window, "agents");

      const trigger = panel.locator(SEL.settings.agentDropdownTrigger);
      await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
      await expect(trigger).toContainText("General", { timeout: T_SHORT });

      await trigger.click();
      const listbox = window.locator(SEL.settings.agentDropdownList);
      await expect(listbox).toBeVisible({ timeout: T_SHORT });
      const options = listbox.locator('[role="option"]');
      await expect(options.first()).toContainText("General");
      expect(await options.count()).toBeGreaterThanOrEqual(2);

      const agentOption = options.nth(1);
      const agentName = ((await agentOption.textContent()) ?? "").trim();
      expect(agentName).not.toBe("");
      await agentOption.click();
      await expect(listbox).not.toBeVisible({ timeout: T_SHORT });
      await expect(trigger).toContainText(agentName, { timeout: T_SHORT });

      await trigger.click();
      await expect(listbox).toBeVisible({ timeout: T_SHORT });
      await options.first().click();
      await expect(listbox).not.toBeVisible({ timeout: T_SHORT });
      await expect(
        window.locator("#agents-general").getByRole("heading", { name: "All agents" })
      ).toBeVisible({ timeout: T_SHORT });
      await closeSettingsWithEscape(window);
    });

    test("Privacy: telemetry choices are described and selectable", async () => {
      const { window } = ctx;
      await openSettingsTab(window, "privacy");
      await selectSubtab(window, "Privacy and data sections", "Telemetry");

      const offRadio = window.getByRole("radio", { name: "Off" });
      const errorsRadio = window.getByRole("radio", { name: "Errors only" });
      const fullRadio = window.getByRole("radio", { name: "Full usage" });
      await expect(offRadio).toBeVisible({ timeout: T_SHORT });
      await expect(errorsRadio).toBeVisible({ timeout: T_SHORT });
      await expect(fullRadio).toBeVisible({ timeout: T_SHORT });

      const details = window.getByRole("group", { name: "What's collected at each level" });
      await expect(details.getByText("No data is collected or transmitted.")).toBeVisible();
      await expect(
        details.getByText("Crash reports and error details are sent to Sentry", { exact: false })
      ).toBeVisible();
      await expect(
        details.getByText("anonymous usage analytics events", { exact: false })
      ).toBeVisible();

      await errorsRadio.check();
      await expect(errorsRadio).toBeChecked({ timeout: T_SHORT });
      await expect(offRadio).not.toBeChecked({ timeout: T_SHORT });
      await closeSettingsWithEscape(window);
    });

    test.describe("Search and scope", () => {
      test("search shows cross-tab results and the clear button restores navigation", async () => {
        const { window } = ctx;
        await openSettings(window);
        const searchInput = window.locator(SEL.settings.searchInput);
        await expect(searchInput).toBeVisible({ timeout: T_SHORT });

        await searchInput.fill("font size");
        await expect(window.locator("h3", { hasText: "Search results" })).toBeVisible({
          timeout: T_SHORT,
        });
        const resultsRegion = window.locator(SEL.settings.searchResultsRegion);
        await expect(resultsRegion).toBeVisible({ timeout: T_SHORT });
        const resultButtons = resultsRegion.locator("button");
        await expect(resultButtons.first()).toBeVisible({ timeout: T_SHORT });
        await expect(resultButtons.first()).toContainText("Appearance");

        await window.locator(SEL.settings.searchClear).click();
        await expect(searchInput).toHaveValue("");
        await expect(window.locator("h3", { hasText: "Search results" })).not.toBeVisible({
          timeout: T_SHORT,
        });
        await expect(
          window.locator(SEL.settings.navSidebar).locator("button", { hasText: "General" })
        ).toBeVisible({ timeout: T_SHORT });
        await closeSettingsWithEscape(window);
      });

      test("search results navigate to the right tab via keyboard and click", async () => {
        const { window } = ctx;
        await openSettings(window);
        const searchInput = window.locator(SEL.settings.searchInput);

        await searchInput.fill("font size");
        await expect(window.locator("h3", { hasText: "Search results" })).toBeVisible({
          timeout: T_SHORT,
        });
        await expect(window.locator(SEL.settings.searchResultsRegion)).toBeVisible({
          timeout: T_SHORT,
        });
        await searchInput.press("ArrowDown");
        await searchInput.press("Enter");
        await expect(window.locator("h3", { hasText: "Appearance" })).toBeVisible({
          timeout: T_SHORT,
        });
        await expect(searchInput).toHaveValue("");

        await searchInput.fill("font size");
        const firstResult = window
          .locator(SEL.settings.searchResultsRegion)
          .locator("button")
          .first();
        await expect(firstResult).toBeVisible({ timeout: T_SHORT });
        await firstResult.click();
        await expect(window.locator("h3", { hasText: "Search results" })).not.toBeVisible({
          timeout: T_SHORT,
        });
        await expect(window.locator("h3", { hasText: "Appearance" })).toBeVisible({
          timeout: T_SHORT,
        });
        await expect(searchInput).toHaveValue("");
        await closeSettingsWithEscape(window);
      });

      test("every settings tab points at a panel that exists, in and out of search", async () => {
        const { window } = ctx;
        await openSettings(window);
        expect(await danglingTabControls(window), "dangling aria-controls at rest").toEqual([]);

        const searchInput = window.locator(SEL.settings.searchInput);
        await searchInput.fill("font size");
        await expect(window.locator(SEL.settings.searchResultsRegion)).toBeVisible({
          timeout: T_SHORT,
        });
        expect(await danglingTabControls(window), "dangling aria-controls while searching").toEqual(
          []
        );

        // Project scope mounts its panels on a different branch.
        await searchInput.fill("");
        await selectSettingsScope(window, "Project");
        expect(
          await danglingTabControls(window),
          "dangling aria-controls in project scope"
        ).toEqual([]);
        await searchInput.fill("worktree");
        await expect(window.locator(SEL.settings.searchResultsRegion)).toBeVisible({
          timeout: T_SHORT,
        });
        expect(
          await danglingTabControls(window),
          "dangling aria-controls searching project scope"
        ).toEqual([]);

        await searchInput.fill("");
        await selectSettingsScope(window, "Global");
        await closeSettingsWithEscape(window);
      });

      test("scope toggle filters nav tabs and remembers the per-scope tab", async () => {
        const { window } = ctx;
        await openSettings(window);
        const nav = window.locator(SEL.settings.navSidebar);

        await expect(nav.locator("button", { hasText: "Appearance" })).toBeVisible({
          timeout: T_SHORT,
        });
        await expect(nav.locator("button", { hasText: "Variables" })).toHaveCount(0);

        await selectSettingsScope(window, "Project");
        await expect(nav.locator("button", { hasText: "Variables" })).toBeVisible({
          timeout: T_SHORT,
        });
        await expect(nav.locator("button", { hasText: "Appearance" })).toHaveCount(0);

        await nav.locator("button", { hasText: "Variables" }).click();
        const variablesHeading = window
          .getByRole("heading", { name: /environment variables/i })
          .first();
        await expect(variablesHeading).toBeVisible({ timeout: T_SHORT });

        // Flip to Global and back — project scope restores its remembered tab.
        await selectSettingsScope(window, "Global");
        await expect(nav.locator("button", { hasText: "Appearance" })).toBeVisible({
          timeout: T_SHORT,
        });
        await selectSettingsScope(window, "Project");
        await expect(variablesHeading).toBeVisible({ timeout: T_SHORT });

        await selectSettingsScope(window, "Global");
        await closeSettingsWithEscape(window);
      });
    });

    test.describe("Keyboard shortcuts tab", () => {
      test("search filters shortcut rows", async () => {
        const { window } = ctx;
        await openSettingsTab(window, "keyboard");
        const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
        const rows = window.locator(SEL.settings.shortcutRow);
        await expect(rows.first()).toBeVisible({ timeout: T_SHORT });
        const unfilteredCount = await rows.count();

        await searchInput.fill("Open settings");
        await expect.poll(() => rows.count(), { timeout: T_SHORT }).toBeLessThan(unfilteredCount);
        const filteredCount = await rows.count();
        expect(filteredCount).toBeGreaterThan(0);
        expect((await rows.first().textContent())?.toLowerCase()).toContain("open settings");

        await searchInput.fill("");
        await expect.poll(() => rows.count(), { timeout: T_SHORT }).toBeGreaterThan(filteredCount);
        await closeSettingsWithEscape(window);
      });

      test("click Edit enters edit mode, Cancel exits it", async () => {
        const { window } = ctx;
        await openSettingsTab(window, "keyboard");
        const { recordPrompt } = await openShortcutRecorder(
          window,
          "Open settings",
          "Open settings"
        );
        await window.locator(SEL.settings.shortcutCancelButton).click();
        await expect(recordPrompt).not.toBeVisible({ timeout: T_SHORT });
        await closeSettingsWithEscape(window);
      });

      test("per-shortcut reset button restores default binding", async () => {
        const { window } = ctx;
        await openSettingsTab(window, "keyboard");
        const { row, recordPrompt } = await openShortcutRecorder(
          window,
          "Open settings",
          "Open settings"
        );
        await recordPrompt.click();
        await window.keyboard.press("Control+Shift+KeyZ");

        // Save enables once the chord window closes and the combo is captured.
        const saveBtn = recorderSaveButton(window);
        await expect(saveBtn).toBeEnabled({ timeout: T_MEDIUM });
        await saveBtn.click();
        await expect(recordPrompt).not.toBeVisible({ timeout: T_SHORT });

        await row.scrollIntoViewIfNeeded();
        await row.hover();
        const resetBtn = row.locator(SEL.settings.shortcutResetButton);
        await expect(resetBtn).toBeVisible({ timeout: T_MEDIUM });
        await resetBtn.click();
        await row.hover();
        await expect(resetBtn).not.toBeVisible({ timeout: T_SHORT });
        await closeSettingsWithEscape(window);
      });

      test("recording a combo bound elsewhere shows a conflict warning", async () => {
        const { window } = ctx;
        await openSettingsTab(window, "keyboard");

        // Cmd/Ctrl+T is "Duplicate focused panel"; conflict detection (which
        // excludes the action being edited) must flag it.
        const { recordPrompt } = await openShortcutRecorder(
          window,
          "Reopen last closed terminal",
          "Reopen last closed terminal"
        );
        await recordPrompt.click();
        // The recorder reads event.code; Cmd maps to Meta on macOS, Ctrl elsewhere.
        await window.keyboard.press(process.platform === "darwin" ? "Meta+KeyT" : "Control+KeyT");

        const conflict = window.locator(SEL.settings.shortcutConflictWarning);
        await expect(conflict).toBeVisible({ timeout: T_MEDIUM });
        await expect(conflict.getByText("Duplicate focused panel", { exact: true })).toBeVisible({
          timeout: T_SHORT,
        });

        // Cancel without saving — leaves all bindings untouched.
        await window.locator(SEL.settings.shortcutCancelButton).click();
        await expect(recordPrompt).not.toBeVisible({ timeout: T_SHORT });
        await closeSettingsWithEscape(window);
      });
    });

    test("Notifications: completed toggle persists across a dialog reopen", async () => {
      const { window } = ctx;
      await openSettingsTab(window, "notifications");
      const checkbox = window.locator(SEL.settings.notifCompletedCheckbox);
      await expect(checkbox).not.toBeChecked({ timeout: T_MEDIUM });

      await checkbox.click();
      await expect(checkbox).toBeChecked({ timeout: T_SHORT });
      await closeSettingsWithEscape(window);

      await openSettingsTab(window, "notifications");
      await expect(checkbox).toBeChecked({ timeout: T_MEDIUM });

      await checkbox.click();
      await expect(checkbox).not.toBeChecked({ timeout: T_SHORT });
      await closeSettingsWithEscape(window);

      await openSettingsTab(window, "notifications");
      await expect(checkbox).not.toBeChecked({ timeout: T_MEDIUM });
      await closeSettingsWithEscape(window);
    });

    test("MCP server: enabling reveals the connection details, then disable", async () => {
      const { window } = ctx;
      const panel = await openSettingsTab(window, "mcp");

      const toggle = window.locator(SEL.settings.mcpServerToggle);
      const connectionMarker = window.locator(SEL.settings.mcpConnectionMarker);
      await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
      // The server starts off on a fresh profile; no external clients exist, so
      // disabling never asks to stop sharing.
      await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });
      await expect(connectionMarker).not.toBeVisible({ timeout: T_SHORT });

      await toggle.click();
      await expect(connectionMarker).toBeVisible({ timeout: T_MEDIUM });
      await expect(panel.getByText(/Server is starting|Running on port/)).toBeVisible({
        timeout: T_LONG,
      });

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });
      await expect(connectionMarker).not.toBeVisible({ timeout: T_MEDIUM });
      await closeSettingsWithEscape(window);
    });

    test("Pulse, performance mode and font family survive a dialog reopen", async () => {
      const { window } = ctx;
      const pulseToggle = window.locator(SEL.settings.projectPulseToggle);
      const perfToggle = window.locator(SEL.settings.performanceModeToggle);
      const fontGroup = window.locator(SEL.settings.fontFamilySelect);
      const checkedFont = fontGroup.locator('[role="radio"][aria-checked="true"]');

      await openSettingsTab(window, "general");
      await selectSubtab(window, "General settings sections", "Display");
      await expect(pulseToggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });
      await pulseToggle.click();
      await expect(pulseToggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });

      await selectTab(window, "terminal");
      await selectSubtab(window, "Terminal settings sections", "Performance");
      await perfToggle.scrollIntoViewIfNeeded();
      await expect(perfToggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });
      await perfToggle.click();
      await expect(perfToggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });

      await selectTab(window, "terminalAppearance");
      await selectSubtab(window, "Appearance settings sections", "Terminal");
      await expect(fontGroup).toBeVisible({ timeout: T_MEDIUM });
      await expect(checkedFont).toContainText("JetBrains Mono", { timeout: T_MEDIUM });
      await fontGroup.locator('[role="radio"]', { hasText: "System monospace" }).click();
      await expect(checkedFont).toContainText("System monospace", { timeout: T_MEDIUM });

      await closeSettingsWithEscape(window);

      await openSettingsTab(window, "general");
      await selectSubtab(window, "General settings sections", "Display");
      await expect(pulseToggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });
      await selectTab(window, "terminal");
      await selectSubtab(window, "Terminal settings sections", "Performance");
      await perfToggle.scrollIntoViewIfNeeded();
      await expect(perfToggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });
      await selectTab(window, "terminalAppearance");
      await selectSubtab(window, "Appearance settings sections", "Terminal");
      await expect(checkedFont).toContainText("System monospace", { timeout: T_MEDIUM });
      await closeSettingsWithEscape(window);
    });

    test("project switcher opens project settings in project scope", async () => {
      const { window } = ctx;
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });
      const settingsBtn = palette.getByRole("button", { name: /Project settings/ });
      await expect(settingsBtn).toBeVisible({ timeout: T_SHORT });
      await settingsBtn.click();

      await expect(window.locator('h2:has-text("Settings")')).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.settings.scopeControl)).toHaveText("Project settings", {
        timeout: T_SHORT,
      });

      const panel = await selectTab(window, "project:general");
      const nameInput = panel.locator("#project-name-input");
      await expect(nameInput).toBeVisible({ timeout: T_SHORT });
      expect(await nameInput.inputValue()).toContain(path.basename(fixtureDir));
      await expect(window.locator('[aria-label="Dev server command"]')).toBeVisible({
        timeout: T_SHORT,
      });

      await window.locator(SEL.settings.closeButton).click();
      await expect(window.locator('h2:has-text("Settings")')).not.toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("project variables: add, remove and duplicate-key validation", async () => {
      const { window } = ctx;
      const panel = await openSettingsTab(window, "project:variables");

      const emptyState = window.getByText("No project variables yet", { exact: false });
      await expect(emptyState).toBeVisible({ timeout: T_SHORT });

      await window.getByRole("button", { name: "Add variable" }).click();
      const keyInputs = window.locator('input[placeholder="VARIABLE_NAME"]');
      await expect(keyInputs.first()).toBeVisible({ timeout: T_SHORT });
      await keyInputs.first().fill("TEST_API_KEY");
      await window.locator('input[placeholder="value"]').first().fill("my-secret-value");
      await expect(emptyState).not.toBeVisible({ timeout: T_SHORT });

      await window.getByRole("button", { name: "Delete TEST_API_KEY (row 1)" }).click();
      await expect(emptyState).toBeVisible({ timeout: T_SHORT });

      // Two rows with the same key: Save runs validate(), which flags the duplicate.
      await window.getByRole("button", { name: "Add variable" }).click();
      await window.getByRole("button", { name: "Add variable" }).click();
      await keyInputs.nth(0).fill("DUPLICATE_KEY");
      await keyInputs.nth(1).fill("DUPLICATE_KEY");
      const saveButton = panel.getByRole("button", { name: "Save", exact: true });
      await expect(saveButton).toBeVisible({ timeout: T_SHORT });
      await saveButton.click();
      await expect(keyInputs.nth(1)).toHaveAttribute("aria-invalid", "true");
      await expect(window.getByText("Another variable already uses this name")).toBeVisible({
        timeout: T_SHORT,
      });

      const deleteButtons = window.getByRole("button", {
        name: /^Delete DUPLICATE_KEY \(row \d+\)$/,
      });
      await expect(deleteButtons).toHaveCount(2);
      await deleteButtons.last().click();
      await expect(deleteButtons).toHaveCount(1, { timeout: T_SHORT });
      await deleteButtons.last().click();
      await expect(emptyState).toBeVisible({ timeout: T_SHORT });
      await closeSettingsWithEscape(window);
    });

    // One journey: each step builds on the environments the previous one left.
    test.describe.serial("Project resource environments", () => {
      const automationPanel = () => tabPanel(ctx.window, "project:automation");

      test("add and remove resource environments", async () => {
        const { window } = ctx;
        const panel = await openSettingsTab(window, "project:automation");
        await expect(panel.locator("h4", { hasText: "Resource environments" })).toBeVisible({
          timeout: T_SHORT,
        });

        await addEnvironment(panel, "staging");
        const selectorBar = panel.locator('[data-testid="environment-selector-bar"]');
        await expect(selectorBar).toBeVisible({ timeout: T_SHORT });
        const environmentSelect = selectorBar.getByRole("combobox");
        await expect(environmentSelect).toContainText("staging", { timeout: T_SHORT });

        await addEnvironment(panel, "production");
        await expect(environmentSelect).toContainText("production", { timeout: T_SHORT });

        await environmentSelect.click();
        await window.getByRole("option", { name: "staging" }).click();
        await expect(environmentSelect).toContainText("staging", { timeout: T_SHORT });

        await panel.getByRole("button", { name: "Delete staging environment" }).click();
        await expect(window.getByRole("alertdialog", { name: "Remove 'staging'?" })).toBeVisible({
          timeout: T_SHORT,
        });
        await window.getByRole("button", { name: "Remove environment" }).click();

        await expect(environmentSelect).toContainText("production", { timeout: T_SHORT });
        await environmentSelect.click();
        await expect(window.getByRole("option", { name: "staging" })).not.toBeVisible();
        await expect(window.getByRole("option", { name: "production" })).toBeVisible();
        await window.keyboard.press("Escape");
        await expect(environmentSelect).toHaveAttribute("aria-expanded", "false");

        await window.locator(SEL.settings.closeButton).click();
        await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
      });

      test("environment persists after settings close/reopen", async () => {
        const { window } = ctx;
        await openSettingsTab(window, "project:automation");
        const selectorBar = automationPanel().locator('[data-testid="environment-selector-bar"]');
        await expect(selectorBar).toBeVisible({ timeout: T_MEDIUM });
        await expect(selectorBar.getByRole("combobox")).toContainText("production", {
          timeout: T_MEDIUM,
        });
        await closeSettingsWithEscape(window);
      });

      test("toggle default worktree mode", async () => {
        const { window } = ctx;
        const panel = await openSettingsTab(window, "project:automation");
        await expect(panel.locator('[data-testid="environment-selector-bar"]')).toBeVisible({
          timeout: T_MEDIUM,
        });
        await expect(panel.locator("text=Default worktree mode")).toBeVisible({
          timeout: T_SHORT,
        });

        // Scoped to the worktreeMode group — the panel also has a branchPrefixMode group.
        const worktreeModeRadios = panel.locator('input[type="radio"][name="worktreeMode"]');
        const localRadio = panel.locator('input[type="radio"][name="worktreeMode"][value="local"]');
        await expect(localRadio).toBeVisible({ timeout: T_SHORT });
        await expect(localRadio).toBeChecked({ timeout: T_SHORT });
        expect(await worktreeModeRadios.count()).toBeGreaterThanOrEqual(2);

        const envRadio = worktreeModeRadios.nth(1);
        await envRadio.click();
        await expect(envRadio).toBeChecked({ timeout: T_SHORT });
        await expect(localRadio).not.toBeChecked({ timeout: T_SHORT });

        await localRadio.click();
        await expect(localRadio).toBeChecked({ timeout: T_SHORT });
        await closeSettingsWithEscape(window);
      });

      test("shows an error for a duplicate environment name", async () => {
        const { window } = ctx;
        const panel = await openSettingsTab(window, "project:automation");
        const selectorBar = panel.locator('[data-testid="environment-selector-bar"]');
        await expect(selectorBar).toBeVisible({ timeout: T_MEDIUM });

        const existingName = ((await selectorBar.getByRole("combobox").textContent()) ?? "").trim();
        expect(existingName).toBe("production");

        await panel.getByRole("button", { name: "Add environment" }).click();
        const nameInput = panel.locator("#new-environment-name");
        await expect(nameInput).toBeVisible({ timeout: T_SHORT });
        await nameInput.fill(existingName);
        const form = panel.locator('[data-testid="add-environment-form"]');
        await form.locator("button", { hasText: "Add" }).click();
        await expect(panel.locator("text=already exists")).toBeVisible({ timeout: T_SHORT });

        await form.locator("button", { hasText: "Cancel" }).click();
        await closeSettingsWithEscape(window);
      });
    });

    // Last in the file: it swaps the main-process sound handler for a recorder,
    // and nothing after it should run against that stub.
    test.describe.serial("Notification sound preview", () => {
      test.beforeAll(async () => {
        // contextBridge objects are frozen, so intercept the IPC handler in main —
        // it both suppresses real audio and records the call.
        await ctx.app.evaluate(({ ipcMain }) => {
          const channel = "notification:play-sound";
          const globals = globalThis as unknown as Record<string, unknown>;
          globals.__e2ePlaySoundFile = null;
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, (_event: unknown, soundFile: unknown) => {
            globals.__e2ePlaySoundFile = soundFile;
            return null;
          });
        });
      });

      test("clicking Preview invokes playSound with the selected sound file", async () => {
        const { window } = ctx;
        await openSettingsTab(window, "notifications");

        // The Preview buttons only render while the sound toggle is on.
        const soundToggle = window.locator(SEL.settings.notifSoundToggle);
        await expect(soundToggle).toBeVisible({ timeout: T_SHORT });
        if ((await soundToggle.getAttribute("aria-checked")) === "false") {
          await soundToggle.click();
        }
        await expect(soundToggle).toHaveAttribute("aria-checked", "true", { timeout: T_SHORT });

        const previewButton = window
          .getByRole("tabpanel", { name: "Notifications" })
          .getByRole("button", { name: "Preview completed sound" });
        await expect(previewButton).toBeVisible({ timeout: T_SHORT });
        await previewButton.click();

        await expect
          .poll(
            async () => {
              const file = await ctx.app.evaluate(
                () => (globalThis as unknown as Record<string, unknown>).__e2ePlaySoundFile
              );
              return typeof file === "string" && file.endsWith(".wav");
            },
            { timeout: T_MEDIUM }
          )
          .toBe(true);
        await closeSettingsWithEscape(window);
      });
    });
  });
});
