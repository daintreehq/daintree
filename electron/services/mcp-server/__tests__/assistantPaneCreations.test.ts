import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceOwnershipLedger,
  helpConversationKey,
  helpOwnershipPrincipal,
  principalOwnerKey,
  relayConversationKey,
  relayOwnershipPrincipal,
} from "../resourceOwnership.js";
import { TerminalAdoptionLedger } from "../terminalAdoption.js";
import {
  LOCAL_RELAY_CONVERSATION_RETENTION_MS,
  MAX_STORED_ASSISTANT_PANE_CREATIONS,
  STORED_ASSISTANT_PANE_CREATION_TTL_MS,
  _resetAssistantPaneCreationsForTests,
  admitRestoredAssistantPanes,
  assistantPaneCreationLedgerFor,
  assistantPaneCreationObserver,
  attachAssistantPaneCreationLedger,
  attachAssistantPaneCreationPersistence,
  beginAssistantPaneCreationQuit,
  forgetTrashedAssistantPane,
  isKeptAssistantPane,
  keptLocalRelayConversations,
  noteLocalRelayCall,
  supersedeAssistantPane,
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

/** A restored pane as the hydrate hands it back, stamped as each surface launches. */
const byHelp = (id: string) => ({ id, spawnedBy: "assistant" });
const byRelay = (id: string) => ({ id, spawnedBy: "mcp" });

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
    admitRestoredAssistantPanes("proj-1", [byHelp("claude-7f3a")], new Set(["conv-1"]));

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
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
    expect(second.get(bindHelp(second, "help-b", "conv-1"), "terminal", "t1")).toBeDefined();
  });

  it("holds a hydrate's records until the ledger exists, then hands them over", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    _resetAssistantPaneCreationsForTests();
    attachAssistantPaneCreationPersistence(disk.persistence);
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
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
    admitRestoredAssistantPanes("proj-2", [byRelay("t1")], new Set(["conv-1"]));
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
    admitRestoredAssistantPanes("proj-2", [byHelp("t1")], new Set(["conv-1"]));
    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    admitRestoredAssistantPanes("proj-1", [byHelp("t2"), byHelp("t3")], new Set(["conv-1"]));
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
    second.supersedeRestored([{ kind: "terminal", id: "t3" }], "proj-1");
    admitRestoredAssistantPanes(
      "proj-1",
      [byHelp("t1"), byHelp("t2"), byHelp("t3")],
      new Set(["conv-1"])
    );
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
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
    const record = second.get(resumed, "terminal", "t1");
    second.release(resumed, "terminal", "t1", record);
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
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
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
    second.forgetConversation(helpConversationKey("conv-1"));
    await flush();

    expect(disk.read()).toEqual({});
    admitRestoredAssistantPanes("proj-2", [byHelp("t2")], new Set(["conv-1"]));
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
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
    supersedeByPluginLaunch(
      "agent.launch",
      { ok: true, result: { launched: true, terminalId: "t1" } },
      "proj-1"
    );
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
    admitRestoredAssistantPanes(
      "proj-1",
      [byRelay("t1"), byRelay("t2")],
      new Set(["conv-1", "conv-2"])
    );

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
    expect(Object.keys(disk.read()).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("gives back nothing for a pane under the id that another surface launched, and lets the record go", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    const second = startRun(disk);
    admitRestoredAssistantPanes(
      "proj-1",
      [{ id: "t1", spawnedBy: "palette" }],
      new Set(["conv-1"])
    );
    await flush();

    expect(second.get(bindHelp(second, "help-b", "conv-1"), "terminal", "t1")).toBeUndefined();
    expect(disk.read()).toEqual({});
  });

  it("applies a creation or trash seen before the records load once they do", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    const owner = bindHelp(first, "help-a", "conv-1");
    for (const id of ["t1", "t2", "t3"]) {
      first.record(owner, [{ kind: "terminal", id }], "proj-1");
    }
    await flush();

    _resetAssistantPaneCreationsForTests();
    supersedeAssistantPane("t1", "proj-1");
    supersedeAssistantPane("t2", "proj-9");
    forgetTrashedAssistantPane("t3");
    attachAssistantPaneCreationPersistence(disk.persistence);
    await flush();

    expect(Object.keys(disk.read())).toEqual(["t2"]);
  });

  it("lets a pane no one recorded end only what an earlier run kept, and only in its workspace", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    const owner = bindHelp(first, "help-a", "conv-1");
    first.record(owner, [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    const second = startRun(disk);
    const resumed = bindHelp(second, "help-b", "conv-1");
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
    second.record(resumed, [{ kind: "terminal", id: "t5" }], "proj-1");
    supersedeByPluginLaunch("agent.launch", { ok: true, result: { terminalId: "t1" } }, "proj-2");
    supersedeByPluginLaunch("agent.launch", { ok: true, result: { terminalId: "t5" } }, "proj-1");
    supersedeByPluginLaunch("terminal.new", { ok: true, result: { terminalId: "t1" } }, "proj-1");
    await flush();

    expect(second.get(resumed, "terminal", "t1")).toBeDefined();
    expect(second.get(resumed, "terminal", "t5")).toBeDefined();
    expect(Object.keys(disk.read()).sort()).toEqual(["t1", "t5"]);

    second.supersedeRestored([{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();
    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    expect(second.creatorOf("terminal", "t1")).toBeUndefined();
    expect(Object.keys(disk.read())).toEqual(["t5"]);
  });

  it("gives nothing back over a terminal the person handed to a pane", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    _resetAssistantPaneCreationsForTests();
    const ledger = new ResourceOwnershipLedger(assistantPaneCreationObserver);
    const handOvers = new TerminalAdoptionLedger();
    attachAssistantPaneCreationPersistence(disk.persistence);
    attachAssistantPaneCreationLedger(assistantPaneCreationLedgerFor(ledger, handOvers));
    handOvers.adopt({ terminalId: "t1", orchestratorPaneId: "pane-o", principalId: "pane-p" });
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));

    expect(ledger.creatorOf("terminal", "t1")).toBeUndefined();
  });

  it("holds one last-call time per relay conversation, written at least every step and at the quit", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    const owner = bindLocalRelay(first, "help-a", "conv-1");
    first.record(owner, [{ kind: "terminal", id: "p" }], "proj-1");
    vi.setSystemTime(T0 + 9 * 60_000);
    first.record(owner, [{ kind: "terminal", id: "q" }], "proj-1");
    await flush();
    noteLocalRelayCall("conv-1", T0 + 12 * 60_000);
    await flush();
    // Under a step since the last write: held, not written.
    expect(disk.read().p.lastCallAt).toBe(T0 + 9 * 60_000);
    beginAssistantPaneCreationQuit();
    expect(disk.read().p.lastCallAt).toBe(T0 + 12 * 60_000);
    expect(disk.read().q.lastCallAt).toBe(T0 + 12 * 60_000);

    vi.setSystemTime(T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS + 5 * 60_000);
    const second = startRun(disk);
    expect(keptLocalRelayConversations()).toEqual([
      { conversationId: "conv-1", usedAt: T0 + 12 * 60_000 },
    ]);
    admitRestoredAssistantPanes("proj-1", [byRelay("p"), byRelay("q")], new Set(["conv-1"]));
    const resumed = bindLocalRelay(second, "help-b", "conv-1");
    expect(second.get(resumed, "terminal", "p")).toBeDefined();
    expect(second.get(resumed, "terminal", "q")).toBeDefined();
  });

  it("drops what creations before the load name only in the workspaces they ran in", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-3");
    await flush();

    _resetAssistantPaneCreationsForTests();
    supersedeAssistantPane("t1", "proj-1");
    supersedeAssistantPane("t1", "proj-2");
    attachAssistantPaneCreationPersistence(disk.persistence);
    await flush();

    expect(Object.keys(disk.read())).toEqual(["t1"]);
  });

  it("ends a given-back record when a later hydrate shows another surface's pane under the id", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    const second = startRun(disk);
    const resumed = bindHelp(second, "help-b", "conv-1");
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
    expect(second.get(resumed, "terminal", "t1")).toBeDefined();
    admitRestoredAssistantPanes(
      "proj-1",
      [{ id: "t1", spawnedBy: "palette" }],
      new Set(["conv-1"])
    );
    await flush();

    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    expect(disk.read()).toEqual({});
  });

  it("leaves a record this run made to the ledger, whatever an older snapshot of the id says", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    const owner = bindHelp(ledger, "help-a", "conv-1");
    ledger.record(owner, [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    admitRestoredAssistantPanes(
      "proj-1",
      [{ id: "t1", spawnedBy: "palette" }],
      new Set(["conv-1"])
    );
    await flush();

    expect(ledger.get(owner, "terminal", "t1")).toBeDefined();
    expect(Object.keys(disk.read())).toEqual(["t1"]);
  });

  it("gives nothing back while the id runs in another project, and keeps the record for later", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t2" }], "proj-1");
    await flush();

    _resetAssistantPaneCreationsForTests();
    const second = new ResourceOwnershipLedger(assistantPaneCreationObserver);
    attachAssistantPaneCreationPersistence(disk.persistence);
    attachAssistantPaneCreationLedger(
      assistantPaneCreationLedgerFor(second, new TerminalAdoptionLedger(), (id) =>
        id === "t1" ? "proj-other" : id === "t2" ? "proj-1" : null
      )
    );
    admitRestoredAssistantPanes("proj-1", [byHelp("t1"), byHelp("t2")], new Set(["conv-1"]));
    const resumed = bindHelp(second, "help-b", "conv-1");
    await flush();

    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
    expect(second.get(resumed, "terminal", "t2")).toBeDefined();
    expect(Object.keys(disk.read()).sort()).toEqual(["t1", "t2"]);
  });

  it("ends a given-back record when another surface's pane shows up under it, kept on disk or not", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(bindHelp(first, "help-a", "conv-1"), [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();

    const second = startRun(disk);
    const resumed = bindHelp(second, "help-b", "conv-1");
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
    // No longer kept on disk (crowded out, say), still given back in this run.
    forgetTrashedAssistantPane("t1");
    admitRestoredAssistantPanes(
      "proj-1",
      [{ id: "t1", spawnedBy: "palette" }],
      new Set(["conv-1"])
    );

    expect(second.get(resumed, "terminal", "t1")).toBeUndefined();
  });

  it("lets an early relay call keep a conversation only if it came back within its day", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(
      bindLocalRelay(first, "help-a", "conv-1"),
      [{ kind: "terminal", id: "t1" }],
      "proj-1"
    );
    await flush();

    vi.setSystemTime(T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS + 60 * 60_000);
    _resetAssistantPaneCreationsForTests();
    noteLocalRelayCall("conv-1", T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS + 60_000);
    attachAssistantPaneCreationPersistence(disk.persistence);
    await flush();

    expect(isKeptAssistantPane("t1")).toBe(false);
    expect(disk.read()).toEqual({});
  });

  it("ends a given-back record, but nothing kept on disk, for a launch whose workspace isn't known", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    const owner = bindHelp(first, "help-a", "conv-1");
    first.record(owner, [{ kind: "terminal", id: "t1" }], "proj-1");
    first.record(owner, [{ kind: "terminal", id: "t2" }], "proj-1");
    await flush();

    const second = startRun(disk);
    admitRestoredAssistantPanes("proj-1", [byHelp("t1")], new Set(["conv-1"]));
    supersedeByPluginLaunch("agent.launch", { ok: true, result: { terminalId: "t1" } }, null);
    supersedeByPluginLaunch("agent.launch", { ok: true, result: { terminalId: "t2" } }, null);
    await flush();

    expect(second.creatorOf("terminal", "t1")).toBeUndefined();
    expect(Object.keys(disk.read())).toEqual(["t2"]);
  });

  it("lets an early relay call that came back in time keep nothing a day after it", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(
      bindLocalRelay(first, "help-a", "conv-1"),
      [{ kind: "terminal", id: "t1" }],
      "proj-1"
    );
    await flush();

    _resetAssistantPaneCreationsForTests();
    noteLocalRelayCall("conv-1", T0 + 60 * 60_000);
    vi.setSystemTime(T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS + 2 * 60 * 60_000);
    attachAssistantPaneCreationPersistence(disk.persistence);

    expect(isKeptAssistantPane("t1")).toBe(false);
  });

  it("tries a failed write again at the quit, a dropped record included", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    const owner = bindHelp(ledger, "help-a", "conv-1");
    ledger.record(owner, [{ kind: "terminal", id: "t1" }], "proj-1");
    await flush();
    disk.save.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    ledger.release(owner, "terminal", "t1");
    await flush();
    expect(Object.keys(disk.read())).toEqual(["t1"]);

    beginAssistantPaneCreationQuit();

    expect(disk.read()).toEqual({});
  });

  it("counts a relay call made before the records load", async () => {
    const disk = makeDisk();
    const first = startRun(disk);
    first.record(
      bindLocalRelay(first, "help-a", "conv-1"),
      [{ kind: "terminal", id: "t1" }],
      "proj-1"
    );
    await flush();

    vi.setSystemTime(T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS + 60_000);
    _resetAssistantPaneCreationsForTests();
    noteLocalRelayCall("conv-1", T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS - 60_000);
    attachAssistantPaneCreationPersistence(disk.persistence);

    expect(isKeptAssistantPane("t1")).toBe(true);
    expect(keptLocalRelayConversations()).toEqual([
      { conversationId: "conv-1", usedAt: T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS - 60_000 },
    ]);
    // Ahead of the disk by more than a step, so the load writes it.
    await flush();
    expect(disk.read().t1.lastCallAt).toBe(T0 + LOCAL_RELAY_CONVERSATION_RETENTION_MS - 60_000);
  });

  it("writes a relay call that lands during the quit at once, and retries a failed write there", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    ledger.record(
      bindLocalRelay(ledger, "help-a", "conv-1"),
      [{ kind: "terminal", id: "t1" }],
      "proj-1"
    );
    await flush();
    disk.save.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    noteLocalRelayCall("conv-1", T0 + 11 * 60_000);
    await flush();
    expect(disk.read().t1.lastCallAt).toBe(T0);

    beginAssistantPaneCreationQuit();
    expect(disk.read().t1.lastCallAt).toBe(T0 + 11 * 60_000);
    noteLocalRelayCall("conv-1", T0 + 12 * 60_000);
    expect(disk.read().t1.lastCallAt).toBe(T0 + 12 * 60_000);
  });

  it("keeps a caller-named creation off disk after its bearer binds the conversation", async () => {
    const disk = makeDisk();
    const ledger = startRun(disk);
    const principal = helpOwnershipPrincipal("help-a");
    ledger.bindPrincipal("s-a", principal);
    ledger.record(principalOwnerKey(principal), [{ kind: "terminal", id: "named" }], "proj-1", {
      callerNamedId: true,
    });
    ledger.record(principalOwnerKey(principal), [{ kind: "terminal", id: "minted" }], "proj-1");
    ledger.attachConversation(principal, helpConversationKey("conv-1"));
    await flush();

    expect(Object.keys(disk.read())).toEqual(["minted"]);
  });
});
