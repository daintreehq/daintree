import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  removeCcrConfig,
  writeCcrConfig,
  waitForCcrPresets,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

interface PresetSnapshot {
  customCount: number;
  presetId: string | null;
  names: string[];
}

async function readPresetState(window: Page, agentId = "claude"): Promise<PresetSnapshot> {
  return window.evaluate(async (id): Promise<PresetSnapshot> => {
    const settings = await window.electron.agentSettings.get();
    const entry = settings.agents?.[id];
    const presets = Array.isArray(entry?.customPresets) ? entry.customPresets : [];
    return {
      customCount: presets.length,
      presetId: entry?.presetId ?? null,
      names: presets.map((p) =>
        p && typeof p === "object" && "name" in p
          ? String((p as { name: unknown }).name)
          : String(p)
      ),
    };
  }, agentId);
}

test.describe.serial("Adversarial E2E Tests: System Breakage", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "adversarial-e2e" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Adversarial E2E Test"
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

  const openFirstPresetEditor = async () => {
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_SHORT });
    const input = section.locator("[data-testid='preset-edit-input']");
    if (await input.isVisible({ timeout: 500 }).catch(() => false)) return input;

    const editButtons = section.locator(SEL.preset.editButton);
    await expect(editButtons.first()).toBeVisible({ timeout: T_SHORT });
    const count = await editButtons.count();
    for (let i = 0; i < count; i += 1) {
      const editBtn = editButtons.nth(i);
      if (!(await editBtn.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await editBtn.scrollIntoViewIfNeeded().catch(() => undefined);
      await editBtn.click({ force: true, noWaitAfter: true });
      if (await input.isVisible({ timeout: 1000 }).catch(() => false)) return input;
    }

    throw new Error("No custom preset edit input opened");
  };

  test("XSS attempt via preset names", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);

    // Sentinel: if the injected markup were ever parsed as HTML and executed,
    // the inline script would flip this flag.
    await ctx.window.evaluate(() => {
      (window as unknown as { __xssFired?: boolean }).__xssFired = false;
    });

    const payload = "<script>window.__xssFired = true</script>";
    const input = await openFirstPresetEditor();
    await input.fill(payload);
    await input.press("Enter");

    // handleCommitEdit rejects any name containing [<>'"&], so the dangerous
    // markup must NEVER reach the persisted store. Wait for the edit to settle
    // (the input collapses back to the rename button) and assert the raw
    // <script> payload is absent from every stored preset name.
    await expect(input).toBeHidden({ timeout: T_MEDIUM });
    await expect
      .poll(async () => (await readPresetState(ctx.window)).names, { timeout: T_MEDIUM })
      .not.toContain(payload);

    const fired = await ctx.window.evaluate(
      () => (window as unknown as { __xssFired?: boolean }).__xssFired
    );
    expect(fired).toBe(false);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible();
  });

  test("Resource exhaustion via massive preset creation", async () => {
    await goToClaudeSettings();

    // Try to create many presets rapidly
    const presetCount = process.env.CI ? 10 : 100;
    for (let i = 0; i < presetCount; i++) {
      await addCustomPreset(ctx.window);
      // Don't wait - stress test rapid creation
    }

    // Check if UI becomes unresponsive
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_LONG }); // Should handle it gracefully
  });

  test("Race condition: CCR config changes during UI interaction", async () => {
    await goToClaudeSettings();

    const before = await readPresetState(ctx.window);

    // Start editing a preset
    const input = await openFirstPresetEditor();
    await input.fill("Race Condition Test");

    // Change CCR config while editing
    writeCcrConfig([{ id: "race", name: "Race Preset", model: "race-model" }]);

    // Try to commit the edit
    await input.press("Enter");
    await waitForCcrPresets(ctx.window, ["Race Preset"]);

    // The race must resolve to a consistent persisted state: the custom preset
    // count must not have shrunk, and the in-flight rename either committed
    // (the new name is present) or was discarded (the original name kept) —
    // never a deadlocked/duplicated store.
    await navigateToAgentSettings(ctx.window, "claude");
    await expect
      .poll(async () => (await readPresetState(ctx.window)).customCount, { timeout: T_MEDIUM })
      .toBeGreaterThanOrEqual(before.customCount);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible();
  });

  test("Corrupted persisted settings render gracefully", async () => {
    // Corrupt the real IPC-backed settings store, not the inert localStorage
    // key. Write a structurally invalid customPresets payload (wrong shapes /
    // missing required fields) through the persistence bridge.
    const setResult = await ctx.window.evaluate(async () => {
      type SetFn = (agentId: string, settings: Record<string, unknown>) => Promise<unknown>;
      const set = (window.electron.agentSettings as unknown as { set: SetFn }).set;
      try {
        await set("claude", {
          presetId: 12345 as unknown as string,
          customPresets: [null, "not-an-object", { name: 42 }] as unknown,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    // Force the settings UI to re-read from the corrupted persisted value.
    await navigateToAgentSettings(ctx.window, "gemini");
    await navigateToAgentSettings(ctx.window, "claude");

    // App must still render the preset section regardless of how the store
    // sanitized or rejected the malformed payload.
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    // The write either sanitized or rejected the payload — both are graceful;
    // what matters is the bridge answered (didn't hang) and left a readable store.
    expect(typeof setResult.ok).toBe("boolean");
    const recovered = await readPresetState(ctx.window);
    expect(Number.isFinite(recovered.customCount)).toBe(true);
  });

  test("Unicode and emoji attacks in preset names", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);

    // Try various unicode attacks. Pressing Enter commits (or rejects) the
    // edit and collapses the input back to a button, so each attack needs
    // its own click-into-edit cycle.
    const attacks = [
      "🚀".repeat(1000), // Many emojis
      "\u0000\u0001\u0002", // Null bytes
      "𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙", // Mathematical alphanumeric
      "ด้้้้้็็็็็้้้้้็็็็็้้้้้้้้็็็็็้้้้้็็็็็้้้้้้้้็็็็็้้้้้็็็็็้้้้้้้้็็็็็้้้้้็็็็็", // Zalgo text
    ];

    for (const attack of attacks) {
      const countBefore = (await readPresetState(ctx.window)).customCount;
      const input = await openFirstPresetEditor();
      await input.fill(attack);
      await input.press("Enter");
      // Wait for the rename to settle in the persisted store before the next
      // edit cycle, so openFirstPresetEditor() never races a pending re-render.
      // A rejected name leaves the count unchanged; either way the store
      // stabilizes at >= the prior count.
      await expect
        .poll(async () => (await readPresetState(ctx.window)).customCount, { timeout: T_MEDIUM })
        .toBeGreaterThanOrEqual(countBefore);
    }

    // UI should handle all gracefully
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible();
  });

  test("IPC message bombing", async () => {
    // Fire 100 concurrent IPC round-trips and actually await every one, so a
    // crash, hang, or rejection under load surfaces instead of being dropped.
    const settled = await ctx.window.evaluate(async () => {
      const calls = Array.from({ length: 100 }, () =>
        window.electron.agentCapabilities.getCcrPresets()
      );
      const results = await Promise.allSettled(calls);
      return {
        total: results.length,
        fulfilled: results.filter((r) => r.status === "fulfilled").length,
        rejected: results.filter((r) => r.status === "rejected").length,
      };
    });

    expect(settled.total).toBe(100);
    expect(settled.rejected).toBe(0);
    expect(settled.fulfilled).toBe(100);

    // The bridge must still answer after the burst — proves the IPC channel
    // wasn't wedged by the overload.
    await expect
      .poll(
        () =>
          ctx.window.evaluate(async () => {
            const presets = await window.electron.agentCapabilities.getCcrPresets();
            return Array.isArray(presets);
          }),
        { timeout: T_MEDIUM }
      )
      .toBe(true);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible();
  });

  test("Settings navigation during async operations", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);

    // Start editing
    await openFirstPresetEditor();

    // Navigate away while edit is pending
    await navigateToAgentSettings(ctx.window, "gemini");

    // Come back
    await navigateToAgentSettings(ctx.window, "claude");

    // UI should be in consistent state
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible();
  });

  test("Settings reset clears persisted presets and falls back to defaults", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    expect((await readPresetState(ctx.window)).customCount).toBeGreaterThan(0);

    // Reset the real IPC-backed store (not the inert localStorage key) to
    // exercise the missing-config recovery path.
    const resetResult = await ctx.window.evaluate(async () => {
      type ResetFn = (agentId?: string) => Promise<unknown>;
      const reset = (window.electron.agentSettings as unknown as { reset: ResetFn }).reset;
      try {
        await reset("claude");
        return true;
      } catch {
        return false;
      }
    });
    expect(resetResult).toBe(true);

    // Re-read from the cleared store via a fresh navigation.
    await navigateToAgentSettings(ctx.window, "gemini");
    await navigateToAgentSettings(ctx.window, "claude");

    // No custom presets should remain, and the section must still render its
    // default chrome rather than crash on the empty config.
    await expect
      .poll(async () => (await readPresetState(ctx.window)).customCount, { timeout: T_MEDIUM })
      .toBe(0);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });
  });
});
