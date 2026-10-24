import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  revertSettingsPatch,
  saveGroupOf,
} from "../assistantSettingsModel";

describe("assistantSettingsModel", () => {
  it("files a patch under the group of its first key", () => {
    expect(saveGroupOf({ customArgs: "--x" })).toBe("launch");
    expect(saveGroupOf({ tier: "full" })).toBe("security");
    expect(saveGroupOf({ auditRetention: 30 })).toBe("privacy");
    expect(saveGroupOf({})).toBe("agent");
  });

  it("merges model entries per agent and removes an entry patched to null", () => {
    const current = { ...DEFAULT_SETTINGS, modelIds: { claude: "opus", codex: "gpt" } };
    const next = applySettingsPatch(current, { modelIds: { claude: null, gemini: "pro" } });
    expect(next.modelIds).toEqual({ codex: "gpt", gemini: "pro" });
  });

  it("rolls back only the failed key, and leaves a newer edit alone", () => {
    const previous = { ...DEFAULT_SETTINGS };
    const patch = { tier: "full" as const };
    const applied = applySettingsPatch(previous, patch);
    const withOtherEdit = { ...applied, docSearch: false };
    expect(revertSettingsPatch(withOtherEdit, previous, patch)).toEqual({
      ...previous,
      docSearch: false,
    });

    const movedOn = { ...applied, tier: "core" as const, customArgs: "--later" };
    expect(revertSettingsPatch(movedOn, previous, { customArgs: "--first" })).toEqual(movedOn);
  });

  it("restores a failed model choice without touching another agent's", () => {
    const previous = { ...DEFAULT_SETTINGS, modelIds: { claude: "sonnet" } };
    const patch = { modelIds: { claude: "opus" } };
    const current = applySettingsPatch(applySettingsPatch(previous, patch), {
      modelIds: { codex: "gpt" },
    });
    expect(revertSettingsPatch(current, previous, patch).modelIds).toEqual({
      claude: "sonnet",
      codex: "gpt",
    });
  });
});
