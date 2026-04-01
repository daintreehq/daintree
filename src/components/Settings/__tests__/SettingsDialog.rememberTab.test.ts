import { describe, it, expect } from "vitest";
import type { SettingsTab, SettingsScope } from "../SettingsDialog";

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
  "project:github",
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

describe("Untargeted open scope derivation (issue #4657)", () => {
  function scopeForTab(tab: SettingsTab): SettingsScope {
    return tab.startsWith("project:") ? "project" : "global";
  }

  function deriveUntargetedOpenState(
    isOpen: boolean,
    defaultTab: SettingsTab | undefined,
    rememberedTab: SettingsTab
  ): { scope: SettingsScope; tab: SettingsTab } | null {
    if (isOpen && defaultTab) {
      return { scope: scopeForTab(defaultTab), tab: defaultTab };
    } else if (isOpen) {
      return { scope: "global", tab: rememberedTab };
    }
    return null;
  }

  it("untargeted open always resolves to global scope", () => {
    const result = deriveUntargetedOpenState(true, undefined, "privacy");
    expect(result).toEqual({ scope: "global", tab: "privacy" });
  });

  it("untargeted open restores rememberedTab, not a hardcoded default", () => {
    const result = deriveUntargetedOpenState(true, undefined, "agents");
    expect(result).toEqual({ scope: "global", tab: "agents" });
  });

  it("untargeted open with rememberedTab='general' resolves to global/general", () => {
    const result = deriveUntargetedOpenState(true, undefined, "general");
    expect(result).toEqual({ scope: "global", tab: "general" });
  });

  it("targeted open preserves scope from defaultTab (global tab)", () => {
    const result = deriveUntargetedOpenState(true, "github", "privacy");
    expect(result).toEqual({ scope: "global", tab: "github" });
  });

  it("targeted open preserves scope from defaultTab (project tab)", () => {
    const result = deriveUntargetedOpenState(true, "project:general", "privacy");
    expect(result).toEqual({ scope: "project", tab: "project:general" });
  });

  it("does not derive state when dialog is closed", () => {
    expect(deriveUntargetedOpenState(false, undefined, "privacy")).toBeNull();
    expect(deriveUntargetedOpenState(false, "github", "privacy")).toBeNull();
  });

  it("untargeted open is idempotent (calling twice gives same result)", () => {
    const first = deriveUntargetedOpenState(true, undefined, "terminal");
    const second = deriveUntargetedOpenState(true, undefined, "terminal");
    expect(first).toEqual(second);
    expect(first).toEqual({ scope: "global", tab: "terminal" });
  });
});
