import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELP_TIER_CUMULATIVE, WORKBENCH_TIER_TOOLS } from "../helpAssistantTierAllowlists.js";
import { MCP_EXTERNAL_TIER_TOOLS } from "../mcpExternalTierAllowlist.js";

/**
 * The capability catalog shipped with its contract, service and action tests,
 * and none of them could notice it was missing from every tier: `tools/list`
 * never offered it, so the assistant searched for the action it had been told
 * to use and found nothing. Read from the published contract rather than a
 * restated list, so the next action added there fails here until it is either
 * wired or withheld on purpose.
 */
const CONTRACT_ACTIONS = (
  JSON.parse(readFileSync("docs/contracts/agent-capabilities.json", "utf8")) as { name: string }[]
).map((entry) => entry.name);

/**
 * Contract actions kept off every tier, each with the reason. `get` returns the
 * source file body, and discovery follows symlinks with no containment on that
 * read, so a repository could point a `SKILL.md` at a file outside every skill
 * root and have its contents handed to the caller. Remove the entry in the same
 * change that contains the read.
 */
const WITHHELD: Readonly<Record<string, string>> = {
  "agentCapabilities.get": "source read is not contained to the skill roots",
};

const workbench = new Set<string>(WORKBENCH_TIER_TOOLS);
const everyInAppTier = new Set<string>(HELP_TIER_CUMULATIVE.system);
const external = new Set<string>(MCP_EXTERNAL_TIER_TOOLS);

describe("agent capability tier placement", () => {
  it("publishes the two catalog actions", () => {
    expect(CONTRACT_ACTIONS).toEqual(
      expect.arrayContaining(["agentCapabilities.search", "agentCapabilities.get"])
    );
  });

  it("exposes every contract action to a read-only workbench session unless withheld", () => {
    for (const id of CONTRACT_ACTIONS) {
      if (id in WITHHELD) continue;
      expect(workbench.has(id), `${id} is in the contract but not on the MCP surface`).toBe(true);
    }
  });

  it("keeps a withheld action off every tier until its reason is fixed", () => {
    for (const [id, reason] of Object.entries(WITHHELD)) {
      expect(everyInAppTier.has(id), `${id} is withheld (${reason})`).toBe(false);
      expect(external.has(id), `${id} is withheld (${reason})`).toBe(false);
    }
  });

  it("withholds only actions the contract still publishes", () => {
    for (const id of Object.keys(WITHHELD)) {
      expect(CONTRACT_ACTIONS, `${id} left the contract; drop it from WITHHELD`).toContain(id);
    }
  });

  it("sits beside slashCommands.list, the lookup it extends", () => {
    expect(workbench.has("slashCommands.list")).toBe(true);
  });

  it("widens nothing on the third-party API-key surface", () => {
    // slashCommands.list is in-app only, and the catalog reads the same local
    // command and skill directories, so it stays off the external roster too.
    for (const id of CONTRACT_ACTIONS) {
      expect(external.has(id), `${id} must not reach external MCP clients`).toBe(false);
    }
  });
});
