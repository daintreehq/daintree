// @vitest-environment node
/**
 * Tests resolveLaunchWorktree from useAgentLauncher.ts — the pure worktree
 * lookup that gates agent launches. Extracted so the throw-on-unknown-id
 * contract (#10812) is guarded at the source: reverting it to a silent null
 * return must fail a test here, not just at the ActionService boundary.
 */
import { describe, expect, it } from "vitest";
import { resolveLaunchWorktree } from "../useAgentLauncher";

function map(ids: string[]): Map<string, { path: string }> {
  return new Map(ids.map((id) => [id, { path: `/repo/${id}` }]));
}

describe("resolveLaunchWorktree", () => {
  it("returns the matching worktree when the id resolves", () => {
    const worktrees = map(["wt-1", "wt-2"]);
    expect(resolveLaunchWorktree("wt-2", worktrees, true)).toEqual({ path: "/repo/wt-2" });
  });

  it("returns null when no target id is supplied (active-worktree fallback)", () => {
    expect(resolveLaunchWorktree(null, map(["wt-1"]), true)).toBeNull();
    expect(resolveLaunchWorktree(undefined, map(["wt-1"]), true)).toBeNull();
  });

  it("throws on an unknown id once the worktree map is initialized (#10812)", () => {
    expect(() => resolveLaunchWorktree("main", map(["wt-1", "wt-2"]), true)).toThrow(
      "Worktree 'main' not found"
    );
  });

  it("lists the available worktree ids in the thrown message so clients can self-correct", () => {
    expect(() => resolveLaunchWorktree("main", map(["wt-1", "wt-2"]), true)).toThrow(
      "Available worktree IDs: wt-1, wt-2"
    );
  });

  it("reports 'none' when an unknown id is launched against an empty (but initialized) map", () => {
    expect(() => resolveLaunchWorktree("main", map([]), true)).toThrow(
      "Available worktree IDs: none"
    );
  });

  it("does NOT throw before the map is initialized — can't assert not-found yet", () => {
    // Pre-init we cannot distinguish "missing" from "not loaded"; fall through to
    // the caller's cwd fallbacks rather than failing a launch spuriously.
    expect(resolveLaunchWorktree("main", map([]), false)).toBeNull();
    expect(resolveLaunchWorktree("main", map(["wt-1"]), false)).toBeNull();
  });
});
