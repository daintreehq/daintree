import { describe, expect, it } from "vitest";
import {
  dispatchCarriesRecipeId,
  dispatchCarriesTerminalCommand,
  readDispatchRecipeId,
  readDispatchTerminalCommand,
  resolveEffectiveActionDanger,
} from "../effectiveDanger";

describe("resolveEffectiveActionDanger (#11860)", () => {
  it("elevates a safe action to confirm when an agent names a recipe", () => {
    expect(resolveEffectiveActionDanger("safe", "agent", { recipeId: "r1" })).toBe("confirm");
  });

  it("leaves the same action alone when the agent names no recipe", () => {
    // This is the whole reason the gate is args-conditional: bumping the
    // declared danger would confirmation-gate every plain worktree creation.
    expect(resolveEffectiveActionDanger("safe", "agent", { branchName: "feat/x" })).toBe("safe");
    expect(resolveEffectiveActionDanger("safe", "agent", undefined)).toBe("safe");
  });

  it("does not elevate for user or plugin sources", () => {
    // A user IS the confirmation. A plugin has no confirm bypass at all, so it
    // is rejected outright by its action's own guard rather than prompted.
    expect(resolveEffectiveActionDanger("safe", "user", { recipeId: "r1" })).toBe("safe");
    expect(resolveEffectiveActionDanger("safe", "plugin", { recipeId: "r1" })).toBe("safe");
  });

  it("never lowers a tier the definition declared for itself", () => {
    for (const source of ["user", "agent", "plugin"] as const) {
      expect(resolveEffectiveActionDanger("confirm", source, {})).toBe("confirm");
      expect(resolveEffectiveActionDanger("restricted", source, { recipeId: "r1" })).toBe(
        "restricted"
      );
    }
  });
});

describe("terminal.new command elevation (#12216)", () => {
  it("elevates a safe action to confirm when an agent supplies a command", () => {
    expect(resolveEffectiveActionDanger("safe", "agent", { command: "npm run build" })).toBe(
      "confirm"
    );
  });

  it("leaves a cwd-only dispatch safe", () => {
    // Opening a terminal somewhere still runs only what the human types —
    // the same authority a plain `terminal.new` already has.
    expect(resolveEffectiveActionDanger("safe", "agent", { cwd: "/repo/packages/ui" })).toBe(
      "safe"
    );
  });

  it("does not elevate for user or plugin sources", () => {
    expect(resolveEffectiveActionDanger("safe", "user", { command: "rm -rf /" })).toBe("safe");
    expect(resolveEffectiveActionDanger("safe", "plugin", { command: "rm -rf /" })).toBe("safe");
  });
});

describe("readDispatchTerminalCommand / dispatchCarriesTerminalCommand", () => {
  it("accepts only a non-empty string command", () => {
    expect(readDispatchTerminalCommand({ command: "ls", cwd: "/repo" })).toBe("ls");
    expect(readDispatchTerminalCommand({ cwd: "/repo" })).toBeUndefined();
    expect(dispatchCarriesTerminalCommand({ command: "ls" })).toBe(true);
    expect(dispatchCarriesTerminalCommand({ command: "" })).toBe(false);
    expect(dispatchCarriesTerminalCommand({ command: 7 })).toBe(false);
    expect(dispatchCarriesTerminalCommand({ command: null })).toBe(false);
  });

  it("ignores non-object argument shapes", () => {
    for (const args of [undefined, null, "command", 42, ["command"]]) {
      expect(dispatchCarriesTerminalCommand(args)).toBe(false);
    }
  });

  it("still gates on a command reached through the prototype chain", () => {
    // Same fail-safe direction as the recipe id: under-gating is the failure
    // that matters.
    const proto: Record<string, unknown> = { command: "inherited" };
    const args: unknown = Object.create(proto);
    expect(dispatchCarriesTerminalCommand(args)).toBe(true);
  });
});

describe("readDispatchRecipeId / dispatchCarriesRecipeId", () => {
  it("returns the id the gate and the preview will both act on", () => {
    // One extraction point for both, so the dispatch that gets gated and the
    // recipe that gets previewed can never be resolved by different rules.
    expect(readDispatchRecipeId({ recipeId: "r1", branchName: "x" })).toBe("r1");
    expect(readDispatchRecipeId({ branchName: "x" })).toBeUndefined();
    expect(readDispatchRecipeId({ recipeId: "" })).toBeUndefined();
  });

  it("accepts only a non-empty string id", () => {
    expect(dispatchCarriesRecipeId({ recipeId: "r1" })).toBe(true);
    expect(dispatchCarriesRecipeId({ recipeId: "" })).toBe(false);
    expect(dispatchCarriesRecipeId({ recipeId: 7 })).toBe(false);
    expect(dispatchCarriesRecipeId({ recipeId: null })).toBe(false);
    expect(dispatchCarriesRecipeId({ recipeId: undefined })).toBe(false);
  });

  it("ignores non-object argument shapes", () => {
    for (const args of [undefined, null, "recipeId", 42, ["recipeId"]]) {
      expect(dispatchCarriesRecipeId(args)).toBe(false);
    }
  });

  it("still gates on a recipeId reached through the prototype chain", () => {
    // Fail-safe direction: an inherited id elevates to confirm rather than
    // slipping past. Under-gating is the failure that matters here.
    const proto: Record<string, unknown> = { recipeId: "inherited" };
    const args: unknown = Object.create(proto);
    expect(dispatchCarriesRecipeId(args)).toBe(true);
  });
});
