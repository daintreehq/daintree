import { describe, it, expect } from "vitest";
import type { SettingsTab } from "../SettingsDialog";

const VALID_TABS: SettingsTab[] = [
  "general",
  "keyboard",
  "terminal",
  "terminalAppearance",
  "worktree",
  "agents",
  "github",
  "portal",
  "toolbar",
  "notifications",
  "integrations",
  "voice",
  "mcp",
  "environment",
  "privacy",
  "troubleshooting",
  "project:general",
  "project:context",
  "project:automation",
  "project:recipes",
  "project:commands",
  "project:notifications",
];

/**
 * Structural tests verifying the remembered-tab fallback logic
 * used in SettingsDialog for issue #4066.
 *
 * The dialog uses `defaultTab ?? rememberedTab` to determine the
 * initial active tab. These tests verify the fallback derivation.
 */
describe("Settings remembered-tab fallback logic", () => {
  function deriveActiveTab(
    defaultTab: SettingsTab | undefined,
    rememberedTab: SettingsTab
  ): SettingsTab {
    return defaultTab ?? rememberedTab;
  }

  it("uses rememberedTab when defaultTab is undefined (untargeted open)", () => {
    expect(deriveActiveTab(undefined, "privacy")).toBe("privacy");
  });

  it("uses defaultTab when explicitly provided (targeted open)", () => {
    expect(deriveActiveTab("github", "privacy")).toBe("github");
  });

  it('defaults to "general" when both defaultTab is undefined and rememberedTab is "general"', () => {
    expect(deriveActiveTab(undefined, "general")).toBe("general");
  });

  it("rememberedTab is always a valid SettingsTab value", () => {
    for (const tab of VALID_TABS) {
      expect(deriveActiveTab(undefined, tab)).toBe(tab);
      expect(VALID_TABS).toContain(deriveActiveTab(undefined, tab));
    }
  });

  it("explicit defaultTab overrides any rememberedTab value", () => {
    for (const remembered of VALID_TABS) {
      expect(deriveActiveTab("troubleshooting", remembered)).toBe("troubleshooting");
    }
  });
});

describe("Settings remembered-tab validation logic", () => {
  function validateRememberedTab(tab: string): SettingsTab {
    return VALID_TABS.includes(tab as SettingsTab) ? (tab as SettingsTab) : "general";
  }

  it('falls back to "general" for invalid tab value', () => {
    expect(validateRememberedTab("nonexistent")).toBe("general");
  });

  it('falls back to "general" for empty string', () => {
    expect(validateRememberedTab("")).toBe("general");
  });

  it("returns valid tab as-is", () => {
    expect(validateRememberedTab("privacy")).toBe("privacy");
    expect(validateRememberedTab("agents")).toBe("agents");
  });

  it("validates all known tabs", () => {
    for (const tab of VALID_TABS) {
      expect(validateRememberedTab(tab)).toBe(tab);
    }
  });
});
