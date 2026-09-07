import { describe, it, expect } from "vitest";
import {
  detectRecipeForwardIncompat,
  describeRecipeForwardIncompat,
} from "../recipeCompatibility.js";

const cleanRecipe = () => ({
  id: "r1",
  name: "Build",
  terminals: [{ type: "terminal", command: "npm run dev" }],
  createdAt: 1,
});

describe("detectRecipeForwardIncompat", () => {
  it("returns null for a recipe this build fully understands", () => {
    expect(detectRecipeForwardIncompat(cleanRecipe())).toBeNull();
  });

  it("returns null for non-objects rather than throwing", () => {
    expect(detectRecipeForwardIncompat(undefined)).toBeNull();
    expect(detectRecipeForwardIncompat(null)).toBeNull();
    expect(detectRecipeForwardIncompat("nope")).toBeNull();
    expect(detectRecipeForwardIncompat([1, 2])).toBeNull();
  });

  it("treats every declared field as known, including ones never written to disk", () => {
    // agentModelId/agentLaunchFlags/location are transient and stripped before
    // persistence — a file carrying one is ordinary data, not a newer schema (#9654).
    const recipe = {
      ...cleanRecipe(),
      projectId: "p",
      worktreeId: "w",
      showInEmptyState: true,
      lastUsedAt: 5,
      usageHistory: [1],
      autoAssign: "prompt",
      shadowedBy: "other",
      scope: "inrepo",
      origin: { kind: "plugin", pluginId: "a", contributionId: "b" },
      terminals: [
        {
          type: "terminal",
          title: "t",
          command: "c",
          env: { A: "1" },
          initialPrompt: "p",
          args: "--x",
          devCommand: "d",
          exitBehavior: "keep",
          agentModelId: "m",
          agentLaunchFlags: ["--f"],
          location: "dock",
        },
      ],
    };
    expect(detectRecipeForwardIncompat(recipe)).toBeNull();
  });

  it("reports unknown top-level recipe keys, sorted", () => {
    const loss = detectRecipeForwardIncompat({ ...cleanRecipe(), zeta: 1, alpha: 2 });
    expect(loss?.unknownRecipeKeys).toEqual(["alpha", "zeta"]);
    expect(loss?.unknownTerminalKeys).toEqual([]);
    expect(loss?.unsupportedTerminals).toEqual([]);
  });

  it("reports unknown terminal keys against the original on-disk index", () => {
    const loss = detectRecipeForwardIncompat({
      ...cleanRecipe(),
      terminals: [
        { type: "terminal" },
        { type: "terminal", retryPolicy: "always" },
        { type: "terminal" },
      ],
    });
    expect(loss?.unknownTerminalKeys).toEqual([{ index: 1, keys: ["retryPolicy"] }]);
  });

  it("reports a well-formed but unrecognized terminal type", () => {
    const loss = detectRecipeForwardIncompat({
      ...cleanRecipe(),
      terminals: [{ type: "terminal" }, { type: "future-agent" }],
    });
    expect(loss?.unsupportedTerminals).toEqual([{ index: 1, type: "future-agent" }]);
  });

  it("keeps original indices when an earlier terminal is itself unsupported", () => {
    // Indices must survive filtering — they point the user at entries in a file
    // they may go and open, not at the sanitized in-memory array.
    const loss = detectRecipeForwardIncompat({
      ...cleanRecipe(),
      terminals: [{ type: "future-agent" }, { type: "terminal", extra: 1 }],
    });
    expect(loss?.unsupportedTerminals).toEqual([{ index: 0, type: "future-agent" }]);
    expect(loss?.unknownTerminalKeys).toEqual([{ index: 1, keys: ["extra"] }]);
  });

  it("honours additionalAllowedTypes so plugin agent types are not flagged", () => {
    const terminals = [{ type: "acme-agent" }];
    expect(detectRecipeForwardIncompat({ ...cleanRecipe(), terminals })).not.toBeNull();
    expect(
      detectRecipeForwardIncompat(
        { ...cleanRecipe(), terminals },
        { additionalAllowedTypes: new Set(["acme-agent"]) }
      )
    ).toBeNull();
  });

  it("ignores a missing, empty or non-string type as malformed rather than newer", () => {
    const loss = detectRecipeForwardIncompat({
      ...cleanRecipe(),
      terminals: [{}, { type: "" }, { type: 7 }],
    });
    expect(loss).toBeNull();
  });

  it("does not treat a security-rejected terminal as a compatibility problem", () => {
    // A control-char command is dropped by the sanitizer for injection safety
    // (#9160). That is not version skew, and flagging it here would let a
    // crafted file permanently block saves.
    expect(
      detectRecipeForwardIncompat({
        ...cleanRecipe(),
        terminals: [{ type: "terminal", command: "echo\nrm -rf /" }],
      })
    ).toBeNull();
  });

  it("does not descend into env, so env keys are never read as recipe fields", () => {
    expect(
      detectRecipeForwardIncompat({
        ...cleanRecipe(),
        terminals: [{ type: "terminal", env: { SOMETHING_UNKNOWN: "x" } }],
      })
    ).toBeNull();
  });

  it("reports valid terminals the per-recipe cap would discard on write-back", () => {
    // The cap is a spawn-safety limit, but the reader applies it before the
    // recipe reaches memory — so saving deletes the overflow from the file too.
    const terminals = Array.from({ length: 12 }, (_, i) => ({
      type: "terminal",
      command: `echo ${i}`,
    }));
    const loss = detectRecipeForwardIncompat({ ...cleanRecipe(), terminals });
    expect(loss?.cappedTerminalCount).toBe(2);
    expect(loss?.unknownRecipeKeys).toEqual([]);
    expect(loss?.unsupportedTerminals).toEqual([]);
  });

  it("counts only terminals the cap discards, not ones the sanitizer rejects", () => {
    // 11 entries, but one is rejected for a control-char command — 10 survive,
    // which is exactly the cap, so nothing is lost to it.
    const terminals = [
      ...Array.from({ length: 10 }, (_, i) => ({ type: "terminal", command: `echo ${i}` })),
      { type: "terminal", command: "echo\nrm -rf /" },
    ];
    expect(detectRecipeForwardIncompat({ ...cleanRecipe(), terminals })).toBeNull();
  });

  it("reports nothing for a recipe exactly at the cap", () => {
    const terminals = Array.from({ length: 10 }, (_, i) => ({
      type: "terminal",
      command: `echo ${i}`,
    }));
    expect(detectRecipeForwardIncompat({ ...cleanRecipe(), terminals })).toBeNull();
  });

  it("leaves the inspected object untouched", () => {
    const recipe = { ...cleanRecipe(), mystery: 1 };
    const snapshot = JSON.stringify(recipe);
    detectRecipeForwardIncompat(recipe);
    expect(JSON.stringify(recipe)).toBe(snapshot);
  });
});

describe("describeRecipeForwardIncompat", () => {
  it("renders terminal positions 1-based and names the foreign type", () => {
    const loss = detectRecipeForwardIncompat({
      ...cleanRecipe(),
      terminals: [{ type: "terminal" }, { type: "future-agent" }],
    })!;
    expect(describeRecipeForwardIncompat(loss)).toBe('terminal #2 (type "future-agent")');
  });

  it("covers all three loss modes in one description", () => {
    const loss = detectRecipeForwardIncompat({
      ...cleanRecipe(),
      ritual: true,
      terminals: [{ type: "future-agent" }, { type: "terminal", retryPolicy: "always" }],
    })!;
    const described = describeRecipeForwardIncompat(loss);
    expect(described).toContain('terminal #1 (type "future-agent")');
    expect(described).toContain("unknown terminal fields — #2: retryPolicy");
    expect(described).toContain("unknown recipe fields — ritual");
  });

  it("names the cap overflow", () => {
    const loss = detectRecipeForwardIncompat({
      ...cleanRecipe(),
      terminals: Array.from({ length: 11 }, () => ({ type: "terminal", command: "x" })),
    })!;
    expect(describeRecipeForwardIncompat(loss)).toBe("1 terminal(s) past the 10-terminal limit");
  });

  it("never reveals values, only shape", () => {
    const loss = detectRecipeForwardIncompat({
      ...cleanRecipe(),
      secretToken: "hunter2",
      terminals: [{ type: "terminal", futureField: "s3cret" }],
    })!;
    const described = describeRecipeForwardIncompat(loss);
    expect(described).toContain("secretToken");
    expect(described).toContain("futureField");
    expect(described).not.toContain("hunter2");
    expect(described).not.toContain("s3cret");
  });
});
