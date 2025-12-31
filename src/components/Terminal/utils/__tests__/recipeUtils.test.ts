import { describe, it, expect } from "vitest";
import { getRecipeGridClasses, getRecipeTerminalSummary } from "../recipeUtils";
import type { RecipeTerminal } from "@/types";

describe("recipeUtils", () => {
  describe("getRecipeGridClasses", () => {
    it("returns centered single column for 1 recipe", () => {
      const classes = getRecipeGridClasses(1);
      expect(classes).toContain("grid-cols-1");
      expect(classes).toContain("max-w-md");
      expect(classes).toContain("mx-auto");
    });

    it("handles zero recipes", () => {
      const classes = getRecipeGridClasses(0);
      expect(classes).toContain("grid");
      expect(classes).toContain("grid-cols-1");
    });

    it("returns two-column grid for 2 recipes", () => {
      const classes = getRecipeGridClasses(2);
      expect(classes).toContain("sm:grid-cols-2");
    });

    it("returns three-column grid for 3 recipes", () => {
      const classes = getRecipeGridClasses(3);
      expect(classes).toContain("md:grid-cols-3");
    });

    it("returns two-column grid for 4 recipes", () => {
      const classes = getRecipeGridClasses(4);
      expect(classes).toContain("sm:grid-cols-2");
      expect(classes).not.toContain("md:grid-cols-3");
    });

    it("returns three-column grid for 5+ recipes", () => {
      const classes = getRecipeGridClasses(5);
      expect(classes).toContain("md:grid-cols-3");

      const classes6 = getRecipeGridClasses(6);
      expect(classes6).toContain("md:grid-cols-3");
    });
  });

  describe("getRecipeTerminalSummary", () => {
    it("handles empty array", () => {
      const terminals: RecipeTerminal[] = [];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("");
    });

    it("returns single terminal label", () => {
      const terminals: RecipeTerminal[] = [{ type: "terminal" }];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Terminal");
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
      expect(summary).toBe("Terminal • Claude • Dev Server");
    });

    it("formats agent names with proper capitalization", () => {
      const terminals: RecipeTerminal[] = [
        { type: "claude" },
        { type: "gemini" },
        { type: "codex" },
      ];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Claude • Gemini • Codex");
    });

    it("handles dev-preview terminals", () => {
      const terminals: RecipeTerminal[] = [{ type: "dev-preview" }];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Dev Server");
    });

    it("joins multiple terminals with bullet separator", () => {
      const terminals: RecipeTerminal[] = [
        { type: "claude" },
        { type: "terminal", title: "Server" },
        { type: "dev-preview" },
      ];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Claude • Server • Dev Server");
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

    it("truncates and shows overflow count when more than 4 terminals", () => {
      const terminals: RecipeTerminal[] = [
        { type: "claude" },
        { type: "terminal", title: "Server" },
        { type: "dev-preview" },
        { type: "gemini" },
        { type: "terminal", title: "Extra 1" },
        { type: "terminal", title: "Extra 2" },
      ];
      const summary = getRecipeTerminalSummary(terminals);
      expect(summary).toBe("Claude • Server • Dev Server • Gemini +2");
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
