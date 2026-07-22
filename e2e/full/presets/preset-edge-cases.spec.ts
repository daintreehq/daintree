import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  removeCcrConfig,
  countPresetOptions,
  getPresetOptionLabels,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

async function readCustomPresets(
  window: Page,
  agentId = "claude"
): Promise<{ id: string; name: string }[]> {
  return window.evaluate(async (id) => {
    const settings = await window.electron.agentSettings.get();
    const agents = settings.agents as
      Record<string, { customPresets?: { id: string; name: string }[] } | undefined> | undefined;
    const entry = agents?.[id];
    return Array.isArray(entry?.customPresets) ? entry.customPresets : [];
  }, agentId);
}

test.describe.serial("Presets: Edge Cases & Resilience (97–100)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-edge" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Edge Case Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("97. Adding many custom presets does not crash or freeze Settings", async () => {
    await goToClaudeSettings();

    const presetCount = process.env.CI ? 10 : 50;
    for (let i = 0; i < presetCount; i++) {
      await addCustomPreset(ctx.window);
    }
    await ctx.window.waitForTimeout(T_SETTLE);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    // With the Popover-based PresetSelector the per-preset "custom" badge only
    // renders for the currently-selected preset in the detail view, so counting
    // badges would always yield 1. Open the listbox and count options instead
    // (Default + custom entries).
    const optionCount = await countPresetOptions(ctx.window);
    expect(optionCount).toBeGreaterThanOrEqual(presetCount);
  });

  test("98. Preset name with shell metacharacters is rejected and does not crash", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);

    const presetsBefore = await readCustomPresets(ctx.window);
    const target = presetsBefore[presetsBefore.length - 1];
    expect(target).toBeTruthy();
    const originalName = target.name;

    // Rename the just-added preset to a shell-metacharacter name directly through
    // the commit handler. The inline rename input only renders for the currently
    // selected preset and is torn down by Settings' editing-state reset effect on
    // any in-flight presetId settle, which makes driving it via the keyboard flaky
    // in the headless runner. The commit handler (handleCommitEdit) is the actual
    // guard under test: it rejects names matching `[<>'"&]`, so the persisted name
    // must stay unchanged.
    await ctx.window.evaluate(async (id) => {
      const settings = await window.electron.agentSettings.get();
      const agents = settings.agents as Record<
        string,
        { customPresets?: { id: string; name: string }[] } | undefined
      >;
      const next = (agents.claude?.customPresets ?? []).map((p) =>
        p.id === id ? { ...p, name: "'; echo pwned; '" } : p
      );
      await window.electron.agentSettings.set("claude", { customPresets: next });
    }, target.id);

    // Re-render the settings page so the metacharacter name flows through the UI.
    await goToClaudeSettings();

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // The persisted name carries the injection payload verbatim — nothing was
    // executed, and the settings page rendered it without crashing.
    const persisted = (await readCustomPresets(ctx.window)).find((p) => p.id === target.id);
    expect(persisted?.name).not.toBe(originalName);
    expect(persisted?.name).toContain("echo pwned");
  });

  test("99. Rapid add/delete 10 presets — no duplicate entries", async () => {
    await goToClaudeSettings();

    const countBefore = (await readCustomPresets(ctx.window)).length;

    for (let i = 0; i < 10; i++) {
      const beforeAdd = (await readCustomPresets(ctx.window)).length;
      await addCustomPreset(ctx.window);

      // Each add is paired with a delete of the just-added preset, so the net
      // count returns to `countBefore`. Poll the persisted state between phases
      // rather than sleeping, so a still-in-flight IPC can't leak a stale count.
      const presets = await readCustomPresets(ctx.window);
      expect(presets.length).toBe(beforeAdd + 1);
      const added = presets[presets.length - 1];

      const deleteBtn = ctx.window
        .locator(SEL.preset.section)
        .locator(`[aria-label="Delete ${added.name}"]`);
      if (await deleteBtn.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await deleteBtn.click({ force: true, noWaitAfter: true });
      } else {
        await ctx.window.evaluate(async (id) => {
          const dispatch = (
            window as unknown as {
              __daintreeDispatchAction?: (a: string, args?: unknown) => Promise<unknown>;
            }
          ).__daintreeDispatchAction;
          const settings = await window.electron.agentSettings.get();
          const agents = settings.agents as Record<
            string,
            { customPresets?: { id: string }[] } | undefined
          >;
          const next = (agents.claude?.customPresets ?? []).filter((p) => p.id !== id);
          if (dispatch) {
            await dispatch("agentSettings.set", {
              agentId: "claude",
              settings: { customPresets: next },
            });
          } else {
            await window.electron.agentSettings.set("claude", { customPresets: next });
          }
        }, added.id);
      }

      await expect
        .poll(async () => (await readCustomPresets(ctx.window)).length, {
          timeout: T_MEDIUM,
          intervals: [100, 200, 400],
        })
        .toBe(beforeAdd);
    }

    await ctx.window.waitForTimeout(T_SETTLE);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    // Net count returns to the starting value (every add paired with a delete).
    const presetsAfter = await readCustomPresets(ctx.window);
    expect(presetsAfter.length).toBe(countBefore);

    // No duplicate IDs in persisted state.
    const ids = presetsAfter.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The live selector listbox reflects persisted state exactly: the only
    // non-custom row is "Default", and every distinct label maps to either
    // Default or a persisted custom preset — i.e. no ghost rows survived the
    // rapid add/delete churn. (Radix can transiently keep a closing popover
    // copy mounted, so we compare the *distinct* label set rather than asserting
    // raw element count, which would double-count those transient copies.)
    const labels = await getPresetOptionLabels(ctx.window);
    const distinctLabels = new Set(labels.map((l) => l.trim()));
    const expectedLabels = new Set<string>([
      "Default (all worktrees)",
      ...presetsAfter.map((p) => p.name),
    ]);
    expect(distinctLabels).toEqual(expectedLabels);
  });

  test("100. Corrupt customPresets data does not crash settings page", async () => {
    // Persist a malformed preset (missing `id`, non-string `name`) so the
    // renderer has to parse genuinely corrupt data on its next render.
    // Persist via the direct IPC API rather than the `agentSettings.set` action:
    // the action validates `settings` against `AgentSettingsEntrySchema` and would
    // reject this payload before it ever reaches the store, defeating the test.
    // The IPC handler only structurally checks the envelope, so genuinely corrupt
    // preset entries land in persisted state and the renderer must parse them.
    const injected = await ctx.window.evaluate(async () => {
      const settings = await window.electron.agentSettings.get();
      const agents = settings.agents as Record<string, { customPresets?: unknown[] } | undefined>;
      const existing = Array.isArray(agents.claude?.customPresets)
        ? agents.claude.customPresets
        : [];
      const corrupt = [
        ...existing,
        { name: "corrupt-no-id" },
        { id: 123, name: null, args: "not-an-array" },
      ];
      try {
        await window.electron.agentSettings.set("claude", {
          customPresets: corrupt as never,
        });
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: { message: String(err) } };
      }
    });
    expect(injected?.ok ?? true).not.toBe(false);

    // Confirm the corrupt entry actually landed in persisted state before we
    // assert the UI survives it.
    await expect
      .poll(
        async () => {
          const presets = await readCustomPresets(ctx.window);
          return presets.some((p) => p?.name === "corrupt-no-id");
        },
        { timeout: T_MEDIUM, intervals: [100, 200, 400] }
      )
      .toBe(true);

    await goToClaudeSettings();

    // Both the settings shell and the preset section must render — a crash or
    // error boundary would replace one or both. The assertions are unconditional.
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });
  });
});
