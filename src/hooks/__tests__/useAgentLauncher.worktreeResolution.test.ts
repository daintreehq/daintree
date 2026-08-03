// @vitest-environment node
/**
 * Tests resolveLaunchWorktree from useAgentLauncher.ts — the pure worktree
 * lookup that gates agent launches. Extracted so the throw-on-unknown-id
 * contract (#10812) is guarded at the source: reverting it to a silent null
 * return must fail a test here, not just at the ActionService boundary.
 */
import { describe, expect, it } from "vitest";
import { resolveLaunchTarget, resolveLaunchWorktree } from "../useAgentLauncher";

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

/**
 * Where the explicit/inherited split lives (#11654). An id the caller named is
 * an assertion and keeps the #10812 throw; an id inherited from the workspace's
 * ambient selection is not, and a worktree-less workspace can hold a stale one
 * from a previous project. The id and worktree are resolved together so a stale
 * id can never reach panel metadata or preset scoping alongside a null worktree.
 */
describe("resolveLaunchTarget", () => {
  it("keeps throwing for an explicit id that cannot resolve (#10812)", () => {
    expect(() => resolveLaunchTarget("gone", null, map(["wt-1"]), true)).toThrow(
      "Worktree 'gone' not found"
    );
  });

  it("throws for an explicit bad id even when the inherited id would have resolved", () => {
    // Proves an explicit request never silently degrades into the ambient one —
    // an MCP client asking for a specific worktree must hear that it is wrong.
    expect(() => resolveLaunchTarget("gone", "wt-1", map(["wt-1"]), true)).toThrow(
      "Worktree 'gone' not found"
    );
  });

  it("prefers an explicit id over a different inherited one", () => {
    expect(resolveLaunchTarget("wt-2", "wt-1", map(["wt-1", "wt-2"]), true)).toEqual({
      worktreeId: "wt-2",
      worktree: { path: "/repo/wt-2" },
    });
  });

  it("drops an inherited id that the initialized map does not know", () => {
    // The worktree-less workspace case: launching must proceed without a
    // worktree rather than failing on state the user never chose.
    expect(resolveLaunchTarget(undefined, "stale", map([]), true)).toEqual({
      worktreeId: null,
      worktree: null,
    });
  });

  it("drops an unknown inherited id against a populated map, not just an empty one", () => {
    // Switching into a different git-backed project carries the previous
    // project's id across. Keying the decision off an empty map instead of the
    // failed lookup would leave that case throwing.
    expect(resolveLaunchTarget(undefined, "other-project-wt", map(["new-main"]), true)).toEqual({
      worktreeId: null,
      worktree: null,
    });
  });

  it("retains an unresolved explicit id before initialization instead of throwing", () => {
    // Symmetric with the inherited pre-init case, and it must not quietly
    // borrow the inherited id the caller declined to use.
    expect(resolveLaunchTarget("wt-9", "wt-1", map(["wt-1"]), false)).toEqual({
      worktreeId: "wt-9",
      worktree: null,
    });
  });

  it("retains an unresolved inherited id until the map is authoritative", () => {
    // Pre-init the panel is still created with this id, so reporting it stays
    // accurate — only the worktree is unknown.
    expect(resolveLaunchTarget(undefined, "stale", map([]), false)).toEqual({
      worktreeId: "stale",
      worktree: null,
    });
  });

  it("resolves an inherited id that the map knows", () => {
    expect(resolveLaunchTarget(undefined, "wt-1", map(["wt-1"]), true)).toEqual({
      worktreeId: "wt-1",
      worktree: { path: "/repo/wt-1" },
    });
  });

  it("yields no target when neither source supplies an id", () => {
    expect(resolveLaunchTarget(undefined, null, map(["wt-1"]), true)).toEqual({
      worktreeId: null,
      worktree: null,
    });
  });

  it("normalizes an empty explicit id to no target rather than throwing", () => {
    // The MCP launch schema is `z.string().optional()`, so "" reaches here.
    // Every consumer already reduces it to absent, and it must not fall through
    // to the inherited id — the caller did supply a value, however useless.
    expect(resolveLaunchTarget("", "wt-1", map(["wt-1"]), true)).toEqual({
      worktreeId: null,
      worktree: null,
    });
  });
});
