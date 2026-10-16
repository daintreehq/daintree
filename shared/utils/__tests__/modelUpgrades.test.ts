import { describe, expect, it } from "vitest";
import { followModelUpgrades } from "../modelUpgrades.js";

describe("followModelUpgrades", () => {
  it("follows a chain of successors to the end", () => {
    const upgrades = { "gpt-5.5": "gpt-5.6-sol", "gpt-5.6-sol": "gpt-6-sol" };
    expect(followModelUpgrades("gpt-5.5", upgrades)).toBe("gpt-6-sol");
    expect(followModelUpgrades("gpt-5.6-sol", upgrades)).toBe("gpt-6-sol");
  });

  it("returns an ID with no successor unchanged", () => {
    const upgrades = { "gpt-5.6-sol": "gpt-6-sol" };
    expect(followModelUpgrades("gpt-6-sol", upgrades)).toBe("gpt-6-sol");
    expect(followModelUpgrades("my-custom-model", upgrades)).toBe("my-custom-model");
  });

  it("passes the ID through when no map is known", () => {
    expect(followModelUpgrades("gpt-5.6-sol", undefined)).toBe("gpt-5.6-sol");
  });

  it("stops before a cycle repeats instead of looping", () => {
    const upgrades = { a: "b", b: "c", c: "a" };
    expect(followModelUpgrades("a", upgrades)).toBe("c");
    expect(followModelUpgrades("b", upgrades)).toBe("a");
  });

  it("ignores a self-pointer and an empty successor", () => {
    expect(followModelUpgrades("a", { a: "a" })).toBe("a");
    expect(followModelUpgrades("a", { a: "" })).toBe("a");
  });

  it("never reads inherited keys as successors", () => {
    expect(followModelUpgrades("constructor", {})).toBe("constructor");
    expect(followModelUpgrades("toString", {})).toBe("toString");
  });
});
