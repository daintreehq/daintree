import { describe, expect, it } from "vitest";
import {
  ResourceOwnershipLedger,
  assistantPrincipalOf,
  helpConversationKey,
  helpOwnershipPrincipal,
  principalOwnerKey,
  relayOwnershipPrincipal,
} from "../resourceOwnership.js";
import { TerminalAdoptionLedger } from "../terminalAdoption.js";
import {
  WorkerCreationHistory,
  isCreationOf,
  readRunAssistantWork,
} from "../workerCreationHistory.js";

function records(generations: Record<string, number> = {}) {
  const generationOf = (id: string) => generations[id] ?? null;
  return {
    generations,
    workerCreations: new WorkerCreationHistory(generationOf, () => 1_000),
    resourceOwnership: new ResourceOwnershipLedger(),
    terminalAdoption: new TerminalAdoptionLedger(),
  };
}

/** What a trusted dispatch does: record ownership, then note what it created. */
function create(
  r: ReturnType<typeof records>,
  principalId: string,
  terminalId: string,
  conversationId?: string
) {
  // A bearer's handshake binds its principal before anything is recorded under it.
  r.resourceOwnership.bindPrincipal(`session-of-${principalId}`, principalId);
  if (conversationId !== undefined) {
    r.resourceOwnership.attachConversation(principalId, helpConversationKey(conversationId));
  }
  const owner = principalOwnerKey(principalId);
  const drafts = [{ kind: "terminal" as const, id: terminalId }];
  const recorded = r.resourceOwnership.record(owner, drafts);
  r.workerCreations.noteDrafts(
    owner,
    drafts.filter((draft) => recorded.some((record) => record.id === draft.id)),
    recorded
  );
}

const HELP_A = helpOwnershipPrincipal("help-a");
const RELAY_B = relayOwnershipPrincipal("abc123", "help-b");

describe("assistantPrincipalOf", () => {
  it("reads help and relay principals back, and nothing else", () => {
    expect(assistantPrincipalOf(principalOwnerKey(HELP_A))).toEqual({
      kind: "help",
      helpSessionId: "help-a",
    });
    expect(assistantPrincipalOf(principalOwnerKey(RELAY_B))).toEqual({
      kind: "relay",
      senderId: "abc123",
      helpSessionId: "help-b",
    });
    // A pane bearer, an api-key session, and a session id that merely spells a principal.
    expect(assistantPrincipalOf(principalOwnerKey("pane-principal"))).toBeNull();
    expect(assistantPrincipalOf("session-1")).toBeNull();
    expect(assistantPrincipalOf("help\u0000help-a")).toBeNull();
  });
});

describe("WorkerCreationHistory", () => {
  it("names only the run that was created, never a later one under its id", () => {
    const history = new WorkerCreationHistory(() => 3);
    history.note("owner", ["t1"]);
    expect(history.get("t1", 3)?.owner).toBe("owner");
    expect(history.get("t1", 4)).toBeUndefined();
  });

  it("names nothing when main tracked no generation at creation", () => {
    const history = new WorkerCreationHistory(() => null);
    history.note("owner", ["t1"]);
    expect(history.get("t1", 0)).toBeUndefined();
  });

  it("keeps a bounded number of runs, oldest out first", () => {
    const history = new WorkerCreationHistory(() => 1, Date.now, 2);
    history.note("owner", ["t1", "t2", "t3"]);
    expect(history.get("t1", 1)).toBeUndefined();
    expect(history.get("t3", 1)).toBeDefined();
  });

  it("forgets runs that are no longer alive", () => {
    const history = new WorkerCreationHistory(() => 1);
    history.note("owner", ["t1", "t2"]);
    history.retainOnly(new Set(["t2"]), history.mark());
    expect(history.get("t1", 1)).toBeUndefined();
    expect(history.get("t2", 1)).toBeDefined();
  });

  it("keeps a creation noted while the read it is pruned by was in flight", () => {
    const history = new WorkerCreationHistory(() => 1);
    history.note("owner", ["old"]);
    const mark = history.mark();
    // Created after the inventory was taken: absent from it without having gone.
    history.note("owner", ["new"]);
    history.retainOnly(new Set(), mark);
    expect(history.get("old", 1)).toBeUndefined();
    expect(history.get("new", 1)).toBeDefined();
  });
});

describe("readRunAssistantWork", () => {
  it("says a live creator both created and controls its run", () => {
    const r = records({ t1: 1 });
    create(r, HELP_A, "t1");
    expect(readRunAssistantWork(r, "t1", 1)).toEqual({
      createdBy: { kind: "help", helpSessionId: "help-a" },
      controlledBy: { principal: { kind: "help", helpSessionId: "help-a" }, basis: "creation" },
    });
  });

  it("keeps a relayed creator's origin installation and session", () => {
    const r = records({ t1: 1 });
    create(r, RELAY_B, "t1");
    expect(readRunAssistantWork(r, "t1", 1).createdBy).toEqual({
      kind: "relay",
      senderId: "abc123",
      helpSessionId: "help-b",
    });
  });

  it("keeps creation after the creator's principal is revoked, with no control left", () => {
    const r = records({ t1: 1 });
    create(r, HELP_A, "t1");
    r.resourceOwnership.revokePrincipal(HELP_A);
    expect(readRunAssistantWork(r, "t1", 1)).toEqual({
      createdBy: { kind: "help", helpSessionId: "help-a" },
      controlledBy: null,
    });
  });

  it("reports a hand-over as current control while creation stays with the creator", () => {
    const r = records({ t1: 1 });
    create(r, HELP_A, "t1");
    r.resourceOwnership.revokePrincipal(HELP_A);
    const globalPrincipal = relayOwnershipPrincipal("local", "global-session");
    r.terminalAdoption.adopt({
      terminalId: "t1",
      orchestratorPaneId: "global-pty",
      principalId: globalPrincipal,
      launchGeneration: 1,
      recipient: "global-assistant",
    });
    expect(readRunAssistantWork(r, "t1", 1)).toEqual({
      createdBy: { kind: "help", helpSessionId: "help-a" },
      controlledBy: {
        principal: { kind: "relay", senderId: "local", helpSessionId: "global-session" },
        basis: "handover",
      },
    });
  });

  it("gives a reused id's new run neither the old creator nor the old hand-over", () => {
    const r = records({ t1: 1 });
    create(r, HELP_A, "t1");
    r.terminalAdoption.adopt({
      terminalId: "t2",
      orchestratorPaneId: "pane",
      principalId: HELP_A,
      launchGeneration: 1,
    });
    // The person respawned both under the same ids: generation 2 is another run.
    expect(readRunAssistantWork(r, "t1", 2)).toEqual({ createdBy: null, controlledBy: null });
    expect(readRunAssistantWork(r, "t2", 2)).toEqual({ createdBy: null, controlledBy: null });
  });

  it("names no assistant for a pane bearer's or an api-key session's creation", () => {
    const r = records({ t1: 1, t2: 1 });
    create(r, "pane-principal", "t1");
    r.resourceOwnership.record("session-1", [{ kind: "terminal", id: "t2" }]);
    r.workerCreations.note("session-1", ["t2"]);
    expect(readRunAssistantWork(r, "t1", 1)).toEqual({ createdBy: null, controlledBy: null });
    expect(readRunAssistantWork(r, "t2", 1)).toEqual({ createdBy: null, controlledBy: null });
  });

  it("moves creation and control to whoever creates the id next", () => {
    const r = records({ t1: 1 });
    create(r, HELP_A, "t1");
    r.generations.t1 = 2;
    create(r, RELAY_B, "t1");
    expect(readRunAssistantWork(r, "t1", 1)).toEqual({ createdBy: null, controlledBy: null });
    expect(readRunAssistantWork(r, "t1", 2).controlledBy?.basis).toBe("creation");
    expect(readRunAssistantWork(r, "t1", 2).createdBy).toMatchObject({ helpSessionId: "help-b" });
  });
});

describe("a resumed Assistant's runs (#17919)", () => {
  const HELP_B = helpOwnershipPrincipal("help-b");

  it("hands control of a conversation's run to its resumed bearer, creation staying with the first", () => {
    const r = records({ t1: 1 });
    create(r, HELP_A, "t1", "conv-1");
    r.resourceOwnership.revokePrincipal(HELP_A);
    expect(readRunAssistantWork(r, "t1", 1)).toEqual({
      createdBy: { kind: "help", helpSessionId: "help-a" },
      controlledBy: null,
    });

    r.resourceOwnership.bindPrincipal("session-of-b", HELP_B);
    r.resourceOwnership.attachConversation(HELP_B, helpConversationKey("conv-1"));
    expect(readRunAssistantWork(r, "t1", 1)).toEqual({
      createdBy: { kind: "help", helpSessionId: "help-a" },
      controlledBy: { principal: { kind: "help", helpSessionId: "help-b" }, basis: "creation" },
    });
  });

  it("counts the run as the resumed bearer's own creation only while it holds that record", () => {
    const r = records({ t1: 1 });
    create(r, HELP_A, "t1", "conv-1");
    r.resourceOwnership.revokePrincipal(HELP_A);
    r.resourceOwnership.bindPrincipal("session-of-b", HELP_B);
    r.resourceOwnership.attachConversation(HELP_B, helpConversationKey("conv-1"));
    const ownerB = principalOwnerKey(HELP_B);
    const creation = r.workerCreations.get("t1", 1);
    const held = r.resourceOwnership.get(ownerB, "terminal", "t1");

    expect(isCreationOf(creation, ownerB, held)).toBe(true);
    // The bearer that made it still did; a session that made nothing never did.
    expect(isCreationOf(creation, principalOwnerKey(HELP_A), undefined)).toBe(true);
    expect(isCreationOf(creation, "api-session", undefined)).toBe(false);
    // A record the id got later is not this run's.
    r.resourceOwnership.record(ownerB, [{ kind: "terminal", id: "t1" }]);
    const later = r.resourceOwnership.get(ownerB, "terminal", "t1");
    expect(isCreationOf(creation, ownerB, later)).toBe(false);
    expect(isCreationOf(undefined, ownerB, later)).toBe(false);
  });
});
