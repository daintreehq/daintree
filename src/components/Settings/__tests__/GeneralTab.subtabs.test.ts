import { describe, it, expect } from "vitest";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";

const GENERAL_SUBTAB_IDS = ["overview", "hibernation", "display"];

/**
 * Structural tests verifying the controlled subtab API contract for GeneralTab.
 *
 * GeneralTab has three subtabs: "overview", "hibernation", and "display".
 * These tests verify the derivation logic used inside the component.
 */
describe("GeneralTab subtab derivation logic", () => {
  function deriveEffectiveSubtab(activeSubtab: string | null): string {
    return activeSubtab && GENERAL_SUBTAB_IDS.includes(activeSubtab) ? activeSubtab : "overview";
  }

  it('defaults to "overview" when activeSubtab is null', () => {
    expect(deriveEffectiveSubtab(null)).toBe("overview");
  });

  it('returns "overview" when activeSubtab is "overview"', () => {
    expect(deriveEffectiveSubtab("overview")).toBe("overview");
  });

  it('returns "hibernation" when activeSubtab is "hibernation"', () => {
    expect(deriveEffectiveSubtab("hibernation")).toBe("hibernation");
  });

  it('returns "display" when activeSubtab is "display"', () => {
    expect(deriveEffectiveSubtab("display")).toBe("display");
  });

  it('falls back to "overview" for unknown subtab id', () => {
    expect(deriveEffectiveSubtab("unknown")).toBe("overview");
  });

  it('falls back to "overview" for case-mismatch ("Overview" !== "overview")', () => {
    expect(deriveEffectiveSubtab("Overview")).toBe("overview");
  });

  it('falls back to "overview" for empty string', () => {
    expect(deriveEffectiveSubtab("")).toBe("overview");
  });
});

describe("General tab search index subtab metadata", () => {
  const generalFieldEntries = SETTINGS_SEARCH_INDEX.filter(
    (e) => e.tab === "general" && !e.id.startsWith("tab-nav-")
  );

  it("all General field entries have valid subtab metadata", () => {
    const validSubtabs = new Set(GENERAL_SUBTAB_IDS);
    const validLabels = new Set(["Overview", "Hibernation", "Display"]);
    for (const entry of generalFieldEntries) {
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

  it("overview entries map to overview subtab", () => {
    const overviewIds = ["general-about", "general-system-status"];
    for (const id of overviewIds) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id);
      expect(entry?.subtab).toBe("overview");
      expect(entry?.subtabLabel).toBe("Overview");
    }
  });

  it("hibernation entries map to hibernation subtab", () => {
    const hibernationIds = ["general-hibernation", "general-hibernation-threshold"];
    for (const id of hibernationIds) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id);
      expect(entry?.subtab).toBe("hibernation");
      expect(entry?.subtabLabel).toBe("Hibernation");
    }
  });

  it("display entries map to display subtab", () => {
    const displayIds = [
      "general-project-pulse",
      "general-developer-tools",
      "general-grid-agent-highlights",
      "general-dock-agent-highlights",
    ];
    for (const id of displayIds) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id);
      expect(entry?.subtab).toBe("display");
      expect(entry?.subtabLabel).toBe("Display");
    }
  });

  it("tab-nav-general entry does not have subtab", () => {
    const navEntry = SETTINGS_SEARCH_INDEX.find((e) => e.id === "tab-nav-general");
    expect(navEntry?.subtab).toBeUndefined();
  });
});
