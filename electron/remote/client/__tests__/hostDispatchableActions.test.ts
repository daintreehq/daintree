import { describe, expect, it } from "vitest";
import {
  CORE_TIER_TOOLS,
  OWNED_TWIN_TOOLS,
  toNonRendererOwnedTools,
} from "../../../../shared/config/helpAssistantTierAllowlists.js";
import { MCP_EXTERNAL_TIER_TOOLS } from "../../../../shared/config/mcpExternalTierAllowlist.js";
import { HOST_DISPATCHABLE_ACTION_IDS } from "../hostDispatchableActions.js";

/**
 * The default tool sets' tools a host's session goes without while a Shell
 * drives its project, each for a reason that is about this machine. A tool
 * joining either set lands here or in the allowlist by decision, rather than
 * quietly dropping out of every Shell-driven session (#13350).
 */
const WITHHELD_FROM_HOSTS: Record<string, string> = {
  "diagnostics.openReview": "collects this Shell's diagnostics, not the host's",
  "copyTree.generateAndCopyFile": "writes this Shell's clipboard",
};

const DEFAULT_SURFACE = [
  ...new Set<string>([
    ...CORE_TIER_TOOLS,
    ...toNonRendererOwnedTools(CORE_TIER_TOOLS),
    ...MCP_EXTERNAL_TIER_TOOLS,
  ]),
];

describe("HOST_DISPATCHABLE_ACTION_IDS against the default MCP surface", () => {
  it.each(DEFAULT_SURFACE)("decides %s for a Shell-driven host session", (id) => {
    const allowed = HOST_DISPATCHABLE_ACTION_IDS.has(id);
    const withheld = id in WITHHELD_FROM_HOSTS;
    expect({ id, decided: allowed !== withheld }).toEqual({ id, decided: true });
  });

  it("withholds nothing that is no longer on the default surface", () => {
    for (const id of Object.keys(WITHHELD_FROM_HOSTS)) {
      expect(DEFAULT_SURFACE).toContain(id);
    }
  });

  it.each(Object.entries(OWNED_TWIN_TOOLS))(
    "carries %s's delegate whenever it carries the owned twin %s",
    (unscoped, owned) => {
      if (!HOST_DISPATCHABLE_ACTION_IDS.has(owned)) return;
      // The host checks ownership and then dispatches the unscoped action, so a
      // twin without its delegate is shown to the host and refused here.
      expect(HOST_DISPATCHABLE_ACTION_IDS.has(unscoped)).toBe(true);
    }
  );
});
