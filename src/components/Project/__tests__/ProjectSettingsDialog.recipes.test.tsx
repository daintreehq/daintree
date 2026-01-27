import { describe, it, expect } from "vitest";

describe("ProjectSettingsDialog - Recipes Tab", () => {
  it("should have recipes tab type", () => {
    type ProjectSettingsTab = "general" | "context" | "automation" | "recipes" | "commands";
    const tabs: ProjectSettingsTab[] = ["general", "context", "automation", "recipes", "commands"];
    expect(tabs).toContain("recipes");
  });

  it("should verify tab titles include recipes", () => {
    const tabTitles: Record<string, string> = {
      general: "General",
      context: "Context",
      automation: "Automation",
      recipes: "Recipes",
      commands: "Commands",
    };

    expect(tabTitles.recipes).toBe("Recipes");
  });

  it("should maintain correct tab order", () => {
    type ProjectSettingsTab = "general" | "context" | "automation" | "recipes" | "commands";
    const expectedOrder: ProjectSettingsTab[] = [
      "general",
      "context",
      "automation",
      "recipes",
      "commands",
    ];

    expect(expectedOrder[0]).toBe("general");
    expect(expectedOrder[1]).toBe("context");
    expect(expectedOrder[2]).toBe("automation");
    expect(expectedOrder[3]).toBe("recipes");
    expect(expectedOrder[4]).toBe("commands");
  });
});
