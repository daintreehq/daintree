import { describe, it, expect } from "vitest";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";

const APPEARANCE_SUBTAB_IDS = ["app", "terminal"];

describe("TerminalAppearanceTab subtab derivation logic", () => {
  function deriveEffectiveSubtab(activeSubtab: string | null): string {
    return activeSubtab && APPEARANCE_SUBTAB_IDS.includes(activeSubtab) ? activeSubtab : "app";
  }

  it('defaults to "app" when activeSubtab is null', () => {
    expect(deriveEffectiveSubtab(null)).toBe("app");
  });

  it('returns "app" when activeSubtab is "app"', () => {
    expect(deriveEffectiveSubtab("app")).toBe("app");
  });

  it('returns "terminal" when activeSubtab is "terminal"', () => {
    expect(deriveEffectiveSubtab("terminal")).toBe("terminal");
  });

  it('falls back to "app" for unknown subtab id', () => {
    expect(deriveEffectiveSubtab("unknown")).toBe("app");
  });

  it('falls back to "app" for case-mismatch ("App" !== "app")', () => {
    expect(deriveEffectiveSubtab("App")).toBe("app");
  });

  it('falls back to "app" for empty string', () => {
    expect(deriveEffectiveSubtab("")).toBe("app");
  });
});

describe("Appearance tab search index subtab metadata", () => {
  const appearanceFieldEntries = SETTINGS_SEARCH_INDEX.filter(
    (e) => e.tab === "terminalAppearance" && !e.id.startsWith("tab-nav-")
  );

  it("has exactly 6 appearance field entries", () => {
    expect(appearanceFieldEntries).toHaveLength(6);
  });

  it("all Appearance field entries have valid subtab metadata", () => {
    const validSubtabs = new Set(APPEARANCE_SUBTAB_IDS);
    const validLabels = new Set(["App", "Terminal"]);
    for (const entry of appearanceFieldEntries) {
      expect(
        validSubtabs.has(entry.subtab!),
        `entry "${entry.id}" subtab "${entry.subtab}" should be a known subtab id`
      ).toBe(true);
      expect(
        validLabels.has(entry.subtabLabel!),
        `entry "${entry.id}" subtabLabel "${entry.subtabLabel}" should be a known label`
      ).toBe(true);
    }
  });

  it("app entries map to app subtab", () => {
    const appIds = ["appearance-theme", "appearance-color-vision", "appearance-dock-density"];
    for (const id of appIds) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id);
      expect(entry?.subtab).toBe("app");
      expect(entry?.subtabLabel).toBe("App");
    }
  });

  it("terminal entries map to terminal subtab", () => {
    const terminalIds = [
      "appearance-color-scheme",
      "appearance-font-size",
      "appearance-font-family",
    ];
    for (const id of terminalIds) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id);
      expect(entry?.subtab).toBe("terminal");
      expect(entry?.subtabLabel).toBe("Terminal");
    }
  });

  it("tab-nav-terminalAppearance entry does not have subtab or subtabLabel", () => {
    const navEntry = SETTINGS_SEARCH_INDEX.find((e) => e.id === "tab-nav-terminalAppearance");
    expect(navEntry?.subtab).toBeUndefined();
    expect(navEntry?.subtabLabel).toBeUndefined();
  });
});
