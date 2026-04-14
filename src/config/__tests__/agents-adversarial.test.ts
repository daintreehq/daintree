import { describe, it, expect, vi } from "vitest";
import { getMergedFlavors } from "@/config/agents";
import { setAgentFlavors } from "@shared/config/agentRegistry";

// Adversarial unit tests for flavor merging logic
describe("Adversarial: Flavor Merging", () => {
  it("handles undefined/empty inputs gracefully", () => {
    expect(() => getMergedFlavors("claude")).not.toThrow();
    expect(() => getMergedFlavors("claude", undefined, [])).not.toThrow();
    expect(() => getMergedFlavors("claude", [], undefined)).not.toThrow();
  });

  it("prevents prototype pollution via env keys", () => {
    const maliciousCustomFlavors = [
      { id: "malicious", name: "Evil", env: { __proto__: { isAdmin: true } } },
    ];
    const result = getMergedFlavors("claude", maliciousCustomFlavors);
    // Should not pollute global Object.prototype
    expect(({} as any).isAdmin).toBeUndefined();
  });

  it("rejects flavors with shell injection in env values", () => {
    const injectionFlavors = [
      { id: "inject", name: "Bad", env: { ANTHROPIC_API_KEY: "$(rm -rf /)" } },
    ];
    const result = getMergedFlavors("claude", injectionFlavors);
    // The system should either reject or sanitize dangerous env values
    expect(result.some((f) => f.env?.ANTHROPIC_API_KEY?.includes("$("))).toBe(false);
  });

  it("handles circular references in env objects", () => {
    const circular: any = { self: null };
    circular.self = circular;
    const flavors = [{ id: "circular", name: "Loop", env: circular }];
    expect(() => getMergedFlavors("claude", flavors)).not.toThrow();
  });

  it("ignores flavors with duplicate IDs", () => {
    const dupFlavors = [
      { id: "dup", name: "First" },
      { id: "dup", name: "Second" },
    ];
    const result = getMergedFlavors("claude", dupFlavors);
    expect(result.filter((f) => f.id === "dup")).toHaveLength(1);
  });
});
