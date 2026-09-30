import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { dispatchAction } from "../../helpers/actions";
import { getPanelById } from "../../helpers/panels";
import { waitForTerminalText } from "../../helpers/terminal";
import { FAKE_AGENT_READY, ptyWrite, readFakeAgentLaunchLog } from "../../helpers/fakeAgent";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  confirmPresetDelete,
  addCustomPreset,
  countPresetOptions,
  getPresetOptionLabels,
  getPresetRowByName,
  getSelectedPresetLabel,
  writeCcrConfig,
  removeCcrConfig,
  waitForCcrPresets,
  waitForCcrPresetsRemoved,
} from "../../helpers/presets";
import {
  installPresetAgents,
  closeSettings,
  readCustomPresets,
  readSelectedPresetId,
  setAgentPinned,
  setAgentSettings,
  waitForLaunchesSince,
  type FakeAgents,
} from "./presetHarness";

// Add, rename, duplicate, delete and select custom presets through the real
// Settings UI, and check each change reaches the toolbar chevron, the launcher
// and persisted settings. Tests are independent: each adds the presets it acts
// on, so a failure restarts the app without stranding the rest.

const TOOLBAR_CHEVRON = '[aria-label="Set Claude preset"]';

let ctx: AppContext;
let agents: FakeAgents;
let fixtureCleanup: (() => void) | undefined;

const goToClaudeSettings = () => navigateToAgentSettings(ctx.window, "claude");
const section = () => ctx.window.locator(SEL.preset.section);
const presetDetail = () => ctx.window.locator("#agents-preset-detail");

/** Put the selected custom preset's name into edit mode and return the field. */
async function openSelectedPresetEditor(): Promise<Locator> {
  await presetDetail()
    .getByRole("button", { name: /^Edit / })
    .click();
  const input = section().getByTestId("preset-edit-input");
  await expect(input).toBeVisible({ timeout: T_SHORT });
  return input;
}

/** Add a preset through the dialog and rename it, so later steps can find it by name. */
async function addNamedPreset(name: string): Promise<string> {
  await goToClaudeSettings();
  await addCustomPreset(ctx.window);
  const id = await readSelectedPresetId(ctx.window);
  expect(id, "the added preset is the selected one").not.toBeNull();
  const input = await openSelectedPresetEditor();
  await input.fill(name);
  await input.press("Enter");
  await expect(input).toBeHidden({ timeout: T_SHORT });
  await expect
    .poll(async () => (await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name)
    .toBe(name);
  return id as string;
}

async function selectPresetByIndex(page: Page, index: number): Promise<void> {
  const trigger = page.locator(SEL.preset.selectorTrigger);
  await trigger.click();
  const listbox = page.locator(SEL.preset.selectorListbox);
  await expect(listbox).toBeVisible({ timeout: T_SHORT });
  await listbox.locator('[role="option"]').nth(index).click();
  await expect(listbox).toBeHidden({ timeout: T_SHORT });
}

async function openToolbarPresetMenu(): Promise<Locator> {
  await closeSettings(ctx.window);
  const chevron = ctx.window.locator(TOOLBAR_CHEVRON).first();
  await expect(chevron).toBeVisible({ timeout: T_LONG });
  await chevron.click();
  const menu = ctx.window.locator('[role="menu"]');
  await expect(menu).toBeVisible({ timeout: T_MEDIUM });
  return menu;
}

async function closeMenu(): Promise<void> {
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_MEDIUM });
}

const launcher = () => ctx.window.getByRole("dialog", { name: "Launch" });
const launcherPresetRows = () => ctx.window.locator(SEL.preset.trayLaunchPresetItem);

/** Open the launcher, narrow it to Claude and expand Claude's presets in place. */
async function openLauncherClaudePresets(): Promise<void> {
  await closeSettings(ctx.window);
  await ctx.window.locator(SEL.agent.trayButton).click();
  const search = ctx.window.getByRole("combobox", { name: "Search agents, panels, and recipes" });
  await expect(search).toBeVisible({ timeout: T_MEDIUM });
  await search.fill("Claude");
  await expect(ctx.window.locator(SEL.preset.trayLaunchPresetParent).first()).toBeVisible({
    timeout: T_MEDIUM,
  });
  await search.press("ArrowRight");
  await expect(launcherPresetRows().first()).toBeVisible({ timeout: T_SHORT });
}

async function closeLauncher(): Promise<void> {
  // Two presses: the first spends itself clearing a non-empty query.
  await ctx.window.keyboard.press("Escape");
  if (await launcher().isVisible()) await ctx.window.keyboard.press("Escape");
  await expect(launcher()).toBeHidden({ timeout: T_MEDIUM });
}

async function deleteSelectedPreset(): Promise<void> {
  // The delete row sits last in the selected preset's group; its accessible
  // name is "Delete <preset name>" and its text "Delete preset".
  const del = section()
    .getByRole("button")
    .filter({ hasText: /^Delete preset$/ });
  await expect(del).toBeVisible({ timeout: T_SHORT });
  await del.click();
  await confirmPresetDelete(ctx.window);
}

async function duplicateSelectedPreset(): Promise<void> {
  const dup = section().locator(SEL.preset.duplicateButton).first();
  await expect(dup).toBeVisible({ timeout: T_SHORT });
  await dup.click();
}

test.describe("Presets: custom preset CRUD", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    const { dir, cleanup } = createFixtureRepo({ name: "preset-crud" });
    agents = installPresetAgents(dir);
    fixtureCleanup = () => {
      cleanup();
      agents.dispose();
    };
    ctx = await launchApp({ env: agents.env });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Preset CRUD Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.describe("add", () => {
    test("13. Clicking Add creates a new custom preset", async () => {
      await goToClaudeSettings();
      const before = (await readCustomPresets(ctx.window)).length;
      await addCustomPreset(ctx.window);
      await expect(section().locator("span", { hasText: "New preset" }).first()).toBeVisible({
        timeout: T_SHORT,
      });
      expect((await readCustomPresets(ctx.window)).length).toBe(before + 1);
    });

    test("14. New custom preset appears in toolbar split-button", async () => {
      await setAgentPinned(ctx.window, "claude", true);
      await addNamedPreset("Toolbar Fresh 14");
      const menu = await openToolbarPresetMenu();
      await expect(menu.getByText("Toolbar Fresh 14").first()).toBeVisible({ timeout: T_SHORT });
      await closeMenu();
    });

    test("15. New custom preset appears in the launcher's preset rows", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      // Launcher rows are for unpinned agents; a pinned one lives on the toolbar.
      await setAgentPinned(ctx.window, "claude", false);
      try {
        await openLauncherClaudePresets();
        await expect(launcherPresetRows().filter({ hasText: "New preset" }).first()).toBeVisible({
          timeout: T_SHORT,
        });
        await closeLauncher();
      } finally {
        await setAgentPinned(ctx.window, "claude", true);
      }
    });

    test("16. Custom preset shows 'custom' badge", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      await expect(section().locator(SEL.preset.customBadge)).toHaveCount(1);
    });

    test("17. Add preset works when no CCR presets exist", async () => {
      removeCcrConfig();
      await goToClaudeSettings();
      const labelsBefore = await getPresetOptionLabels(ctx.window);
      expect(labelsBefore.some((l) => l.includes("CCR"))).toBe(false);
      const before = (await readCustomPresets(ctx.window)).length;
      await addCustomPreset(ctx.window);
      await expect(section()).toBeVisible({ timeout: T_SHORT });
      expect((await readCustomPresets(ctx.window)).length).toBe(before + 1);
    });

    test("18. Adding multiple presets creates distinct entries", async () => {
      await goToClaudeSettings();
      const optionsBefore = await countPresetOptions(ctx.window);
      await addCustomPreset(ctx.window);
      await addCustomPreset(ctx.window);
      const count = await countPresetOptions(ctx.window);
      expect(count).toBeGreaterThanOrEqual(3);
      expect(count).toBe(optionsBefore + 2);
      const ids = (await readCustomPresets(ctx.window)).map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test("19. Added preset persists after closing and reopening Settings", async () => {
      await addNamedPreset("Persist Add 19");
      const countBefore = (await readCustomPresets(ctx.window)).length;
      await closeSettings(ctx.window);

      await goToClaudeSettings();
      const labels = await getPresetOptionLabels(ctx.window);
      expect(labels).toContain("Persist Add 19");
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).length)
        .toBeGreaterThanOrEqual(countBefore);
    });

    test("20. Preset with empty env is valid", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      const id = await readSelectedPresetId(ctx.window);
      const added = (await readCustomPresets(ctx.window)).find((p) => p.id === id);
      expect(added?.env ?? {}).toEqual({});
      await expect(section().locator(SEL.preset.customBadge).last()).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("21. Add then delete leaves no orphan", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      const presetsBefore = (await readCustomPresets(ctx.window)).length;
      expect(presetsBefore).toBeGreaterThanOrEqual(1);

      await deleteSelectedPreset();

      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).length)
        .toBe(presetsBefore - 1);
      await expect(section()).toBeVisible({ timeout: T_SHORT });
    });

    test("23. Adding preset to Claude does not affect Gemini", async () => {
      await navigateToAgentSettings(ctx.window, "gemini");
      const geminiBefore = (await readCustomPresets(ctx.window, "gemini")).length;
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);

      await navigateToAgentSettings(ctx.window, "gemini");
      await expect(section().locator(SEL.preset.customBadge)).toHaveCount(0);
      expect((await readCustomPresets(ctx.window, "gemini")).length).toBe(geminiBefore);
    });

    test("24. Add preset works when agent is not pinned", async () => {
      // A direct IPC write doesn't reach the store the settings UI reads, so
      // unpin through the toggle itself.
      await goToClaudeSettings();
      const pinToggle = ctx.window.locator("#agents-enable button");
      await expect(pinToggle).toBeVisible({ timeout: T_MEDIUM });
      if ((await pinToggle.getAttribute("aria-checked")) === "true") {
        await pinToggle.click();
      }
      await expect(pinToggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });

      try {
        const countBefore = (await readCustomPresets(ctx.window)).length;
        await addCustomPreset(ctx.window);
        await expect(section()).toBeVisible({ timeout: T_SHORT });
        await expect
          .poll(async () => (await readCustomPresets(ctx.window)).length)
          .toBe(countBefore + 1);
      } finally {
        await setAgentPinned(ctx.window, "claude", true);
      }
    });
  });

  test.describe("rename", () => {
    test("25. Pencil icon shows inline edit input", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      const input = await openSelectedPresetEditor();
      await expect(input).toBeFocused();
      await input.press("Escape");
    });

    test("26. Renaming updates name in preset list", async () => {
      const id = await addNamedPreset("Renamed Preset");
      await expect(section().locator("span", { hasText: "Renamed Preset" }).first()).toBeVisible({
        timeout: T_SHORT,
      });
      expect((await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name).toBe(
        "Renamed Preset"
      );
    });

    test("27. Renamed preset visible in the launcher's preset rows", async () => {
      await addNamedPreset("Launcher Renamed 27");
      await openLauncherClaudePresets();
      await expect(launcherPresetRows().filter({ hasText: "Launcher Renamed 27" })).toBeVisible({
        timeout: T_MEDIUM,
      });
      await closeLauncher();
    });

    test("28. Canceling rename leaves name unchanged", async () => {
      const id = await addNamedPreset("Cancel Base 28");
      const input = await openSelectedPresetEditor();
      await input.fill("Should Not Save");
      await input.press("Escape");
      await expect(input).toBeHidden({ timeout: T_SHORT });
      await expect(section().locator("span", { hasText: "Should Not Save" })).toHaveCount(0);
      expect((await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name).toBe(
        "Cancel Base 28"
      );
    });

    test("29. Empty rename rejected", async () => {
      const id = await addNamedPreset("Empty Base 29");
      const input = await openSelectedPresetEditor();
      const priorName = await input.inputValue();
      expect(priorName).toBe("Empty Base 29");
      await input.fill("");
      await input.press("Enter");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(section().getByRole("alert")).toContainText("Give the preset a name");
      await input.press("Escape");
      await expect(section().locator("span", { hasText: priorName }).first()).toBeVisible({
        timeout: T_MEDIUM,
      });
      expect((await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name).toBe(priorName);
    });

    test("30. A name over 200 characters is refused with a reason", async () => {
      const id = await addNamedPreset("Long Base 30");
      const input = await openSelectedPresetEditor();
      await input.fill("A".repeat(250));
      await input.press("Enter");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(section().getByRole("alert")).toContainText(
        "Keep the name under 200 characters"
      );
      await input.press("Escape");
      await expect(section().locator(SEL.preset.customBadge).first()).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(ctx.window.locator(SEL.errorBoundary.fallback)).toHaveCount(0);
      expect((await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name).toBe(
        "Long Base 30"
      );
    });

    test("32. Name with markup delimiters is rejected", async () => {
      const id = await addNamedPreset("Markup Base 32");
      const input = await openSelectedPresetEditor();
      await input.fill("Test < Special");
      await input.press("Enter");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(section().getByRole("alert")).toContainText("Names can't contain < or >");
      await input.press("Escape");
      await expect(section().getByRole("button", { name: "Edit Markup Base 32" })).toBeVisible();
      expect((await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name).toBe(
        "Markup Base 32"
      );
    });

    test("33. Name with emoji works", async () => {
      const id = await addNamedPreset("🚀 Rocket Preset");
      await expect(section().locator("span", { hasText: "🚀 Rocket Preset" }).first()).toBeVisible({
        timeout: T_MEDIUM,
      });
      expect((await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name).toBe(
        "🚀 Rocket Preset"
      );
    });

    test("34. Edit persists across Settings close/reopen", async () => {
      await addNamedPreset("Persistent Name");
      await closeSettings(ctx.window);

      await goToClaudeSettings();
      await expect(section().locator("span", { hasText: "Persistent Name" }).first()).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("98. A name with < or > is refused; shell metacharacters are stored verbatim", async () => {
      const id = await addNamedPreset("Guard Base 98");

      const input = await openSelectedPresetEditor();
      await input.fill("Evil <img src=x>");
      await input.press("Enter");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(section().getByRole("alert")).toContainText("Names can't contain < or >");
      await input.press("Escape");
      await expect(input).toBeHidden({ timeout: T_SHORT });
      expect((await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name).toBe(
        "Guard Base 98"
      );

      // Quotes and shell syntax are allowed on purpose: a preset name is data,
      // never part of a command line, so it must come back exactly as typed.
      const shellName = `'; echo pwned; $(touch pwned) "x" & y`;
      const again = await openSelectedPresetEditor();
      await again.fill(shellName);
      await again.press("Enter");
      await expect(again).toBeHidden({ timeout: T_SHORT });
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).find((p) => p.id === id)?.name)
        .toBe(shellName);
      await expect(section().getByRole("button", { name: `Edit ${shellName}` })).toBeVisible();
    });
  });

  test.describe("duplicate", () => {
    test("35. Duplicate icon on any preset creates a custom copy", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      const optionsBefore = await countPresetOptions(ctx.window);
      await duplicateSelectedPreset();
      await expect
        .poll(() => countPresetOptions(ctx.window), { timeout: T_LONG })
        .toBe(optionsBefore + 1);
    });

    test("36. Duplicated preset has '(copy)' in name", async () => {
      const sourceId = await addNamedPreset("Copy Source 36");
      await duplicateSelectedPreset();
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.name))
        .toContain("Copy Source 36 (copy)");
      const presets = await readCustomPresets(ctx.window);
      expect(presets.find((p) => p.id === sourceId)?.name).toBe("Copy Source 36");
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Copy Source 36 (copy)");
    });

    test("37. Duplicated preset has unique user- ID", async () => {
      const sourceId = await addNamedPreset("Copy Id 37");
      await duplicateSelectedPreset();
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.name))
        .toContain("Copy Id 37 (copy)");
      const presets = await readCustomPresets(ctx.window);
      const copy = presets.find((p) => p.name === "Copy Id 37 (copy)");
      expect(copy?.id).toMatch(/^user-/);
      expect(copy?.id).not.toBe(sourceId);
      const ids = presets.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test("39. Duplicating custom preset copies all properties", async () => {
      await goToClaudeSettings();
      const existing = await readCustomPresets(ctx.window);
      await setAgentSettings(ctx.window, "claude", {
        customPresets: [
          ...existing,
          {
            id: "user-e2e-dup-source",
            name: "Dup Props 39",
            env: { DAINTREE_E2E_PRESET: "dup-props" },
            args: ["--e2e-dup-arg"],
            color: "#aa3366",
          },
        ],
      });
      await getPresetRowByName(ctx.window, "Dup Props 39");
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Dup Props 39");
      const countBefore = await countPresetOptions(ctx.window);

      await duplicateSelectedPreset();
      await expect
        .poll(() => countPresetOptions(ctx.window), { timeout: T_LONG })
        .toBe(countBefore + 1);
      const copy = (await readCustomPresets(ctx.window)).find(
        (p) => p.name === "Dup Props 39 (copy)"
      );
      expect(copy).toMatchObject({
        env: { DAINTREE_E2E_PRESET: "dup-props" },
        args: ["--e2e-dup-arg"],
        color: "#aa3366",
      });
      expect(copy?.id).not.toBe("user-e2e-dup-source");
    });

    test("41. Duplicate button appears on custom presets", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      await expect(section().locator(SEL.preset.duplicateButton).first()).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("42. Deleting original does not affect duplicate", async () => {
      const originalId = await addNamedPreset("Original 42");
      await duplicateSelectedPreset();
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.name))
        .toContain("Original 42 (copy)");

      await getPresetRowByName(ctx.window, "Original 42");
      await expect.poll(() => readSelectedPresetId(ctx.window)).toBe(originalId);
      await deleteSelectedPreset();

      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.id))
        .not.toContain(originalId);
      expect((await readCustomPresets(ctx.window)).map((p) => p.name)).toContain(
        "Original 42 (copy)"
      );
      expect(await getPresetOptionLabels(ctx.window)).toContain("Original 42 (copy)");
    });

    test("43. Duplicate multiple times creates independent copies", async () => {
      await addNamedPreset("Multi 43");
      // Each duplicate selects its copy, so the second click copies the copy.
      await duplicateSelectedPreset();
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Multi 43 (copy)");
      await duplicateSelectedPreset();
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Multi 43 (copy) (copy)");

      const copies = (await readCustomPresets(ctx.window)).filter((p) =>
        p.name.startsWith("Multi 43 (copy)")
      );
      expect(copies).toHaveLength(2);
      expect(new Set(copies.map((p) => p.id)).size).toBe(2);
    });

    test("44. Duplicate immediately reflects in toolbar and launcher", async () => {
      await setAgentPinned(ctx.window, "claude", true);
      await addNamedPreset("Reflect 44");
      await duplicateSelectedPreset();
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.name))
        .toContain("Reflect 44 (copy)");
      expect(await getPresetOptionLabels(ctx.window)).toContain("Reflect 44 (copy)");

      const menu = await openToolbarPresetMenu();
      await expect(menu.getByText("Reflect 44 (copy)")).toBeVisible({ timeout: T_SHORT });
      await closeMenu();
    });
  });

  test.describe("delete", () => {
    test("45. Trash icon removes custom preset from section", async () => {
      const id = await addNamedPreset("Trash 45");
      await expect(section().locator(SEL.preset.customBadge)).toHaveCount(1);
      await deleteSelectedPreset();
      await expect(section().locator(SEL.preset.customBadge)).toHaveCount(0);
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.id))
        .not.toContain(id);
      expect(await getPresetOptionLabels(ctx.window)).not.toContain("Trash 45");
    });

    test("46. Deleted preset removed from toolbar dropdown", async () => {
      await setAgentPinned(ctx.window, "claude", true);
      await addNamedPreset("Chevron Keep 46");
      await addNamedPreset("Chevron Drop 46");

      const presetItems = ctx.window
        .locator('[role="menu"] [role="menuitem"]')
        .filter({ hasNotText: "Manage presets…" });
      let menu = await openToolbarPresetMenu();
      await expect(menu.getByText("Chevron Drop 46")).toBeVisible();
      const countBefore = await presetItems.count();
      expect(countBefore).toBeGreaterThan(1);
      await closeMenu();

      await goToClaudeSettings();
      await getPresetRowByName(ctx.window, "Chevron Drop 46");
      await deleteSelectedPreset();
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.name))
        .not.toContain("Chevron Drop 46");

      menu = await openToolbarPresetMenu();
      await expect(menu.getByText("Chevron Keep 46")).toBeVisible();
      await expect(menu.getByText("Chevron Drop 46")).toHaveCount(0);
      expect(await presetItems.count()).toBe(countBefore - 1);
      await closeMenu();
    });

    test("47. Deleted preset removed from the launcher's preset rows", async () => {
      await addNamedPreset("Launcher Keep 47");
      await addNamedPreset("Launcher Drop 47");
      await setAgentPinned(ctx.window, "claude", false);
      try {
        await openLauncherClaudePresets();
        await expect(launcherPresetRows().filter({ hasText: "Launcher Drop 47" })).toBeVisible();
        const countBefore = await launcherPresetRows().count();
        await closeLauncher();

        await goToClaudeSettings();
        await getPresetRowByName(ctx.window, "Launcher Drop 47");
        await deleteSelectedPreset();
        await expect
          .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.name))
          .not.toContain("Launcher Drop 47");

        await openLauncherClaudePresets();
        await expect(launcherPresetRows().filter({ hasText: "Launcher Keep 47" })).toBeVisible();
        await expect(launcherPresetRows().filter({ hasText: "Launcher Drop 47" })).toHaveCount(0);
        expect(await launcherPresetRows().count()).toBe(countBefore - 1);
        await closeLauncher();
      } finally {
        await setAgentPinned(ctx.window, "claude", true);
      }
    });

    test("49. Deleting the selected preset resets to default", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      await deleteSelectedPreset();
      await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Default");
    });

    test("51. Deletion persists after closing Settings", async () => {
      await addNamedPreset("Persist Del 51");
      const before = (await readCustomPresets(ctx.window)).length;
      await deleteSelectedPreset();
      await expect.poll(async () => (await readCustomPresets(ctx.window)).length).toBe(before - 1);

      await closeSettings(ctx.window);
      await goToClaudeSettings();
      expect(await getPresetOptionLabels(ctx.window)).not.toContain("Persist Del 51");
      expect((await readCustomPresets(ctx.window)).length).toBe(before - 1);
    });

    test("52. Deleting preset while agent running with it does not kill the agent", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      const presetId = await readSelectedPresetId(ctx.window);
      expect(presetId).not.toBeNull();

      const launchesBefore = readFakeAgentLaunchLog(agents.claudeBin).length;
      const launch = await dispatchAction<{ terminalId?: string }>(
        ctx.window,
        "agent.launch",
        { agentId: "claude", presetId, location: "grid" },
        { source: "user" }
      );
      expect(launch.ok, launch.ok ? "" : JSON.stringify(launch.error)).toBe(true);
      const terminalId = launch.ok ? (launch.result?.terminalId ?? "") : "";
      expect(terminalId).not.toBe("");
      await waitForLaunchesSince(agents.claudeBin, launchesBefore);

      const panel = getPanelById(ctx.window, terminalId);
      await expect(panel).toBeVisible({ timeout: T_LONG });

      await goToClaudeSettings();
      await deleteSelectedPreset();
      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.id))
        .not.toContain(presetId);
      await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });

      // The agent is still alive and answering: confirming its trust prompt
      // makes the fake CLI print its ready line.
      await closeSettings(ctx.window);
      await expect(panel).toBeVisible({ timeout: T_SHORT });
      await waitForTerminalText(panel, "Quick safety check", T_LONG);
      expect(await ptyWrite(ctx.window, terminalId, "\r")).toBe(true);
      await waitForTerminalText(panel, FAKE_AGENT_READY, T_LONG);
    });
  });

  test.describe("selection", () => {
    test("53. Preset selector appears in settings", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("54. Preset selector shows Default once Default is chosen", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      await selectPresetByIndex(ctx.window, 0);
      expect(await getSelectedPresetLabel(ctx.window)).toContain("Default");
      await expect.poll(() => readSelectedPresetId(ctx.window)).toBeNull();
    });

    test("55. Selector trigger reflects the configured default preset", async () => {
      await addNamedPreset("Select Me 55");
      await selectPresetByIndex(ctx.window, 0);
      expect(await countPresetOptions(ctx.window)).toBeGreaterThan(1);

      await getPresetRowByName(ctx.window, "Select Me 55");
      await expect(section().locator(SEL.preset.customBadge)).toHaveCount(1);
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Select Me 55");
    });

    test("56. Toolbar preset chevron lists the configured preset", async () => {
      await setAgentPinned(ctx.window, "claude", true);
      await addNamedPreset("Chevron Default 56");
      expect(await getSelectedPresetLabel(ctx.window)).toBe("Chevron Default 56");

      const menu = await openToolbarPresetMenu();
      await expect(
        menu.locator('[role="menuitem"]', { hasText: "Chevron Default 56" }).first()
      ).toBeVisible({ timeout: T_MEDIUM });
      await closeMenu();
    });

    test("57. Selected default preset persists across an agent switch", async () => {
      await addNamedPreset("Switch Keep 57");
      await selectPresetByIndex(ctx.window, 0);
      await getPresetRowByName(ctx.window, "Switch Keep 57");
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Switch Keep 57");

      await navigateToAgentSettings(ctx.window, "gemini");
      await goToClaudeSettings();
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Switch Keep 57");
    });

    test("58. Default persists after closing and reopening settings", async () => {
      await addNamedPreset("Reopen Keep 58");
      await selectPresetByIndex(ctx.window, 0);
      await getPresetRowByName(ctx.window, "Reopen Keep 58");
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Reopen Keep 58");

      await closeSettings(ctx.window);
      await goToClaudeSettings();
      await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Reopen Keep 58");
    });

    test("60. First option in dropdown is Default (no overrides)", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      const labels = await getPresetOptionLabels(ctx.window);
      expect(labels[0]).toContain("Default");
    });

    test("62. Setting default on Claude does not affect Gemini agent", async () => {
      await addNamedPreset("Claude Only 62");
      await navigateToAgentSettings(ctx.window, "gemini");
      await expect(section()).toBeVisible({ timeout: T_MEDIUM });
      const labels = await getPresetOptionLabels(ctx.window);
      expect(labels).not.toContain("Claude Only 62");
      expect(labels).toHaveLength(1);
      expect(await readSelectedPresetId(ctx.window, "gemini")).toBeNull();
    });
  });

  test.describe("deleting the selected preset", () => {
    // One flow, checked at each point a stale selection could leak: the
    // selector label, the persisted id, error surfaces, and a Settings reopen.
    test("71/72/74/76. Deleting the selected preset falls back to Default, durably", async () => {
      await addNamedPreset("Stale 71");
      await selectPresetByIndex(ctx.window, 0);
      await getPresetRowByName(ctx.window, "Stale 71");
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toBe("Stale 71");
      await expect.poll(() => readSelectedPresetId(ctx.window)).not.toBeNull();

      await deleteSelectedPreset();

      await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
      await expect(section()).toBeVisible({ timeout: T_SHORT });
      await expect(ctx.window.locator(SEL.errorBoundary.fallback)).toHaveCount(0);
      await expect(
        ctx.window.locator(SEL.notifications.toastRegion).getByRole("alert")
      ).toHaveCount(0);
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Default");
      await expect.poll(() => readSelectedPresetId(ctx.window)).toBeNull();

      // 73: the stale selection doesn't stop Settings loading again.
      await closeSettings(ctx.window);
      await goToClaudeSettings();
      await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
      await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Default");
      expect(await readSelectedPresetId(ctx.window)).toBeNull();
    });
  });

  test.describe("churn", () => {
    test("97. Adding many custom presets does not crash or freeze Settings", async () => {
      await goToClaudeSettings();
      const before = (await readCustomPresets(ctx.window)).length;
      const presetCount = 10;
      for (let i = 0; i < presetCount; i++) {
        await addCustomPreset(ctx.window);
      }
      await expect(section()).toBeVisible({ timeout: T_MEDIUM });
      // Only the selected preset's badge renders, so count listbox options.
      const optionCount = await countPresetOptions(ctx.window);
      expect(optionCount).toBeGreaterThanOrEqual(presetCount);
      expect((await readCustomPresets(ctx.window)).length).toBe(before + presetCount);
    });

    test("99. Rapid add/delete 10 presets — no duplicate entries", async () => {
      await goToClaudeSettings();
      const countBefore = (await readCustomPresets(ctx.window)).length;

      for (let i = 0; i < 10; i++) {
        const beforeAdd = (await readCustomPresets(ctx.window)).length;
        await addCustomPreset(ctx.window);
        const presets = await readCustomPresets(ctx.window);
        expect(presets.length).toBe(beforeAdd + 1);
        const added = presets[presets.length - 1];
        await expect.poll(() => readSelectedPresetId(ctx.window)).toBe(added.id);

        await deleteSelectedPreset();
        await expect.poll(async () => (await readCustomPresets(ctx.window)).length).toBe(beforeAdd);
      }

      await expect(section()).toBeVisible({ timeout: T_MEDIUM });
      const presetsAfter = await readCustomPresets(ctx.window);
      expect(presetsAfter.length).toBe(countBefore);
      const ids = presetsAfter.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);

      // The listbox matches persisted state exactly: no ghost rows. Distinct
      // labels, because a closing Radix popover can briefly render twice.
      const labels = await getPresetOptionLabels(ctx.window);
      expect(new Set(labels)).toEqual(
        new Set(["Default settings", ...presetsAfter.map((p) => p.name)])
      );
    });
  });

  // CCR presets come from a config file; this group owns it for its duration.
  test.describe("alongside CCR presets", () => {
    test.beforeAll(async () => {
      writeCcrConfig([
        { id: "ccr-adj", name: "CCR Adj", model: "adj-model", baseUrl: "https://dup.local" },
        { id: "ccr-second", name: "CCR Second", model: "second-model" },
      ]);
      await waitForCcrPresets(ctx.window, ["CCR Adj", "CCR Second"]);
    });

    test.afterAll(async () => {
      removeCcrConfig();
    });

    test("22. Add button visible alongside CCR presets", async () => {
      await goToClaudeSettings();
      await getPresetRowByName(ctx.window, "CCR Adj");
      await expect(section().locator(SEL.preset.addButton)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("31/48. CCR presets expose neither Edit nor Delete", async () => {
      await goToClaudeSettings();
      const detail = await getPresetRowByName(ctx.window, "CCR Adj");
      await expect(detail).toBeVisible({ timeout: T_MEDIUM });
      await expect(section().locator(SEL.preset.autoBadge)).toBeVisible();
      await expect(detail.locator(SEL.preset.editButton)).toHaveCount(0);
      await expect(detail.locator(SEL.preset.deleteButton)).toHaveCount(0);
    });

    test("38/40. Duplicating a CCR preset copies its env overrides", async () => {
      await goToClaudeSettings();
      const detail = await getPresetRowByName(ctx.window, "CCR Adj");
      const dupBtn = detail.locator(SEL.preset.duplicateButton).first();
      await expect(dupBtn).toBeVisible({ timeout: T_SHORT });
      await dupBtn.click();

      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).map((p) => p.name))
        .toEqual(expect.arrayContaining([expect.stringMatching(/CCR Adj.*\(copy\)/)]));
      const copy = (await readCustomPresets(ctx.window)).find((p) =>
        /CCR Adj.*\(copy\)/.test(p.name)
      );
      expect(copy?.env).toMatchObject({
        ANTHROPIC_MODEL: "adj-model",
        ANTHROPIC_BASE_URL: "https://dup.local",
      });
      const labels = await getPresetOptionLabels(ctx.window);
      expect(labels.some((t) => t.includes("CCR Adj") && t.includes("(copy)"))).toBe(true);
      // The copy is custom: its detail shows the inherited env value.
      await expect(section().locator(SEL.preset.customBadge)).toHaveCount(1);
      await expect(
        section().getByRole("textbox", { name: "Value of ANTHROPIC_MODEL" })
      ).toHaveValue("adj-model");
      await expect(
        section().getByRole("textbox", { name: "Value of ANTHROPIC_BASE_URL" })
      ).toHaveValue("https://dup.local");
    });

    test("59. Dropdown includes both CCR and custom presets", async () => {
      await addNamedPreset("Mixed Custom 59");
      const labels = await getPresetOptionLabels(ctx.window);
      expect(labels.some((l) => l.includes("CCR Second"))).toBe(true);
      expect(labels).toContain("Mixed Custom 59");
      expect(labels.length).toBeGreaterThanOrEqual(3);
    });

    test("61. Section still shows after the CCR config is removed", async () => {
      await goToClaudeSettings();
      await addCustomPreset(ctx.window);
      removeCcrConfig();
      await waitForCcrPresetsRemoved(ctx.window, ["CCR Adj", "CCR Second"]);
      await goToClaudeSettings();
      await expect(section()).toBeVisible({ timeout: T_MEDIUM });
      await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({
        timeout: T_SHORT,
      });
      const labels = await getPresetOptionLabels(ctx.window);
      // Test 38's copy ("CCR: CCR Adj (copy)") is a custom preset and stays.
      expect(labels.some((l) => l.includes("CCR Adj") && !l.includes("(copy)"))).toBe(false);
      expect(labels.some((l) => l.includes("CCR Second"))).toBe(false);
    });

    test("50. Deleting every custom preset with no CCR config leaves only Default", async () => {
      removeCcrConfig();
      await waitForCcrPresetsRemoved(ctx.window, ["CCR Adj", "CCR Second"]);
      // Two of its own, so the loop always has something to delete.
      await addNamedPreset("Delete All A 50");
      await addNamedPreset("Delete All B 50");
      await goToClaudeSettings();
      expect((await readCustomPresets(ctx.window)).length).toBeGreaterThanOrEqual(2);
      for (let remaining = (await readCustomPresets(ctx.window)).length; remaining > 0;) {
        const target = (await readCustomPresets(ctx.window))[0];
        await getPresetRowByName(ctx.window, target.name);
        await expect.poll(() => readSelectedPresetId(ctx.window)).toBe(target.id);
        await deleteSelectedPreset();
        await expect
          .poll(async () => (await readCustomPresets(ctx.window)).length)
          .toBe(remaining - 1);
        remaining -= 1;
      }
      expect(await getPresetOptionLabels(ctx.window)).toEqual(["Default settings"]);
      await expect(section().locator(SEL.preset.addButton)).toBeVisible({ timeout: T_SHORT });
    });
  });

  test("100. Corrupt customPresets data does not crash settings page", async () => {
    // Direct IPC rather than the action: the action validates the payload and
    // would reject it, and the point is to make the renderer parse bad data.
    await ctx.window.evaluate(async () => {
      const settings = await window.electron.agentSettings.get();
      const agents = settings.agents as Record<string, { customPresets?: unknown[] } | undefined>;
      const existing = Array.isArray(agents.claude?.customPresets)
        ? agents.claude.customPresets
        : [];
      await window.electron.agentSettings.set("claude", {
        customPresets: [
          ...existing,
          { name: "corrupt-no-id" },
          { id: 123, name: null, args: "not-an-array" },
        ] as never,
      });
    });
    await expect
      .poll(async () =>
        (await readCustomPresets(ctx.window)).some((p) => p?.name === "corrupt-no-id")
      )
      .toBe(true);

    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await expect(section()).toBeVisible({ timeout: T_MEDIUM });
    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).toHaveCount(0);
  });
});
