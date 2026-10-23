import { describe, expect, it } from "vitest";
import {
  CORE_TIER_TOOLS,
  FULL_TIER_ADDONS,
  OWNED_TWIN_TOOLS,
} from "../../../../shared/config/helpAssistantTierAllowlists.js";
import { isWithheldFromRelaySession } from "../../../services/mcp-server/tierAuth.js";
import { GLOBAL_ALLOWED_TOOLS, GLOBAL_WITHHELD_TOOLS } from "../HostCallRuntime.js";

describe("the global assistant's host.call tools (#14161)", () => {
  // Every tool a relayed session can be offered at any tier, in any form.
  const relayable = [
    ...new Set<string>([
      ...CORE_TIER_TOOLS,
      ...FULL_TIER_ADDONS,
      ...Object.values(OWNED_TWIN_TOOLS),
    ]),
  ].filter((id) => !isWithheldFromRelaySession(id));

  it("places every tool a relay can reach as allowed or withheld, so a new one fails closed", () => {
    const unplaced = relayable.filter(
      (id) => !GLOBAL_ALLOWED_TOOLS.has(id) && !GLOBAL_WITHHELD_TOOLS.has(id)
    );
    expect(unplaced).toEqual([]);
  });

  it("never both allows and withholds a tool", () => {
    expect([...GLOBAL_ALLOWED_TOOLS].filter((id) => GLOBAL_WITHHELD_TOOLS.has(id))).toEqual([]);
  });

  it("names only tools that exist on the relay surface", () => {
    const known = new Set(relayable);
    expect([...GLOBAL_ALLOWED_TOOLS].filter((id) => !known.has(id))).toEqual([]);
    expect([...GLOBAL_WITHHELD_TOOLS].filter((id) => !known.has(id))).toEqual([]);
  });

  it("withholds what restarts or reloads something it neither launched nor was handed", () => {
    for (const id of ["devPreview.restart", "devPreview.reloadPreview", "plugin.reloadProject"]) {
      expect(GLOBAL_ALLOWED_TOOLS.has(id)).toBe(false);
      expect(GLOBAL_WITHHELD_TOOLS.has(id)).toBe(true);
    }
  });

  it("leaves the confirm-gated teardown and recipe run to the person's approval", () => {
    expect(GLOBAL_ALLOWED_TOOLS.has("worktree.resource.teardown")).toBe(true);
    expect(GLOBAL_ALLOWED_TOOLS.has("recipe.run")).toBe(true);
  });
});
