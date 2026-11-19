import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceOwnershipLedger,
  helpConversationKey,
  helpOwnershipPrincipal,
  principalOwnerKey,
  relayConversationKey,
  relayOwnershipPrincipal,
} from "../resourceOwnership.js";
import {
  LOCAL_RELAY_CONVERSATION_RETENTION_MS,
  MAX_STORED_ASSISTANT_PANE_CREATIONS,
  STORED_ASSISTANT_PANE_CREATION_TTL_MS,
  _resetAssistantPaneCreationsForTests,
  admitRestoredAssistantPanes,
  assistantPaneCreationObserver,
  attachAssistantPaneCreationLedger,
  attachAssistantPaneCreationPersistence,
  beginAssistantPaneCreationQuit,
  forgetTrashedAssistantPane,
  isKeptAssistantPane,
  keptLocalRelayConversations,
  noteLocalRelayCall,
  supersedeByPluginLaunch,
  type StoredAssistantPaneCreation,
} from "../assistantPaneCreations.js";

const T0 = 1_800_000_000_000;

/** The disk both runs share. */
function makeDisk(initial?: unknown) {
  let saved: unknown = initial;
  const save = vi.fn((records: Record<string, StoredAssistantPaneCreation>) => {
    saved = JSON.parse(JSON.stringify(records));
  });
  return {
    persistence: { load: () => saved, save },
    save,
    read: () => (saved ?? {}) as Record<string, StoredAssistantPaneCreation>,
  };
}

/** One run of the app: a ledger wired to the kept records on `disk`. */
function startRun(disk: ReturnType<typeof makeDisk>): ResourceOwnershipLedger {
  _resetAssistantPaneCreationsForTests();
  const ledger = new ResourceOwnershipLedger(assistantPaneCreationObserver);
  attachAssistantPaneCreationPersistence(disk.persistence);
  attachAssistantPaneCreationLedger(ledger);
  return ledger;
}

function bindHelp(ledger: ResourceOwnershipLedger, helpSessionId: string, conversationId: string) {
  const principal = helpOwnershipPrincipal(helpSessionId);
  ledger.bindPrincipal(`s-${helpSessionId}`, principal);
  ledger.attachConversation(principal, helpConversationKey(conversationId));
  return principalOwnerKey(principal);
}

function bindLocalRelay(
  ledger: ResourceOwnershipLedger,
  helpSessionId: string,
  conversationId: string
) {
  const principal = relayOwnershipPrincipal("local", helpSessionId);
  ledger.bindPrincipal(`r-${helpSessionId}`, principal);
  ledger.attachConversation(principal, relayConversationKey("local", conversationId));
  return principalOwnerKey(principal);
}

const flush = () => Promise.resolve();

describe("assistant pane creations kept across a restart (#16845)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    _resetAssistantPaneCreationsForTests();
    vi.useRealTimers();
  });

  it("gives a resumed conversation back the pane it launched before the restart", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    const owner = bindHelp(first, "help-a", "conv-1");
    first.record(owner, [{ kind: "terminal", id: "claude-7f3a" }], "proj-1");
    await flush();
    expect(disk.read()["claude-7f3a"]).toMatchObject({
      scope: "help",
      conversationId: "conv-1",
      projectId: "proj-1",
    });

    const second = startRun(disk);
    expect(second.get(bindHelp(second, "help-b", "conv-1"), "terminal", "claude-7f3a")).toBe(
      undefined
    );
    admitRestoredAssistantPanes("proj-1", ["claude-7f3a"], new Set(["conv-1"]));

    expect(
      second.get(principalOwnerKey(helpOwnershipPrincipal("help-b")), "terminal", "claude-7f3a")
    ).toMatchObject({ id: "claude-7f3a", workspaceId: "proj-1" });
    // Another conversation's bearer gets nothing.
    expect(second.get(bindHelp(second, "help-c", "conv-2"), "terminal", "claude-7f3a")).toBe(
      undefined
    );
  });

  it("gives the pane back to a conversation that resumes after the hydrate as well", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    const second = startRun(disk);
    admitRestoredAssistantPanes("proj-1", ["t1"], new Set(["conv-1"]));
    expect(second.get(bindHelp(second, "help-b", "conv-1"), "terminal", "t1")).toBeDefined();
  });

  it("holds a hydrate's records until the ledger exists, then hands them over", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    _resetAssistantPaneCreationsForTests();
    attachAssistantPaneCreationPersistence(disk.persistence);
    admitRestoredAssistantPanes("proj-1", ["t1"], new Set(["conv-1"]));
    const second = new ResourceOwnershipLedger(assistantPaneCreationObserver);
    attachAssistantPaneCreationLedger(second);

    expect(second.get(bindHelp(second, "help-b", "conv-1"), "terminal", "t1")).toBeDefined();
  });

  it("keeps the local relay's creations too, with when its conversation last called", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(
      bindLocalRelay(first, "help-a", "conv-1"),
      [{ kind: "terminal", id: "t1" }],
      "proj-2"
    );
    await flush();
    expect(disk.read().t1).toEqual({
      scope: "localRelay",
      conversationId: "conv-1",
      projectId: "proj-2",
      seenAt: T0,
      lastCallAt: T0,
    });

    const second = startRun(disk);
    expect(keptLocalRelayConversations()).toEqual([{ conversationId: "conv-1", usedAt: T0 }]);
    admitRestoredAssistantPanes("proj-2", ["t1"], new Set(["conv-1"]));
    expect(second.get(bindLocalRelay(second, "help-b", "conv-1"), "terminal", "t1")).toBeDefined();
    // The same conversation's direct help bearer is another holder.
    expect(second.get(bindHelp(second, "help-b", "conv-1"), "terminal", "t1")).toBeUndefined();
  });

  it("keeps nothing for another machine's relay, a bearer, a caller-named id or an unknown project", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    const remote = relayOwnershipPrincipal("abc123", "help-r");
    ledger.bindPrincipal("r-remote", remote);
    ledger.attachConversation(remote, relayConversationKey("abc123", "conv-r"));
    ledger.record(principalOwnerKey(remote), [{ kind: "terminal", id: "remote" }], "proj-1");
    const bare = helpOwnershipPrincipal("help-x");
    ledger.bindPrincipal("s-x", bare);
    ledger.record(principalOwnerKey(bare), [{ kind: "terminal", id: "unbound" }], "proj-1");
    const owner = bindHelp(ledger, "help-a", "conv-1");
    ledger.record(owner, [{ kind: "terminal", id: "named" }], "proj-1", { callerNamedId: true });
    ledger.record(owner, [{ kind: "terminal", id: "nowhere" }]);
    ledger.record(owner, [{ kind: "worktree", id: "/tmp/wt" }], "proj-1");
    await flush();

    expect(disk.read()).toEqual({});
    // A caller-named creation still holds in this run.
    expect(ledger.get(owner, "terminal", "named")).toBeDefined();
  });

  it("keeps a bearer's creations once it binds its conversation", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    const principal = helpOwnershipPrincipal("help-a");
    ledger.bindPrincipal("s-a", principal);
    ledger.record(principalOwnerKey(principal), [{ kind: "terminal", id: "t1" }], "proj-1");
    ledger.attachConversation(principal, helpConversationKey("conv-1"));
    await flush();

    expect(disk.read().t1).toMatchObject({ scope: "help", conversationId: "conv-1" });
  });

  it("gives back only panes the hydrate of the same project hands back, for a conversation a lane names", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    const owner = bindHelp(first, "help-a", "conv-1");
    first.record(owner, [{ kind: "terminal", id: "t1" }], "proj-1");
    first.record(owner, [{ kind: "terminal", id: "t2" }], "proj-1");
    first.record(
      bindHelp(first, "help-z", "conv-gone"),
      [{ kind: "terminal", id: "t3" }],
      "proj-1"
    );
    await flush();

    const second = startRun(disk);
    const resumed = bindHelp(second, "help-b", "conv-1");
    admitRestoredAssistantPanes("proj-2", ["t1"], new Set(["conv-1"]));
    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    admitRestoredAssistantPanes("proj-1", ["t2", "t3"], new Set(["conv-1"]));
    await flush();

    expect(second.get(resumed, "terminal", "t2")).toBeDefined();
    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    expect(second.get(bindHelp(second, "help-y", "conv-gone"), "terminal", "t3")).toBeUndefined();
    // The conversation no lane named is gone from disk; the pane not handed back stays kept.
    expect(Object.keys(disk.read()).sort()).toEqual(["t1", "t2"]);
  });

  it("lets any creation under the id in a later run end the kept record, even one that records nothing", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    const owner = bindHelp(first, "help-a", "conv-1");
    first.record(owner, [{ kind: "terminal", id: "t1" }], "proj-1");
    first.record(owner, [{ kind: "terminal", id: "t2" }], "proj-1");
    first.record(owner, [{ kind: "terminal", id: "t3" }], "proj-1");
    await flush();

    const second = startRun(disk);
    const other = helpOwnershipPrincipal("help-other");
    second.bindPrincipal("s-other", other);
    second.record(principalOwnerKey(other), [{ kind: "terminal", id: "t1" }], "proj-1");
    second.revokePrincipal(other);
    second.record(principalOwnerKey(other), [{ kind: "terminal", id: "t2" }], "proj-1");
    second.supersede([{ kind: "terminal", id: "t3" }]);
    admitRestoredAssistantPanes("proj-1", ["t1", "t2", "t3"], new Set(["conv-1"]));
    await flush();

    const resumed = bindHelp(second, "help-b", "conv-1");
    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    expect(second.get(resumed, "terminal", "t2")).toBeUndefined();
    expect(second.get(resumed, "terminal", "t3")).toBeUndefined();
    expect(disk.read()).toEqual({});
  });

  it("never lets a later hydrate put back a record this run released", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    const second = startRun(disk);
    const resumed = bindHelp(second, "help-b", "conv-1");
    admitRestoredAssistantPanes("proj-1", ["t1"], new Set(["conv-1"]));
    const record = second.get(resumed, "terminal", "t1");
    second.release(resumed, "terminal", "t1", record);
    admitRestoredAssistantPanes("proj-1", ["t1"], new Set(["conv-1"]));
    await flush();

    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    expect(disk.read()).toEqual({});
  });

  it("forgets a conversation's records, given back or not, when its lane can't resume it", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    const owner = bindHelp(first, "help-a", "conv-1");
    first.record(owner, [{ kind: "terminal", id: "t1" }], "proj-1");
    first.record(owner, [{ kind: "terminal", id: "t2" }], "proj-2");
    await flush();

    const second = startRun(disk);
    admitRestoredAssistantPanes("proj-1", ["t1"], new Set(["conv-1"]));
    second.forgetConversation(helpConversationKey("conv-1"));
    await flush();

    expect(disk.read()).toEqual({});
    admitRestoredAssistantPanes("proj-2", ["t2"], new Set(["conv-1"]));
    expect(second.get(bindHelp(second, "help-b", "conv-1"), "terminal", "t2")).toBeUndefined();
  });

  it("lets nothing the quit tears down end a kept record, while a creation then is still kept", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    const help = bindHelp(ledger, "help-a", "conv-1");
    ledger.record(help, [{ kind: "terminal", id: "t1" }], "proj-1");
    const relay = relayOwnershipPrincipal("local", "help-a");
    ledger.bindPrincipal("r-a", relay);
    ledger.attachConversation(relay, relayConversationKey("local", "conv-1"));
    ledger.record(principalOwnerKey(relay), [{ kind: "terminal", id: "t2" }], "proj-2");
    await flush();

    beginAssistantPaneCreationQuit();
    ledger.revokePrincipal(relay, { dropUnboundConversation: true });
    ledger.forgetConversation(helpConversationKey("conv-1"));
    forgetTrashedAssistantPane("t1");
    const late = bindHelp(ledger, "help-late", "conv-late");
    ledger.record(late, [{ kind: "terminal", id: "t3" }], "proj-1");
    await flush();

    expect(Object.keys(disk.read()).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("drops a pane the person trashed", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    ledger.record(bindHelp(ledger, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    forgetTrashedAssistantPane("t1");
    await flush();
    expect(disk.read()).toEqual({});
  });

  it("ends a given-back record when a plugin launches a pane under the id", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    const second = startRun(disk);
    const resumed = bindHelp(second, "help-b", "conv-1");
    admitRestoredAssistantPanes("proj-1", ["t1"], new Set(["conv-1"]));
    supersedeByPluginLaunch("agent.launch", {
      ok: true,
      result: { launched: true, terminalId: "t1" },
    });
    await flush();

    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    expect(isKeptAssistantPane("t1")).toBe(false);
    expect(disk.read()).toEqual({});
  });

  it("reports kept ids as in use until they are let go", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    const owner = bindHelp(ledger, "help-a", "conv-1");
    ledger.record(owner, [{ kind: "terminal", id: "t1" }], "proj-1");
    expect(isKeptAssistantPane("t1")).toBe(true);
    ledger.release(owner, "terminal", "t1");
    expect(isKeptAssistantPane("t1")).toBe(false);
  });

  it("gives back no local relay pane whose conversation's day ran out, and keeps it fresh while it calls", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(
      bindLocalRelay(first, "help-a", "conv-1"),
      [{ kind: "terminal", id: "t1" }],
      "proj-1"
    );
    first.record(
      bindLocalRelay(first, "help-b", "conv-2"),
      [{ kind: "terminal", id: "t2" }],
      "proj-1"
    );
    await flush();
    vi.setSystemTime(T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS - 60_000);
    noteLocalRelayCall("conv-2");
    await flush();
    vi.setSystemTime(T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS + 60_000);

    const second = startRun(disk);
    admitRestoredAssistantPanes("proj-1", ["t1", "t2"], new Set(["conv-1", "conv-2"]));

    expect(
      second.get(bindLocalRelay(second, "help-c", "conv-1"), "terminal", "t1")
    ).toBeUndefined();
    expect(second.get(bindLocalRelay(second, "help-d", "conv-2"), "terminal", "t2")).toBeDefined();
  });

  it("drops malformed, expired and future records on load, and holds the cap", async () => {
    const valid = { scope: "help", conversationId: "c", projectId: "p", seenAt: T0 };
    const disk = makeDisk({
      ok: valid,
      badScope: { ...valid, scope: "remote" },
      noProject: { ...valid, projectId: "" },
      expired: { ...valid, seenAt: T0 - STORED_ASSISTANT_PANE_CREATION_TTL_MS - 1 },
      future: { ...valid, seenAt: T0 + 10 * 60_000 },
      relayNoCall: { ...valid, scope: "localRelay" },
      notAnObject: "x",
    });
    startRun(disk);
    await flush();
    expect(Object.keys(disk.read())).toEqual(["ok"]);

    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_STORED_ASSISTANT_PANE_CREATIONS + 5; i++) {
      many[`t${i}`] = { ...valid, seenAt: T0 - (MAX_STORED_ASSISTANT_PANE_CREATIONS + 5 - i) };
    }
    const crowded = makeDisk(many);
    startRun(crowded);
    await flush();
    const kept = Object.keys(crowded.read());
    expect(kept).toHaveLength(MAX_STORED_ASSISTANT_PANE_CREATIONS);
    expect(kept).not.toContain("t0");
  });

  it("writes once for every change one ledger operation makes", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    const owner = bindHelp(ledger, "help-a", "conv-1");
    ledger.record(
      owner,
      [
        { kind: "terminal", id: "t1" },
        { kind: "terminal", id: "t2" },
        { kind: "terminal", id: "t3" },
      ],
      "proj-1"
    );
    await flush();
    expect(disk.save).toHaveBeenCalledTimes(1);
  });
});
