import { describe, it, expect } from "vitest";
import { mergeProjectEnv } from "../restoreProjectEnv.js";

describe("mergeProjectEnv (#9810)", () => {
  it("returns null when both inputs are missing", () => {
    expect(mergeProjectEnv(undefined, undefined)).toBeNull();
  });

  it("returns null when both inputs are empty objects", () => {
    expect(mergeProjectEnv({}, {})).toBeNull();
  });

  it("returns null when one is missing and the other is empty", () => {
    expect(mergeProjectEnv(undefined, {})).toBeNull();
    expect(mergeProjectEnv({}, undefined)).toBeNull();
  });

  it("returns the global env unchanged when project env is missing/empty", () => {
    const global = { NODE_ENV: "production", PORT: "3000" };
    expect(mergeProjectEnv(global, undefined)).toEqual(global);
    expect(mergeProjectEnv(global, {})).toEqual(global);
  });

  it("returns the project env when global is missing/empty", () => {
    const project = { MY_API_KEY: "x", DEBUG: "true" };
    expect(mergeProjectEnv(undefined, project)).toEqual(project);
    expect(mergeProjectEnv({}, project)).toEqual(project);
  });

  it("lets project keys override global keys on collision", () => {
    const merged = mergeProjectEnv(
      { FOO: "global", BAR: "from-global" },
      { FOO: "project", BAZ: "from-project" }
    );
    expect(merged).toEqual({ FOO: "project", BAR: "from-global", BAZ: "from-project" });
  });

  it("returns a new object (does not alias caller-owned objects)", () => {
    const global = { A: "1" };
    const project = { B: "2" };
    const merged = mergeProjectEnv(global, project);
    expect(merged).not.toBe(global);
    expect(merged).not.toBe(project);
  });
});
