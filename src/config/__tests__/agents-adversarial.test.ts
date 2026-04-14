import { describe, it, expect } from "vitest";
import { getMergedFlavors } from "@/config/agents";

// Adversarial unit tests for flavor merging logic
describe("Adversarial: Flavor Merging", () => {
  it("handles undefined/empty inputs gracefully", () => {
    expect(() => getMergedFlavors("claude")).not.toThrow();
    expect(() => getMergedFlavors("claude", undefined, [])).not.toThrow();
    expect(() => getMergedFlavors("claude", [], undefined)).not.toThrow();
  });

  it("prevents prototype pollution via env keys", () => {
    const maliciousCustomFlavors = [
      { id: "malicious", name: "Evil", env: { __proto__: "polluted" } as Record<string, string> },
    ];
    getMergedFlavors("claude", maliciousCustomFlavors);
    // Must not pollute global Object.prototype
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("rejects shell injection in env values", () => {
    const injectionFlavors = [
      { id: "inject", name: "Bad", env: { ANTHROPIC_API_KEY: "$(rm -rf /)" } },
    ];
    const result = getMergedFlavors("claude", injectionFlavors);
    expect(result.some((f) => f.env?.ANTHROPIC_API_KEY?.includes("$("))).toBe(false);
  });

  it("handles circular references in env objects without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const flavors = [{ id: "circular", name: "Loop", env: circular as Record<string, string> }];
    expect(() => getMergedFlavors("claude", flavors)).not.toThrow();
    // Circular env values (non-string) are dropped — flavor itself survives
    const result = getMergedFlavors("claude", flavors);
    expect(result.length).toBe(1);
    expect(result[0].env?.["self"]).toBeUndefined();
  });

  it("deduplicates flavors with the same ID — first wins", () => {
    const dupFlavors = [
      { id: "dup", name: "First" },
      { id: "dup", name: "Second" },
    ];
    const result = getMergedFlavors("claude", dupFlavors);
    expect(result.filter((f) => f.id === "dup")).toHaveLength(1);
    expect(result.find((f) => f.id === "dup")?.name).toBe("First");
  });

  it("rejects flavors with invalid ID characters", () => {
    const badIds = [
      { id: "../escape", name: "Path traversal" },
      { id: "id with spaces", name: "Spaces" },
      { id: "id\twith\ttabs", name: "Tabs" },
      { id: "", name: "Empty ID" },
    ];
    const result = getMergedFlavors("claude", badIds);
    expect(result).toHaveLength(0);
  });

  it("rejects env values that are non-string objects", () => {
    const flavors = [
      {
        id: "obj-env",
        name: "ObjEnv",
        env: { KEY: { nested: "value" } as unknown as string },
      },
    ];
    const result = getMergedFlavors("claude", flavors);
    expect(result[0].env?.KEY).toBeUndefined();
  });

  it("custom flavor shadows CCR flavor with same ID", () => {
    const customFlavors = [{ id: "ccr-opus", name: "My Custom Opus" }];
    const ccrFlavors = [{ id: "ccr-opus", name: "CCR Opus" }];
    const result = getMergedFlavors("claude", customFlavors, ccrFlavors);
    expect(result.filter((f) => f.id === "ccr-opus")).toHaveLength(1);
    expect(result.find((f) => f.id === "ccr-opus")?.name).toBe("My Custom Opus");
  });

  it("blocks dangerous system env var names", () => {
    const dangerous = [
      { id: "danger", name: "Bad", env: { PATH: "/injected", LD_PRELOAD: "evil.so" } },
    ];
    const result = getMergedFlavors("claude", dangerous);
    expect(result[0].env?.PATH).toBeUndefined();
    expect(result[0].env?.LD_PRELOAD).toBeUndefined();
  });

  it("allows safe env vars through", () => {
    const safe = [
      {
        id: "safe-env",
        name: "Safe",
        env: { ANTHROPIC_API_KEY: "sk-test-123", CLAUDE_MODEL: "claude-opus-4-6" },
      },
    ];
    const result = getMergedFlavors("claude", safe);
    expect(result[0].env?.ANTHROPIC_API_KEY).toBe("sk-test-123");
    expect(result[0].env?.CLAUDE_MODEL).toBe("claude-opus-4-6");
  });
});
