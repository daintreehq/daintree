import { describe, it, expect } from "vitest";
import { getRecipeTerminalSummary } from "../recipeUtils";
import type { RecipeTerminal } from "@/types";

describe("recipeUtils", () => {
  describe("getRecipeTerminalSummary", () => {
    it("handles empty array", () => {
      const terminals: RecipeTerminal[] = [];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("");
    });

    it("uses custom title when provided", () => {
      const terminals: RecipeTerminal[] = [{ type: "terminal", title: "Build" }];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Build");
    });

    it("uses custom title for agents", () => {
      const terminals: RecipeTerminal[] = [{ type: "claude", title: "Build Claude" }];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Build Claude");
    });

    it("uses custom title for dev-preview", () => {
      const terminals: RecipeTerminal[] = [{ type: "dev-preview", title: "Custom Dev" }];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Custom Dev");
    });

    it("handles empty string title fallback", () => {
      const terminals: RecipeTerminal[] = [
        { type: "terminal", title: "" },
        { type: "claude", title: "" },
        { type: "dev-preview", title: "" },
      ];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Terminal • Claude • Dev server");
    });

    it("uses agent config display names when available", () => {
      const terminals: RecipeTerminal[] = [{ type: "opencode" }];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("OpenCode");
    });

    it("joins multiple terminals with bullet separator", () => {
      const terminals: RecipeTerminal[] = [
        { type: "claude" },
        { type: "terminal", title: "Server" },
        { type: "dev-preview" },
      ];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Claude • Server • Dev server");
    });

    it("shows exactly 5 terminals with overflow indicator", () => {
      const terminals: RecipeTerminal[] = [
        { type: "claude" },
        { type: "gemini" },
        { type: "codex" },
        { type: "terminal" },
        { type: "dev-preview" },
      ];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Claude • Gemini • Codex • Terminal +1");
    });

    it("shows exactly 4 terminals without overflow", () => {
      const terminals: RecipeTerminal[] = [
        { type: "claude" },
        { type: "gemini" },
        { type: "codex" },
        { type: "terminal" },
      ];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Claude • Gemini • Codex • Terminal");
    });
  });
});
