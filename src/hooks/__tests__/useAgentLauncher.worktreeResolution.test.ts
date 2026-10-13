// @vitest-environment node
/**
 * Tests resolveLaunchWorktree from useAgentLauncher.ts — the pure worktree
 * lookup that gates agent launches. Extracted so the throw-on-unknown-id
 * contract (#10812) is guarded at the source: reverting it to a silent null
 * return must fail a test here, not just at the ActionService boundary.
 */
import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";
import type { AgentPreset } from "@/config/agents";
import { resolveEffectivePresetId, type AgentSettingsEntry } from "@shared/types";
// The real sanitizer, extracted in #11547 — previously hand-mirrored here,
// which could drift from the hook silently.
import { sanitizeTerminalName } from "@/utils/agentLaunchValidation";
import {
  buildLaunchIdentity,
  resolveAgentLaunchKind,
  resolveLaunchTarget,
  resolveLaunchWorktree,
} from "../useAgentLauncher";

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

  /**
   * A ghost row (#11232) is absent from the live map yet is a legitimate active
   * selection — `useActiveWorktreeSync` holds the selection on one while its
   * terminals survive. Dropping the id would put the new panel in the
   * `__none__` bucket: invisible chrome over a live PTY.
   */
  describe("deleted-worktree ghost rows", () => {
    it("keeps an inherited ghost id so the panel joins the row's surviving terminals", () => {
      expect(
        resolveLaunchTarget(undefined, "ghost", map(["wt-1"]), true, new Set(["ghost"]))
      ).toEqual({ worktreeId: "ghost", worktree: null });
    });

    it("accepts the store's Map of ghost rows, not just a Set", () => {
      // The hook passes `deletedWorktrees` straight through, which is a
      // Map<string, DeletedWorktree>.
      const deleted = new Map([["ghost", { name: "feature" }]]);
      expect(resolveLaunchTarget(undefined, "ghost", map([]), true, deleted)).toEqual({
        worktreeId: "ghost",
        worktree: null,
      });
    });

    it("still drops an inherited id that is neither live nor a ghost row", () => {
      expect(resolveLaunchTarget(undefined, "stale", map([]), true, new Set(["ghost"]))).toEqual({
        worktreeId: null,
        worktree: null,
      });
    });

    it("does not rescue an explicit ghost id — a named target still asserts (#10812)", () => {
      // The caller asked for this worktree by name; a ghost has no path to
      // launch into, so the failure must surface rather than silently landing
      // somewhere else.
      expect(() =>
        resolveLaunchTarget("ghost", null, map(["wt-1"]), true, new Set(["ghost"]))
      ).toThrow("Worktree 'ghost' not found");
    });
  });
});

/**
 * Tests resolveAgentLaunchKind from useAgentLauncher.ts — the classifier that
 * stops an unresolvable agent id from degrading into a plain shell terminal
 * (#11498). It returns the kind (rather than asserting) so the hook's call site
 * is load-bearing; these tests cover the classification itself, and the hook
 * cannot drop the call without breaking its own `isAgent`.
 */
const NEWLINE = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);

/** Grab the error a rejected id produces, so one throw can be inspected. */
function launchError(agentId: string): Error {
  try {
    resolveAgentLaunchKind(agentId, false);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error(`Expected '${agentId}' to be rejected`);
}

describe("resolveAgentLaunchKind", () => {
  it("classifies any id the registry resolved as an agent", () => {
    // The helper only sees the resolved flag, so built-in, user, and plugin ids
    // are indistinguishable here by design — the effective registry decides.
    expect(resolveAgentLaunchKind("claude", true)).toBe("agent");
    expect(resolveAgentLaunchKind("acme-plugin-agent", true)).toBe("agent");
  });

  it("classifies 'terminal' as a plain terminal even though it is unregistered", () => {
    expect(resolveAgentLaunchKind("terminal", false)).toBe("terminal");
  });

  it("prefers the agent kind when something registered the 'terminal' id", () => {
    // Plugin/user registries only reserve built-in agent ids, so "terminal" is
    // registerable. Resolving it as an agent preserves the pre-#11498 behavior.
    expect(resolveAgentLaunchKind("terminal", true)).toBe("agent");
  });

  it("rejects an unregistered id, naming the id it was given (#11498)", () => {
    const agentId = "clyde-the-agent";
    expect(launchError(agentId).message).toContain(agentId);
  });

  it("rejects a near-miss of the plain-terminal id rather than falling through", () => {
    expect(() => resolveAgentLaunchKind("Terminal", false)).toThrow();
    expect(() => resolveAgentLaunchKind(" terminal ", false)).toThrow();
  });

  it("fails closed for panel kinds that must be handled before this classifier", () => {
    // browser/dev-preview return from their own branches earlier in launchAgent.
    // Reaching this classifier means one was bypassed — rejecting beats falling
    // through to the generic terminal branch that #11498 was about.
    expect(() => resolveAgentLaunchKind("browser", false)).toThrow();
    expect(() => resolveAgentLaunchKind("dev-preview", false)).toThrow();
  });

  it("names only real dispatchable actions as recovery paths", () => {
    // The message crosses to MCP clients as the sole recovery hint, so every
    // action-shaped token in it has to be something a client can actually call.
    const suggested = launchError("nope").message.match(/\b[a-z]+\.[a-zA-Z]+\b/g) ?? [];
    expect(suggested.length).toBeGreaterThan(0);
    for (const actionId of suggested) {
      expect(BUILT_IN_ACTION_IDS).toContain(actionId);
    }
  });

  it("keeps an untrusted id printable and bounded in the error", () => {
    // Ids reach here straight from an MCP caller, so a newline could forge a log
    // line and an unbounded id would bloat the error crossing the boundary.
    const message = launchError(`bad${NEWLINE}ID${"x".repeat(500)}`).message;
    expect(message.includes(NEWLINE)).toBe(false);
    expect(message.includes(CARRIAGE_RETURN)).toBe(false);
    expect(message.length).toBeLessThan(300);
  });
});

/**
 * Tests buildLaunchIdentity from useAgentLauncher.ts — the identity every
 * successful launch now reports so a caller driving parallel launches can map a
 * terminal back to its worktree without re-resolving the target (#11547). The
 * hook itself is store-coupled and untestable in isolation, so the construction
 * is extracted here and the four return points share it.
 */
const SENSITIVE = { caseInsensitive: false };
const INSENSITIVE = { caseInsensitive: true };

describe("buildLaunchIdentity", () => {
  it("reports the resolved worktree's path and branch", () => {
    expect(
      buildLaunchIdentity(
        "wt-1",
        { path: "/repo/wt-1", branch: "feature/x" },
        "/repo/wt-1",
        SENSITIVE
      )
    ).toEqual({
      worktreeId: "wt-1",
      worktreePath: "/repo/wt-1",
      branch: "feature/x",
      cwd: "/repo/wt-1",
      cwdOutsideWorktree: false,
    });
  });

  it("reports a detached worktree with a null branch but a real path", () => {
    // `Worktree.branch` is optional — undefined in detached HEAD. The launch
    // still landed somewhere, so path and id must survive.
    const identity = buildLaunchIdentity("wt-2", { path: "/repo/wt-2" }, "/repo/wt-2", SENSITIVE);
    expect(identity.branch).toBeNull();
    expect(identity.worktreePath).toBe("/repo/wt-2");
  });

  it("keeps the requested worktree id when the worktree could not be looked up", () => {
    // resolveLaunchWorktree returns null before the map initializes. The panel
    // is still created with the requested id, so reporting it is accurate —
    // path and branch stay null because neither is known yet.
    expect(buildLaunchIdentity("wt-3", null, "/repo", SENSITIVE)).toEqual({
      worktreeId: "wt-3",
      worktreePath: null,
      branch: null,
      cwd: "/repo",
      cwdOutsideWorktree: null,
    });
  });

  it("reports a worktree-less launch with only a cwd", () => {
    // A scratch or bare-project launch: the cwd is the only locator there is.
    expect(buildLaunchIdentity(null, null, "/home/user/scratch", SENSITIVE)).toEqual({
      worktreeId: null,
      worktreePath: null,
      branch: null,
      cwd: "/home/user/scratch",
      cwdOutsideWorktree: null,
    });
  });

  it("normalizes an unresolved cwd to null rather than an empty string", () => {
    // resolveWorkspaceCwd returns "" when nothing resolves, and main reads a
    // falsy cwd as "use the home dir" — reporting "" would name a directory the
    // process never runs in.
    const identity = buildLaunchIdentity(null, { path: "/repo/wt-1" }, "", SENSITIVE);
    expect(identity.cwd).toBeNull();
    expect(identity.cwdOutsideWorktree).toBeNull();
  });

  it("treats an empty worktree id as absent", () => {
    // Mirrors the `targetWorktreeId || undefined` the panel options use, so the
    // reported id can never disagree with the panel's own.
    expect(buildLaunchIdentity("", null, "/repo", SENSITIVE).worktreeId).toBeNull();
    expect(buildLaunchIdentity(undefined, null, "/repo", SENSITIVE).worktreeId).toBeNull();
  });

  describe("cwdOutsideWorktree (#13130)", () => {
    const outside = (cwd: string, worktreePath: string, options = SENSITIVE) =>
      buildLaunchIdentity("wt", { path: worktreePath }, cwd, options).cwdOutsideWorktree;

    it("flags a cwd in another repo while the pane files under the worktree", () => {
      expect(outside("/work/siteorigin-panels", "/work/so-widgets-bundle-trackb")).toBe(true);
    });

    it("does not flag a cwd nested inside the worktree", () => {
      expect(outside("/repo/wt-1/packages/app", "/repo/wt-1")).toBe(false);
    });

    it("flags a sibling that only shares the worktree path as a string prefix", () => {
      expect(outside("/repo/wt-1-other", "/repo/wt-1")).toBe(true);
    });

    it("flags the parent of a nested worktree, which contains it rather than sits in it", () => {
      expect(outside("/repo", "/repo/.worktrees/feature")).toBe(true);
    });

    it("ignores trailing slashes and separator spelling", () => {
      expect(outside("/repo/wt-1/", "/repo/wt-1")).toBe(false);
      expect(outside("C:\\repo\\wt-1\\src", "C:/repo/wt-1", INSENSITIVE)).toBe(false);
    });

    it("reports nothing to compare for a relative cwd", () => {
      // Main resolves a relative cwd against a base the renderer never sees, so
      // "." may well land inside the worktree — a lexical guess would misreport.
      expect(outside(".", "/repo/wt-1")).toBeNull();
      expect(outside("packages/app", "/repo/wt-1")).toBeNull();
    });

    it("treats an empty worktree path as unknown", () => {
      const identity = buildLaunchIdentity("wt", { path: "" }, "/repo", SENSITIVE);
      expect(identity.worktreePath).toBeNull();
      expect(identity.cwdOutsideWorktree).toBeNull();
    });

    it("folds letter case only when the platform compares paths case-insensitively", () => {
      expect(outside("/Repo/WT-1/src", "/repo/wt-1", INSENSITIVE)).toBe(false);
      expect(outside("/Repo/WT-1/src", "/repo/wt-1", SENSITIVE)).toBe(true);
    });
  });
});

const CUSTOM_PRESET: AgentPreset = {
  id: "user-111",
  name: "My Preset",
  env: { MY_VAR: "hello" },
};

describe("resolveEffectivePresetId helper", () => {
  it("returns worktree override when present", () => {
    expect(
      resolveEffectivePresetId(
        { presetId: "global", worktreePresets: { "wt-A": "scoped" } },
        "wt-A"
      )
    ).toBe("scoped");
  });

  it("falls back to agent-level default when no override for this worktree", () => {
    expect(
      resolveEffectivePresetId(
        { presetId: "global", worktreePresets: { "wt-A": "scoped" } },
        "wt-B"
      )
    ).toBe("global");
  });

  it("returns agent-level default when worktreeId is null", () => {
    expect(resolveEffectivePresetId({ presetId: "global" }, null)).toBe("global");
  });

  it("returns undefined for an empty entry", () => {
    expect(resolveEffectivePresetId({}, "wt-A")).toBeUndefined();
  });

  it("returns undefined when the entry itself is null", () => {
    expect(resolveEffectivePresetId(null, "wt-A")).toBeUndefined();
  });

  // Regression for #10723: creating a custom preset only appends it to
  // customPresets and must NOT set the agent-level default. An entry that has
  // customPresets but no presetId must still resolve to undefined (built-in
  // default) for every worktree.
  it("returns undefined when customPresets are present but no presetId is set", () => {
    const entry: AgentSettingsEntry = { customPresets: [CUSTOM_PRESET] };
    expect(resolveEffectivePresetId(entry, null)).toBeUndefined();
    expect(resolveEffectivePresetId(entry, "wt-A")).toBeUndefined();
  });
});

/**
 * Tests the title / titleMode resolution from useAgentLauncher.ts
 * (issues #10439, #10738).
 *
 * The full hook has deep React/Electron dependencies that make direct rendering
 * costly here, so we mirror the pure branching logic that builds the
 * `AddPanelOptions.title` / `titleMode` pair — see `presetTitle` /
 * `hasPresetTitle` / `trimmedName` / `customTitle` in useAgentLauncher.ts. Any
 * change to those lines should require a corresponding update here.
 */
// ── mirror of the hook's title-resolution block ──────────────────────────────
// Mirrors the presetTitle/trimmedName/customTitle resolution in
// useAgentLauncher.ts. Any change to that logic should update this mirror.

function resolvePanelTitle(
  computedTitle: string,
  preset: { name?: string; displayTitle?: string } | undefined,
  name: string | undefined
): { title: string; titleMode?: "custom" } {
  // Preset title: explicit displayTitle wins verbatim; otherwise compose the
  // agent name with the preset in brackets. Pinned as "custom" so the
  // agent-detected title sync can't overwrite it with the bare agent name.
  let presetTitle = computedTitle;
  let hasPresetTitle = false;
  if (preset) {
    const presetName = preset.name?.trim();
    if (presetName) {
      hasPresetTitle = true;
      presetTitle = preset.displayTitle?.trim()
        ? preset.displayTitle
        : `${computedTitle} [${presetName}]`;
    }
  }
  const trimmedName = name ? sanitizeTerminalName(name) : undefined;
  // Pin when either a caller name or a preset title is in effect.
  const customTitle = trimmedName || hasPresetTitle ? { titleMode: "custom" as const } : {};
  return { title: trimmedName || presetTitle, ...customTitle };
}

const AGENT_TITLE = "Claude";

describe("assistant-supplied name → title / titleMode", () => {
  it("uses the name as the title and pins it with titleMode 'custom'", () => {
    expect(resolvePanelTitle(AGENT_TITLE, undefined, "Claude: auth refactor")).toEqual({
      title: "Claude: auth refactor",
      titleMode: "custom",
    });
  });

  it("trims surrounding whitespace from a non-empty name", () => {
    expect(resolvePanelTitle(AGENT_TITLE, undefined, "  research work  ")).toEqual({
      title: "research work",
      titleMode: "custom",
    });
  });

  it("strips control characters and collapses whitespace from the name", () => {
    expect(resolvePanelTitle(AGENT_TITLE, undefined, "Claude:\tauth\n\nrefactor")).toEqual({
      title: "Claude: auth refactor",
      titleMode: "custom",
    });
  });

  it("falls back to the computed title when the name is only control characters", () => {
    const result = resolvePanelTitle(AGENT_TITLE, undefined, "\t\n\r");
    expect(result.title).toBe(AGENT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });

  it("falls back to the computed title and sets no titleMode when name is whitespace only", () => {
    const result = resolvePanelTitle(AGENT_TITLE, undefined, "   ");
    expect(result.title).toBe(AGENT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });
});
