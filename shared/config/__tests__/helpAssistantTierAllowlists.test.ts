import { describe, expect, it } from "vitest";
import {
  CORE_TIER_TOOLS,
  FULL_TIER_ADDONS,
  HELP_ASSISTANT_TIERS,
  HELP_TIER_CUMULATIVE,
  HIGH_BLAST_RADIUS_TOOLS,
  OWNED_TWIN_TOOLS,
  RENDERER_OWNED_ORIGIN_ONLY_TOOLS,
  normalizeHelpAssistantTier,
  toNonRendererOwnedTools,
} from "../helpAssistantTierAllowlists.js";
import { MCP_EXTERNAL_TIER_TOOLS } from "../mcpExternalTierAllowlist.js";

describe("normalizeHelpAssistantTier", () => {
  it("passes the current tool sets through", () => {
    for (const tier of HELP_ASSISTANT_TIERS) {
      expect(normalizeHelpAssistantTier(tier)).toBe(tier);
    }
  });

  // Settings written before the core/full split must keep working without a
  // rewrite: the old default and the read-only rung land on the new default,
  // and the widest rung on the wider set.
  it("reads the pre-split ladder onto the new pair", () => {
    expect(normalizeHelpAssistantTier("workbench")).toBe("core");
    expect(normalizeHelpAssistantTier("action")).toBe("core");
    expect(normalizeHelpAssistantTier("system")).toBe("full");
  });

  it("returns null for anything else", () => {
    for (const value of ["external", "off", "", "Core", 1, null, undefined, {}]) {
      expect(normalizeHelpAssistantTier(value)).toBeNull();
    }
  });
});

describe("tool set lists", () => {
  it("keeps core and the full addons disjoint and duplicate-free", () => {
    const core = new Set<string>(CORE_TIER_TOOLS);
    const addons = new Set<string>(FULL_TIER_ADDONS);
    expect(core.size).toBe(CORE_TIER_TOOLS.length);
    expect(addons.size).toBe(FULL_TIER_ADDONS.length);
    expect([...addons].filter((id) => core.has(id))).toEqual([]);
  });

  // The four operations the core set exists for, pinned so a trim of core
  // cannot quietly take one of them out.
  it("carries the orchestration loop in core", () => {
    for (const id of [
      "worktree.createWithRecipe",
      "agent.launch",
      "terminal.sendCommand",
      "terminal.moveToWorktree",
    ]) {
      expect(CORE_TIER_TOOLS as readonly string[]).toContain(id);
    }
  });

  it("names only unscoped tools that some tool set actually carries as twin keys", () => {
    const full = new Set<string>(HELP_TIER_CUMULATIVE.full);
    for (const [unscoped, owned] of Object.entries(OWNED_TWIN_TOOLS)) {
      expect(full.has(unscoped), unscoped).toBe(true);
      // The owned form is added for other origins; it is never listed beside
      // the unscoped one, except the owned worktree delete, which assistant
      // runbooks already call by name.
      if (owned !== "worktree.deleteOwned") {
        expect(full.has(owned), owned).toBe(false);
      }
    }
  });

  // The assistant cleans up worktrees it did not create in this help session —
  // an earlier session's, or its own from before a restart — without being
  // moved to `full` (#13135). Confirmation, not the tool set, is what asks.
  it("carries the unscoped worktree delete in core", () => {
    expect(CORE_TIER_TOOLS as readonly string[]).toContain("worktree.delete");
    expect(FULL_TIER_ADDONS as readonly string[]).not.toContain("worktree.delete");
  });

  it("only pins high-blast-radius tools that are on some tool set", () => {
    const full = new Set<string>(HELP_TIER_CUMULATIVE.full);
    for (const id of HIGH_BLAST_RADIUS_TOOLS) {
      expect(full.has(id), id).toBe(true);
    }
  });
});

describe("toNonRendererOwnedTools", () => {
  it("swaps each unscoped tool for its owned twin in place", () => {
    expect(
      toNonRendererOwnedTools(["terminal.list", "terminal.sendCommand", "terminal.close"])
    ).toEqual(["terminal.list", "terminal.sendCommandOwned", "terminal.closeOwned"]);
  });

  it("drops the reserved tools", () => {
    expect(toNonRendererOwnedTools([...RENDERER_OWNED_ORIGIN_ONLY_TOOLS, "terminal.list"])).toEqual(
      ["terminal.list"]
    );
  });

  // Core carries both the owned delete and the unscoped one; the swap must not
  // leave the owned form listed twice.
  it("collapses a twin that is already present", () => {
    expect(
      toNonRendererOwnedTools(["worktree.deleteOwned", "worktree.list", "worktree.delete"])
    ).toEqual(["worktree.deleteOwned", "worktree.list"]);
  });

  it("leaves no unscoped or reserved id in either projected tool set", () => {
    const banned = new Set<string>([
      ...Object.keys(OWNED_TWIN_TOOLS),
      ...RENDERER_OWNED_ORIGIN_ONLY_TOOLS,
    ]);
    for (const tier of HELP_ASSISTANT_TIERS) {
      const projected = toNonRendererOwnedTools(HELP_TIER_CUMULATIVE[tier]);
      expect(
        projected.filter((id) => banned.has(id)),
        tier
      ).toEqual([]);
    }
  });

  it("gives other origins only the owned worktree delete at core", () => {
    const projected = toNonRendererOwnedTools(HELP_TIER_CUMULATIVE.core);
    expect(projected).toContain("worktree.deleteOwned");
    expect(projected).not.toContain("worktree.delete");
    expect(projected.filter((id) => id === "worktree.deleteOwned")).toHaveLength(1);
  });
});

describe("session continuity tier placement (#11908)", () => {
  /**
   * Session-continuity placement, asserted against the allowlists rather than
   * restated in prose. #11908 put these tools on the in-app ladder; the core/full
   * split kept history listing and resume in `full` and took the bookmark and
   * recipe-editor tools off MCP entirely. Nothing else proves an id did not
   * quietly drift into `core` or onto the third-party surface.
   */
  const CONTINUITY_TOOLS = ["agentSessionHistory.list", "agentSessionHistory.resume"] as const;

  /** Driven from the UI only since the core/full split. */
  const OFF_MCP = [
    "session.bookmarks.list",
    "session.bookmarkAndClose",
    "session.bookmark.promote",
    "session.bookmark.rename",
    "session.bookmark.delete",
    "recipe.editor.open",
    "recipe.editor.openFromLayout",
  ] as const;

  /** The recipe-writing half, deliberately absent from every assistant tier. */
  const RECIPE_WRITES = ["recipe.saveToRepo", "recipe.delete"] as const;

  const core = new Set<string>(CORE_TIER_TOOLS);
  const fullAddons = new Set<string>(FULL_TIER_ADDONS);
  const external = new Set<string>(MCP_EXTERNAL_TIER_TOOLS);

  it("keeps session history in the full tool set, out of core", () => {
    for (const id of CONTINUITY_TOOLS) {
      expect(fullAddons.has(id), `${id} should be a full-tier addon`).toBe(true);
      expect(core.has(id), `${id} must not be in core`).toBe(false);
    }
  });

  it("leaves bookmarks and the recipe editor off every in-app tier", () => {
    for (const id of OFF_MCP) {
      expect(HELP_TIER_CUMULATIVE.full, `${id} must stay off MCP`).not.toContain(id);
    }
  });

  it("widens nothing on the third-party API-key surface", () => {
    // The external tier curates its own roster, and an id landing there would
    // hand a revocable bearer token the ability to resume sessions, close panes
    // or delete bookmarks.
    for (const id of [...CONTINUITY_TOOLS, ...OFF_MCP]) {
      expect(external.has(id), `${id} must not reach external MCP clients`).toBe(false);
    }
  });

  it("never exposes a recipe write, so a draft cannot become a tracked file", () => {
    // The assistant can propose a recipe but the person is the only one who can
    // commit it to `.daintree/recipes/`. Checked against the widest in-app tier
    // plus the external roster — those two together are every surface an id
    // could reach.
    for (const id of RECIPE_WRITES) {
      expect(HELP_TIER_CUMULATIVE.full, `${id} must stay unexposed`).not.toContain(id);
      expect(external.has(id), `${id} must stay unexposed`).toBe(false);
    }
  });

  it("leaves the palette-only resume entry point off every tier", () => {
    // `terminal.resumeSessions` opens the human palette, takes no session id and
    // returns nothing — the reason #11908 added a deterministic action instead.
    expect(HELP_TIER_CUMULATIVE.full).not.toContain("terminal.resumeSessions");
    expect(external.has("terminal.resumeSessions")).toBe(false);
  });
});
