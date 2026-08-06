import path from "node:path";

import { describe, expect, it } from "vitest";

import { getAgentCompileCacheDir, getAgentCompileCacheRoot } from "../agentCompileCachePaths.js";

const USER_DATA = path.join(path.sep, "tmp", "userdata");

describe("getAgentCompileCacheRoot", () => {
  it("resolves under the supplied userData path rather than a process global", () => {
    const a = getAgentCompileCacheRoot(path.join(path.sep, "one"));
    const b = getAgentCompileCacheRoot(path.join(path.sep, "two"));
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(path.sep, "one"));
    expect(path.dirname(b)).toBe(path.join(path.sep, "two"));
  });
});

describe("getAgentCompileCacheDir", () => {
  it("nests the agent id directly beneath the cache root", () => {
    const dir = getAgentCompileCacheDir(USER_DATA, "claude");
    expect(dir).not.toBeNull();
    expect(path.dirname(dir!)).toBe(getAgentCompileCacheRoot(USER_DATA));
    expect(path.basename(dir!)).toBe("claude");
  });

  it.each([
    ["parent traversal", ".."],
    ["nested traversal", path.join("..", "..", "etc")],
    ["traversal through a valid segment", path.join("claude", "..", "..", "escape")],
    ["separator-bearing id", path.join("claude", "nested")],
    ["empty id", ""],
    ["the current directory", "."],
  ])("returns null for %s", (_label, agentId) => {
    expect(getAgentCompileCacheDir(USER_DATA, agentId)).toBeNull();
  });

  // These all normalize to the same immediate child as a bare `claude`, so a
  // containment-only check would accept them and let one agent own several
  // spellings of its cache directory.
  it.each([
    ["a leading current-dir segment", "./claude"],
    ["an absolute id", "/claude"],
    ["a trailing forward slash", "claude/"],
    ["a trailing backslash", "claude\\"],
    ["an embedded NUL", "claude\0evil"],
  ])("returns null for %s", (_label, agentId) => {
    expect(getAgentCompileCacheDir(USER_DATA, agentId)).toBeNull();
  });

  it("keeps every accepted id strictly inside the root", () => {
    const root = getAgentCompileCacheRoot(USER_DATA);
    for (const agentId of ["claude", "gemini", "agent.with.dots", "agent-with-dash"]) {
      const dir = getAgentCompileCacheDir(USER_DATA, agentId);
      expect(dir).not.toBeNull();
      expect(dir!.startsWith(root + path.sep)).toBe(true);
    }
  });
});
