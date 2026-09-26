import { describe, expect, it } from "vitest";
import {
  CORE_TIER_TOOLS,
  FULL_TIER_ADDONS,
  HELP_TIER_CUMULATIVE,
} from "../helpAssistantTierAllowlists.js";
import { MCP_EXTERNAL_TIER_TOOLS } from "../mcpExternalTierAllowlist.js";

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

describe("session continuity tier placement (#11908)", () => {
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
