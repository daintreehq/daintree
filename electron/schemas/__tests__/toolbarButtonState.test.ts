import { describe, it, expect } from "vitest";
import {
  PluginToolbarButtonRuntimeStateSchema,
  ToolbarButtonContributionSchema,
} from "../plugin.js";

const button = { id: "sync", label: "Sync", iconId: "puzzle", actionId: "acme.sync" };

describe("ToolbarButtonContributionSchema when (#13785)", () => {
  it("accepts an optional clause and rejects an empty one", () => {
    expect(ToolbarButtonContributionSchema.safeParse(button).success).toBe(true);
    expect(
      ToolbarButtonContributionSchema.safeParse({ ...button, when: "isGitBacked" }).success
    ).toBe(true);
    expect(ToolbarButtonContributionSchema.safeParse({ ...button, when: "" }).success).toBe(false);
  });
});

describe("PluginToolbarButtonRuntimeStateSchema (#13785)", () => {
  const parse = (state: unknown) => PluginToolbarButtonRuntimeStateSchema.safeParse(state);

  it("accepts every field together, keeping an explicit pressed: false", () => {
    const result = parse({
      pressed: false,
      disabled: true,
      disabledReason: "Sign in to sync",
      busy: true,
      tooltip: "Synced 2 min ago",
      iconId: "./icons/on.svg",
    });
    expect(result.success).toBe(true);
    expect(result.data?.pressed).toBe(false);
  });

  it("requires a reason for disabled and refuses a reason without it", () => {
    expect(parse({ disabled: true }).success).toBe(false);
    expect(parse({ disabled: false, disabledReason: "why" }).success).toBe(false);
    expect(parse({ disabledReason: "why" }).success).toBe(false);
  });

  it("refuses a label, so a toggle can never rename itself", () => {
    expect(parse({ label: "Sync on" }).success).toBe(false);
  });

  it("caps tooltip and reason text, and refuses blank text", () => {
    expect(parse({ tooltip: "x".repeat(200) }).success).toBe(true);
    expect(parse({ tooltip: "x".repeat(201) }).success).toBe(false);
    expect(parse({ tooltip: "   " }).success).toBe(false);
    expect(parse({ disabled: true, disabledReason: "x".repeat(201) }).success).toBe(false);
  });
});
