import { describe, expect, it } from "vitest";
import {
  ASSISTANT_HOST_SETTINGS_CONFIRMATION,
  ASSISTANT_NEXT_FALLBACK_CONFIRMATION,
  ASSISTANT_PRESET_MOVE_TOOL,
  DELEGABLE_ASSISTANT_CONFIRMATIONS,
  UNDELEGABLE_ASSISTANT_CONFIRMATIONS,
  isDelegableAssistantConfirmation,
  sanitizeDelegatedConfirmations,
} from "../../../../shared/config/assistantConfirmationDelegation.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";
import {
  HOST_SETTINGS_TOOL,
  HOST_START_AGENT_SIGN_IN_TOOL,
} from "../../../../shared/types/hostControl.js";
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

  // #18197 — nothing to ask: the person finishes the sign-in in the window it opens.
  it("lists an assistant's sign-in on a host on neither side", () => {
    const delegableTools = DELEGABLE_ASSISTANT_CONFIRMATIONS.flatMap((entry) => [
      entry.id,
      entry.calledActionId,
    ]);
    expect(delegableTools).not.toContain(HOST_START_AGENT_SIGN_IN_TOOL);
    expect(undelegableIds).not.toContain(HOST_START_AGENT_SIGN_IN_TOOL);
    expect(isDelegableAssistantConfirmation(HOST_START_AGENT_SIGN_IN_TOOL)).toBe(false);
  });

  it("never offers an action that moves this window", () => {
    for (const id of HOST_ALWAYS_ASKS_ACTION_IDS) {
      expect(isDelegableAssistantConfirmation(id)).toBe(false);
      expect(undelegableIds).toContain(id);
    }
  });

  it("never offers the delegate an owned tool stands in for", () => {
    for (const entry of DELEGABLE_ASSISTANT_CONFIRMATIONS) {
      const id = entry.calledActionId ?? entry.id;
      const owned = Object.hasOwn(OWNED_RESOURCE_TOOLS, id) ? OWNED_RESOURCE_TOOLS[id] : undefined;
      const delegateTo = owned && "delegateTo" in owned ? owned.delegateTo : undefined;
      if (typeof delegateTo === "string" && delegateTo !== id) {
        expect(isDelegableAssistantConfirmation(delegateTo)).toBe(false);
      }
    }
  });

  it("names only real ids, none on both lists", () => {
    const known = new Set<string>([...BUILT_IN_ACTION_IDS, HOST_SETTINGS_TOOL]);
    for (const entry of DELEGABLE_ASSISTANT_CONFIRMATIONS) {
      expect(known.has(entry.calledActionId ?? entry.id)).toBe(true);
      // A scoped tick's own key is never a tool a policy keyed on the called id could match.
      if (entry.calledActionId !== undefined) expect(known.has(entry.id)).toBe(false);
    }
    const keys = DELEGABLE_ASSISTANT_CONFIRMATIONS.map((entry) => entry.id);
    expect(new Set(keys).size).toBe(keys.length);
    for (const id of undelegableIds) {
      expect(known.has(id)).toBe(true);
      expect(isDelegableAssistantConfirmation(id)).toBe(false);
    }
    expect(ASSISTANT_HOST_SETTINGS_CONFIRMATION).toBe(HOST_SETTINGS_TOOL);
  });

  it("hands over a preset or account move only to the next step of the pane's own chain (#17917)", () => {
    for (const id of [ASSISTANT_PRESET_MOVE_TOOL, "terminal.restartOnAccountOwned"]) {
      expect(isDelegableAssistantConfirmation(id)).toBe(false);
      expect(undelegableIds).toContain(id);
    }
    expect(isDelegableAssistantConfirmation(ASSISTANT_NEXT_FALLBACK_CONFIRMATION)).toBe(false);
    const scoped = DELEGABLE_ASSISTANT_CONFIRMATIONS.find(
      (entry) => entry.id === ASSISTANT_NEXT_FALLBACK_CONFIRMATION
    );
    expect(scoped?.calledActionId).toBe(ASSISTANT_PRESET_MOVE_TOOL);
    for (const entry of UNDELEGABLE_ASSISTANT_CONFIRMATIONS) {
      if (entry.ids.some((id) => id.startsWith("terminal.restartOn"))) {
        expect(entry.reason).toMatch(/^Always asks: /);
      }
    }
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
    expect(
      sanitizeDelegatedConfirmations([
        HOST_SETTINGS_TOOL,
        ASSISTANT_PRESET_MOVE_TOOL,
        ASSISTANT_NEXT_FALLBACK_CONFIRMATION,
      ])
    ).toEqual([ASSISTANT_NEXT_FALLBACK_CONFIRMATION, HOST_SETTINGS_TOOL]);
    expect(sanitizeDelegatedConfirmations("worktree.deleteOwned")).toEqual([]);
    expect(sanitizeDelegatedConfirmations(undefined)).toEqual([]);
  });
});
