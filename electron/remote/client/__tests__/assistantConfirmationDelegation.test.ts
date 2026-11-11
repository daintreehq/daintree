import { describe, expect, it } from "vitest";
import {
  ASSISTANT_HOST_SETTINGS_CONFIRMATION,
  DELEGABLE_ASSISTANT_CONFIRMATIONS,
  UNDELEGABLE_ASSISTANT_CONFIRMATIONS,
  isDelegableAssistantConfirmation,
  sanitizeDelegatedConfirmations,
} from "../../../../shared/config/assistantConfirmationDelegation.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";
import { HOST_SETTINGS_TOOL } from "../../../../shared/types/hostControl.js";
import { OWNED_RESOURCE_TOOLS } from "../../../services/mcp-server/sessionCallOwnership.js";
import { HOST_ALWAYS_ASKS_ACTION_IDS } from "../hostDispatchableActions.js";

// Lives beside the host-dispatch list so the window-moving actions it always
// asks for can never be ticked in "Ask, except for…" (#16752).
describe("assistant confirmation delegation (#16752)", () => {
  const undelegableIds = UNDELEGABLE_ASSISTANT_CONFIRMATIONS.flatMap((entry) => entry.ids);

  it("offers exactly the cleanup and settings calls an assistant makes", () => {
    for (const id of ["worktree.deleteOwned", "worktree.retireOwned", HOST_SETTINGS_TOOL]) {
      expect(isDelegableAssistantConfirmation(id)).toBe(true);
    }
  });

  it("never offers an action that moves this window", () => {
    for (const id of HOST_ALWAYS_ASKS_ACTION_IDS) {
      expect(isDelegableAssistantConfirmation(id)).toBe(false);
      expect(undelegableIds).toContain(id);
    }
  });

  it("never offers the delegate an owned tool stands in for", () => {
    for (const { id } of DELEGABLE_ASSISTANT_CONFIRMATIONS) {
      const owned = Object.hasOwn(OWNED_RESOURCE_TOOLS, id) ? OWNED_RESOURCE_TOOLS[id] : undefined;
      const delegateTo = owned && "delegateTo" in owned ? owned.delegateTo : undefined;
      if (typeof delegateTo === "string" && delegateTo !== id) {
        expect(isDelegableAssistantConfirmation(delegateTo)).toBe(false);
      }
    }
  });

  it("names only real ids, none on both lists", () => {
    const known = new Set<string>([...BUILT_IN_ACTION_IDS, HOST_SETTINGS_TOOL]);
    for (const { id } of DELEGABLE_ASSISTANT_CONFIRMATIONS) expect(known.has(id)).toBe(true);
    for (const id of undelegableIds) {
      expect(known.has(id)).toBe(true);
      expect(isDelegableAssistantConfirmation(id)).toBe(false);
    }
    expect(ASSISTANT_HOST_SETTINGS_CONFIRMATION).toBe(HOST_SETTINGS_TOOL);
  });

  it("keeps a stored list to the delegable ids, once each, in catalog order", () => {
    expect(
      sanitizeDelegatedConfirmations([
        HOST_SETTINGS_TOOL,
        "worktree.delete",
        42,
        "worktree.deleteOwned",
        "worktree.deleteOwned",
      ])
    ).toEqual(["worktree.deleteOwned", HOST_SETTINGS_TOOL]);
    expect(sanitizeDelegatedConfirmations("worktree.deleteOwned")).toEqual([]);
    expect(sanitizeDelegatedConfirmations(undefined)).toEqual([]);
  });
});
