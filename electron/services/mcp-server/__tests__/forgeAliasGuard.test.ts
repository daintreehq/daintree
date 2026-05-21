import { describe, it } from "vitest";
import { TIER_ALLOWLISTS } from "../shared.js";

// Pins the safety condition that lets dispatchAlias() (in
// src/services/actions/definitions/githubActions.ts) default to source="user"
// without laundering agent intent. The six github.* one-release aliases must
// stay out of every MCP tier so an agent call cannot reach a deprecated alias
// and populate ActionService.lastAction with the forge.* primary as if the
// user had invoked it. Companion test in
// src/services/actions/definitions/__tests__/githubActions.adversarial.test.ts
// covers the help assistant allowlists on the renderer side.
describe("github.* aliases must not be reachable from MCP agent surfaces", () => {
  const aliasIds = [
    "github.openIssues",
    "github.openPRs",
    "github.openCommits",
    "github.openIssue",
    "github.assignIssue",
    "github.validateToken",
  ] as const;

  it("none of the migrated github.* aliases appear in any MCP TIER_ALLOWLISTS tier", () => {
    for (const [tierName, tier] of Object.entries(TIER_ALLOWLISTS)) {
      for (const aliasId of aliasIds) {
        if (tier.has(aliasId)) {
          throw new Error(
            `Deprecated alias "${aliasId}" appears in MCP tier "${tierName}". ` +
              `Aliases must never be agent-callable — update to the forge.* primary instead.`
          );
        }
      }
    }
  });
});
