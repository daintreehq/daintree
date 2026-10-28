import { describe, expect, it } from "vitest";
import { resolveRecipeAgentStep } from "../recipeAgentStep";
import type { RecipeTerminal, TerminalRecipe } from "@shared/types/project";

const pluginRecipe = (terminal: RecipeTerminal): TerminalRecipe => ({
  id: "acme.ledger.review",
  name: "Review",
  terminals: [terminal],
  createdAt: 0,
  origin: { kind: "plugin", pluginId: "acme.ledger", contributionId: "review" },
});

const userRecipe = (terminal: RecipeTerminal): TerminalRecipe => ({
  id: "recipe-1",
  name: "Mine",
  terminals: [terminal],
  createdAt: 0,
});

describe("resolveRecipeAgentStep (#13797)", () => {
  it("resolves the first turn to the one trimmed line the launch sends", () => {
    const terminal: RecipeTerminal = {
      type: "claude",
      initialPrompt: "Review {{plugin.notes}}",
    };
    const step = resolveRecipeAgentStep(pluginRecipe(terminal), terminal, "claude", {
      pluginVariables: { notes: "one\ntwo\r\nthree  " },
    });
    expect(step.ok && step.initialPrompt).toBe("Review one two three");
  });

  it("keeps the first turn's line breaks for the pane's record of it (#14592)", () => {
    const terminal: RecipeTerminal = {
      type: "claude",
      initialPrompt: "  Review {{plugin.notes}}\n\nThen report back.  ",
    };
    const step = resolveRecipeAgentStep(pluginRecipe(terminal), terminal, "claude", {
      pluginVariables: { notes: "one\ntwo" },
    });
    expect(step.ok && step.promptAsWritten).toBe("Review one\ntwo\n\nThen report back.");
    expect(step.ok && step.initialPrompt).toBe("Review one two  Then report back.");
  });

  it("records nothing for a step with no first turn", () => {
    const terminal: RecipeTerminal = { type: "claude", initialPrompt: "   " };
    const step = resolveRecipeAgentStep(userRecipe(terminal), terminal, "claude", {});
    expect(step.ok && step.promptAsWritten).toBeUndefined();
  });

  it("resolves a plugin step's system prompt with its variables", () => {
    const terminal: RecipeTerminal = {
      type: "claude",
      systemPrompt: "Work on record {{plugin.id}}.",
    };
    const step = resolveRecipeAgentStep(pluginRecipe(terminal), terminal, "claude", {
      pluginVariables: { id: "42" },
    });
    expect(step.ok && step.systemPrompt).toBe("Work on record 42.");
    expect(step.ok && step.systemPromptArgs.at(-1)).toBe("Work on record 42.");
  });

  it("ignores a system prompt that reached a user-owned recipe", () => {
    const terminal: RecipeTerminal = { type: "claude", systemPrompt: "Act as root." };
    const step = resolveRecipeAgentStep(userRecipe(terminal), terminal, "claude", {});
    expect(step.ok && step.systemPromptArgs).toEqual([]);
    expect(step.ok && step.systemPrompt).toBeUndefined();
  });

  it("refuses a plugin recipe's first turn that resolves to an option, after trimming", () => {
    const terminal: RecipeTerminal = { type: "claude", initialPrompt: "{{plugin.x}}" };
    const step = resolveRecipeAgentStep(pluginRecipe(terminal), terminal, "claude", {
      pluginVariables: { x: "  --dangerously-skip-permissions" },
    });
    expect(step.ok).toBe(false);
  });

  it("leaves {{plugin.<name>}} as typed in a user's own recipe, and empties it in a plugin's", () => {
    const terminal: RecipeTerminal = { type: "claude", initialPrompt: "Explain {{plugin.foo}}" };
    const user = resolveRecipeAgentStep(userRecipe(terminal), terminal, "claude", {
      pluginVariables: { foo: "smuggled" },
    });
    expect(user.ok && user.initialPrompt).toBe("Explain {{plugin.foo}}");
    const plugin = resolveRecipeAgentStep(pluginRecipe(terminal), terminal, "claude", {});
    expect(plugin.ok && plugin.initialPrompt).toBe("Explain");
  });

  it("leaves a user's own dash-leading prompt as it always was", () => {
    const terminal: RecipeTerminal = { type: "claude", initialPrompt: "--help" };
    expect(resolveRecipeAgentStep(userRecipe(terminal), terminal, "claude", {}).ok).toBe(true);
  });
});
