import { describe, expect, it } from "vitest";
import {
  CORE_TIER_TOOLS,
  DEFAULT_HELP_ASSISTANT_TIER,
  FULL_TIER_ADDONS,
  HELP_ASSISTANT_TIERS,
  HELP_TIER_CUMULATIVE,
  HIGH_BLAST_RADIUS_TOOLS,
  OWNED_TWIN_TOOLS,
  RENDERER_OWNED_ORIGIN_ONLY_TOOLS,
  normalizeHelpAssistantTier,
  toNonRendererOwnedTools,
} from "../helpAssistantTierAllowlists.js";

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

  it("defaults to core", () => {
    expect(DEFAULT_HELP_ASSISTANT_TIER).toBe("core");
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

  it("builds full as core plus the addons", () => {
    expect(HELP_TIER_CUMULATIVE.core).toEqual(CORE_TIER_TOOLS);
    expect(HELP_TIER_CUMULATIVE.full).toEqual([...CORE_TIER_TOOLS, ...FULL_TIER_ADDONS]);
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
      // the unscoped one, except the owned worktree delete, which core carries
      // on its own merits.
      if (owned !== "worktree.deleteOwned") {
        expect(full.has(owned), owned).toBe(false);
      }
    }
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

  // `full` carries both core's owned delete and the unscoped one; the swap must
  // not leave the owned form listed twice.
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
});
