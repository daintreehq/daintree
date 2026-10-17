import { describe, it, expect } from "vitest";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";

const GENERAL_SUBTAB_IDS = ["overview", "hibernation", "display"];

describe("General tab search index subtab metadata", () => {
  const generalFieldEntries = SETTINGS_SEARCH_INDEX.filter(
    (e) => e.tab === "general" && e.kind === "section"
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
});
