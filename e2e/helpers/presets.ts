import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { SEL } from "./selectors";
import { dismissBlockingPalette } from "./overlays";
import { E2E_TEMP_PREFIX, recordTempDir } from "./tempDirs";

// Each test process gets its own CCR config file so parallel workers don't
// clobber each other via the shared `~/.claude-code-router/config.json`.
// Pair with launchApp({ env: { DAINTREE_CCR_CONFIG_PATH: CCR_CONFIG_PATH } })
// so the main process under test reads from the same file.
const CCR_DIR = mkdtempSync(join(tmpdir(), `${E2E_TEMP_PREFIX}ccr-`));
recordTempDir(CCR_DIR);
const CCR_CONFIG_PATH = join(CCR_DIR, "config.json");
// Pre-seed the env so launchApp's `{ ...process.env, ... }` picks it up
// without every preset spec needing to thread the variable by hand.
process.env.DAINTREE_CCR_CONFIG_PATH = CCR_CONFIG_PATH;

export interface CcrModelEntry {
  id?: string;
  name?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export function writeCcrConfig(models: CcrModelEntry[]): void {
  mkdirSync(CCR_DIR, { recursive: true });
  writeFileSync(CCR_CONFIG_PATH, JSON.stringify({ models }, null, 2), "utf-8");
}

export function removeCcrConfig(): void {
  if (existsSync(CCR_CONFIG_PATH)) {
    rmSync(CCR_CONFIG_PATH);
  }
}

/**
 * Wait up to `timeout` for `locator` to be visible and report whether it got
 * there. `locator.isVisible({ timeout })` looks like this but returns at once —
 * Playwright ignores that timeout — so a retry loop built on it never waits.
 */
async function becomesVisible(locator: Locator, timeout: number): Promise<boolean> {
  return locator.waitFor({ state: "visible", timeout }).then(
    () => true,
    () => false
  );
}

async function becomesHidden(locator: Locator, timeout: number): Promise<boolean> {
  return locator.waitFor({ state: "hidden", timeout }).then(
    () => true,
    () => false
  );
}

/** Deleting a custom preset confirms first; accept that confirm. */
export async function confirmPresetDelete(window: import("@playwright/test").Page): Promise<void> {
  const confirm = window.getByRole("button", { name: "Delete preset", exact: true });
  await expect(confirm).toBeVisible({ timeout: 5000 });
  await confirm.click();
}

export async function navigateToAgentSettings(
  window: import("@playwright/test").Page,
  agentId: string
): Promise<void> {
  await test.step(
    `Navigate to agent settings "${agentId}"`,
    async () => {
      const openSettingsIfNeeded = async () => {
        const heading = window.locator(SEL.settings.heading);
        if (!(await heading.isVisible().catch(() => false))) {
          const { openSettings } = await import("./panels");
          await openSettings(window);
        }
      };

      const clearSettingsSearch = async () => {
        const searchInput = window.locator(SEL.settings.searchInput);
        if (!(await searchInput.isVisible().catch(() => false))) return;
        if ((await searchInput.inputValue().catch(() => "")) !== "") {
          await searchInput.fill("");
        }
      };

      const displayName = agentId.charAt(0).toUpperCase() + agentId.slice(1);
      const agentsPanel = window.locator("#settings-panel-agents");
      const dropdownTrigger = agentsPanel.locator('[data-testid="agent-selector-trigger"]');
      const presetSection = agentsPanel.locator(SEL.preset.section);

      for (let attempt = 0; attempt < 5; attempt++) {
        await dismissBlockingPalette(window).catch(() => undefined);
        await openSettingsIfNeeded();
        await clearSettingsSearch();

        const cliButton = window.locator(`${SEL.settings.navSidebar} button`, {
          hasText: "CLI Agents",
        });
        await expect(cliButton).toBeVisible({ timeout: 10000 });
        await cliButton.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});

        if (!(await becomesVisible(dropdownTrigger, 5000))) {
          await window.waitForTimeout(500);
          continue;
        }

        try {
          const currentLabel = await dropdownTrigger.getAttribute("aria-label");
          if (currentLabel !== `Switch agent, current: ${displayName}`) {
            await dropdownTrigger.click();
            const listbox = window.locator('[role="listbox"]#agent-selector-list');
            await expect(listbox).toBeVisible({ timeout: 5000 });
            const option = listbox.locator(`#agent-selector-item-${agentId}`);
            await option.click();
            await expect(dropdownTrigger).toHaveAttribute(
              "aria-label",
              `Switch agent, current: ${displayName}`
            );
            await expect(listbox).not.toBeVisible({ timeout: 5000 });
          }

          if (await becomesVisible(presetSection, 5000)) {
            return;
          }
        } catch {
          await window.keyboard.press("Escape").catch(() => undefined);
        }

        await window.waitForTimeout(500);
      }

      const heading = window.locator(SEL.settings.heading);
      if (!(await heading.isVisible().catch(() => false))) {
        const { openSettings } = await import("./panels");
        await openSettings(window);
      }

      const cliButton = window.locator(`${SEL.settings.navSidebar} button`, {
        hasText: "CLI Agents",
      });
      await expect(cliButton).toBeVisible({ timeout: 10000 });
      await cliButton.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});

      await expect(dropdownTrigger).toBeVisible({ timeout: 5000 });

      const currentLabel = await dropdownTrigger.getAttribute("aria-label");
      if (currentLabel !== `Switch agent, current: ${displayName}`) {
        await dropdownTrigger.click();
        const listbox = window.locator('[role="listbox"]#agent-selector-list');
        await expect(listbox).toBeVisible({ timeout: 5000 });
        const option = listbox.locator(`#agent-selector-item-${agentId}`);
        await option.click();
        await expect(dropdownTrigger).toHaveAttribute(
          "aria-label",
          `Switch agent, current: ${displayName}`
        );
        await expect(listbox).not.toBeVisible({ timeout: 5000 });
      }
      await expect(presetSection).toBeVisible({ timeout: 5000 });
    },
    { box: true }
  );
}

async function openPresetSelector(window: Page) {
  await dismissBlockingPalette(window).catch(() => undefined);

  const trigger = window.locator(SEL.preset.selectorTrigger);
  await trigger.waitFor({ state: "visible", timeout: 10_000 });

  const listbox = window.locator(SEL.preset.selectorListbox);
  for (let attempt = 0; attempt < 5; attempt++) {
    await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
    await trigger.click({ force: true, noWaitAfter: true, timeout: 5_000 }).catch(async () => {
      await trigger.dispatchEvent("click").catch(() => undefined);
    });
    if (await becomesVisible(listbox, 2_000)) {
      return listbox;
    }
    await trigger.press("Enter").catch(() => undefined);
    if (await becomesVisible(listbox, 2_000)) {
      return listbox;
    }
    await trigger.click({ force: true, noWaitAfter: true, timeout: 2_000 }).catch(() => undefined);
    await window.waitForTimeout(250);
  }

  await trigger.dispatchEvent("click").catch(() => undefined);
  await expect(listbox).toBeVisible({ timeout: 5_000 });
  return listbox;
}

/**
 * Selects the named preset in the PresetSelector Popover listbox and returns
 * the detail-view panel that appears below the selector. With the
 * selector+detail design only one preset's detail is visible at a time;
 * call this function sequentially for each preset you need to inspect.
 */
export async function getPresetRowByName(
  window: import("@playwright/test").Page,
  name: string
): Promise<import("@playwright/test").Locator> {
  return await test.step(
    `Select preset "${name}"`,
    async () => {
      const trigger = window.locator(SEL.preset.selectorTrigger);
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      const listbox = await openPresetSelector(window);

      // Match options by substring rather than exact text — CCR options also
      // render a "CCR" badge span inside the option, so the option's full
      // textContent looks like "UI DebugCCR". Substring matching is sufficient
      // because option labels within a single agent are unique.
      const option = listbox
        .locator('[role="option"]', {
          hasText: name,
        })
        .first();
      await expect(option).toBeVisible({ timeout: 10_000 });
      await option.scrollIntoViewIfNeeded().catch(() => undefined);
      await option.click({ force: true, noWaitAfter: true, timeout: 5_000 }).catch(async () => {
        await option.dispatchEvent("click").catch(() => undefined);
      });
      if (!(await becomesHidden(listbox, 2_000))) {
        await option.dispatchEvent("click").catch(() => undefined);
      }
      await expect(listbox).not.toBeVisible({ timeout: 5000 });

      // The preset section holds only the selected scope's editor, so it is the detail view.
      return window.locator(SEL.preset.section);
    },
    { box: true }
  );
}

/**
 * Reads the currently selected preset label from the PresetSelector trigger.
 * Use this in place of `select.inputValue()` or option-checked assertions.
 */
export async function getSelectedPresetLabel(
  window: import("@playwright/test").Page
): Promise<string> {
  const trigger = window.locator(SEL.preset.selectorTrigger);
  return (await trigger.textContent())?.trim() ?? "";
}

interface CustomPresetState {
  customCount: number;
  presetId: string | null;
}

async function getCustomPresetState(window: Page, agentId: string): Promise<CustomPresetState> {
  return window.evaluate(async (id): Promise<CustomPresetState> => {
    const settings = await globalThis.window.electron.agentSettings.get();
    const agents = settings.agents as
      Record<string, { customPresets?: unknown[]; presetId?: string } | undefined> | undefined;
    const entry = agents?.[id];
    return {
      customCount: Array.isArray(entry?.customPresets) ? entry.customPresets.length : 0,
      presetId: entry?.presetId ?? null,
    };
  }, agentId);
}

export async function addCustomPreset(
  window: import("@playwright/test").Page,
  agentId = "claude"
): Promise<void> {
  await test.step(
    "Add custom preset",
    async () => {
      const section = window.locator(SEL.preset.section);
      await expect(section).toBeVisible({ timeout: 5000 });
      const stateBefore = await getCustomPresetState(window, agentId);
      await section.locator(SEL.preset.addButton).click({ force: true, noWaitAfter: true });
      // The Add button opens an "Add preset" dialog with a Start-from chooser;
      // Create accepts the default "Blank" choice. A dialog that never opens or
      // never closes is the bug this step exists to catch, so it fails here.
      const dialog = window.locator('[data-testid="add-preset-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      const createButton = dialog.getByRole("button", { name: "Create preset", exact: true });
      await expect(createButton).toBeEnabled({ timeout: 5000 });
      await createButton.click({ force: true, noWaitAfter: true });
      await expect(dialog).not.toBeVisible({ timeout: process.env.CI ? 10_000 : 5000 });
      if (!(await becomesVisible(section, 1000))) {
        await navigateToAgentSettings(window, agentId);
      }
      // Poll the persisted settings directly. On Windows the Radix popover can
      // briefly report stale option counts even after the newly selected preset
      // is visible in the settings detail panel.
      await expect
        .poll(
          async () => {
            const state = await getCustomPresetState(window, agentId);
            return (
              state.customCount >= stateBefore.customCount + 1 &&
              state.presetId !== null &&
              state.presetId !== stateBefore.presetId
            );
          },
          {
            timeout: process.env.CI ? 10_000 : 5_000,
            intervals: [100, 200, 400, 800],
          }
        )
        .toBe(true);
      await expect(section.locator(SEL.preset.customBadge).first()).toBeVisible({ timeout: 5000 });
    },
    { box: true }
  );
}

/**
 * Opens the PresetSelector popover, counts the options, and closes the popover.
 * Replaces the old native `<select>` `option` count queries — the new Popover
 * listbox is only mounted while open.
 */
export async function countPresetOptions(window: import("@playwright/test").Page): Promise<number> {
  return await test.step(
    "Count preset options",
    async () => {
      const listbox = await openPresetSelector(window);
      const n = await listbox.locator('[role="option"]').count();
      // Escape, not a click on the trigger. The open listbox is a dismissable
      // layer that covers its own trigger, so a click there is swallowed by the
      // overlay and never toggles it shut — with `force` or without — leaving
      // the listbox open for the next step to trip over.
      await window.keyboard.press("Escape");
      await expect(listbox).not.toBeVisible({ timeout: 5000 });
      return n;
    },
    { box: true }
  );
}

/**
 * Opens the PresetSelector popover and returns the visible option labels. The
 * popover is closed before returning.
 */
const CCR_POLL_TIMEOUT = process.platform === "win32" ? 75_000 : 45_000;
const CCR_POLL_INTERVALS = [250, 500, 1_000, 2_000];

async function getCcrPresetLabels(window: Page): Promise<string[]> {
  return window.evaluate(async (): Promise<string[]> => {
    const presets = await globalThis.window.electron.agentCapabilities.getCcrPresets();
    return presets
      .map((preset: { name?: unknown }) =>
        typeof preset.name === "string" ? preset.name.replace(/^CCR:\s*/, "").trim() : ""
      )
      .filter((label) => label.length > 0);
  });
}

/**
 * Polls the preset listbox until all expected label substrings appear.
 * Replaces fixed 35s waits for the CCR config-file poll cycle.
 */
export async function waitForCcrPresets(
  window: import("@playwright/test").Page,
  expectedLabels: string[],
  agentId = "claude"
): Promise<void> {
  if (expectedLabels.length === 0) return;

  await test.step(
    `Wait for CCR presets: [${expectedLabels.join(", ")}]`,
    async () => {
      await navigateToAgentSettings(window, agentId);

      await expect
        .poll(
          async () => {
            return getCcrPresetLabels(window);
          },
          {
            message: `Timed out waiting for CCR presets: [${expectedLabels.join(", ")}]`,
            timeout: CCR_POLL_TIMEOUT,
            intervals: CCR_POLL_INTERVALS,
          }
        )
        .toEqual(expect.arrayContaining(expectedLabels.map((e) => expect.stringContaining(e))));

      await navigateToAgentSettings(window, agentId);
    },
    { box: true }
  );
}

/**
 * Polls the preset listbox until none of the removed label substrings appear.
 * Replaces fixed 35s waits after removeCcrConfig() for the CCR poll cycle.
 *
 * Throws (causing poll retry) when the preset selector trigger is not visible,
 * so a missing trigger never produces a false pass.
 */
export async function waitForCcrPresetsRemoved(
  window: import("@playwright/test").Page,
  removedLabels: string[],
  agentId = "claude"
): Promise<void> {
  if (removedLabels.length === 0) return;

  await test.step(
    `Wait for CCR presets removed: [${removedLabels.join(", ")}]`,
    async () => {
      await navigateToAgentSettings(window, agentId);

      await expect
        .poll(
          async () => {
            return getCcrPresetLabels(window);
          },
          {
            message: `Timed out waiting for CCR presets to be removed: [${removedLabels.join(", ")}]`,
            timeout: CCR_POLL_TIMEOUT,
            intervals: CCR_POLL_INTERVALS,
          }
        )
        .not.toEqual(expect.arrayContaining(removedLabels.map((e) => expect.stringContaining(e))));

      await navigateToAgentSettings(window, agentId);
    },
    { box: true }
  );
}

export async function getPresetOptionLabels(
  window: import("@playwright/test").Page
): Promise<string[]> {
  return await test.step(
    "Get preset option labels",
    async () => {
      const listbox = await openPresetSelector(window);
      const labels = await listbox.locator('[role="option"]').allTextContents();
      // Escape, not a click on the trigger. The open listbox is a dismissable
      // layer that covers its own trigger, so a click there is swallowed by the
      // overlay and never toggles it shut — with `force` or without — leaving
      // the listbox open for the next step to trip over.
      await window.keyboard.press("Escape");
      await expect(listbox).not.toBeVisible({ timeout: 5000 });
      return labels.map((s) => s.trim());
    },
    { box: true }
  );
}
