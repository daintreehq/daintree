import { describe, expect, it } from "vitest";
import {
  WORKBENCH_TIER_TOOLS,
  ACTION_TIER_ADDONS,
  SYSTEM_TIER_ADDONS,
  HELP_TIER_CUMULATIVE,
} from "../helpAssistantTierAllowlists.js";
import { MCP_EXTERNAL_TIER_TOOLS } from "../mcpExternalTierAllowlist.js";

/**
 * The tier placement #11908 chose, asserted against the allowlists rather than
 * restated in prose. These are the "discoverable only at their chosen in-app
 * tiers" half of the acceptance criteria: the action definitions themselves are
 * covered by their own suites, but nothing else proves an id did not quietly
 * drift up a tier or onto the third-party surface.
 */
const CONTINUITY_READS = ["agentSessionHistory.list", "session.bookmarks.list"] as const;

const CONTINUITY_WRITES = [
  "agentSessionHistory.resume",
  "session.bookmarkAndClose",
  "session.bookmark.promote",
  "session.bookmark.rename",
  "session.bookmark.delete",
] as const;

const EDITOR_HANDOFFS = ["recipe.editor.open", "recipe.editor.openFromLayout"] as const;

/** The recipe-writing half, deliberately absent from every assistant tier. */
const RECIPE_WRITES = ["recipe.saveToRepo", "recipe.delete"] as const;

const workbench = new Set<string>(WORKBENCH_TIER_TOOLS);
const action = new Set<string>(ACTION_TIER_ADDONS);
const system = new Set<string>(SYSTEM_TIER_ADDONS);
const external = new Set<string>(MCP_EXTERNAL_TIER_TOOLS);

describe("session continuity tier placement (#11908)", () => {
  it("keeps the listings readable by a read-only workbench session", () => {
    for (const id of CONTINUITY_READS) {
      expect(workbench.has(id), `${id} should stay at workbench`).toBe(true);
    }
  });

  it("puts every mutation at action tier, so workbench stays read-only", () => {
    for (const id of [...CONTINUITY_WRITES, ...EDITOR_HANDOFFS]) {
      expect(action.has(id), `${id} should be an action-tier addon`).toBe(true);
      expect(workbench.has(id), `${id} must not be readable at workbench`).toBe(false);
      expect(system.has(id), `${id} is cumulative already — do not restate it`).toBe(false);
    }
  });

  it("reaches an action-tier session but not a workbench one", () => {
    for (const id of [...CONTINUITY_WRITES, ...EDITOR_HANDOFFS]) {
      expect(HELP_TIER_CUMULATIVE.workbench).not.toContain(id);
      expect(HELP_TIER_CUMULATIVE.action).toContain(id);
      expect(HELP_TIER_CUMULATIVE.system).toContain(id);
    }
  });

  it("widens nothing on the third-party API-key surface", () => {
    // The external tier curates its own roster; #11908 is in-app only, and an id
    // landing there would hand a revocable bearer token the ability to close
    // panes and delete bookmarks.
    for (const id of [...CONTINUITY_WRITES, ...EDITOR_HANDOFFS]) {
      expect(external.has(id), `${id} must not reach external MCP clients`).toBe(false);
    }
  });

  it("never exposes a recipe write, so a draft cannot become a tracked file", () => {
    // The whole point of the editor handoffs: the assistant can propose a recipe
    // but the person is the only one who can commit it to `.daintree/recipes/`.
    for (const id of RECIPE_WRITES) {
      expect(workbench.has(id), `${id} must stay unexposed`).toBe(false);
      expect(action.has(id), `${id} must stay unexposed`).toBe(false);
      expect(system.has(id), `${id} must stay unexposed`).toBe(false);
      expect(external.has(id), `${id} must stay unexposed`).toBe(false);
    }
  });

  it("leaves the palette-only resume entry point off every tier", () => {
    // `terminal.resumeSessions` opens the human palette, takes no session id and
    // returns nothing — the reason #11908 added a deterministic action instead.
    for (const set of [workbench, action, system, external]) {
      expect(set.has("terminal.resumeSessions")).toBe(false);
    }
  });
});
