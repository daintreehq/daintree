import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import { SessionStore as RealSessionStore } from "../sessionStore.js";
import {
  helpConversationKey,
  helpOwnershipPrincipal,
  relayConversationKey,
  relayOwnershipPrincipal,
} from "../resourceOwnership.js";
import {
  _resetAssistantPaneCreationsForTests,
  admitRestoredAssistantPanes,
  assistantPaneCreationObserver,
  attachAssistantPaneCreationLedger,
  attachAssistantPaneCreationPersistence,
} from "../assistantPaneCreations.js";
import {
  callTool,
  fakeDeps,
  makeManifestEntry,
  seedLiveSession,
  toolErrorPayload,
} from "./helpers/sessionServerFixture.js";

const PROJECT = { kind: "project" as const, workspaceId: "proj-1", workspacePath: "/repo" };

function manifest(): ActionManifestEntry[] {
  return [
    makeManifestEntry("agent.launch"),
    { ...makeManifestEntry("terminal.closeOwned"), kind: "command", danger: "safe" as const },
  ];
}

// #16845: an Assistant's conversation still owns what it launched after the
// app restarts and the conversation resumes on a new bearer. Each run is a new
// SessionStore over the same kept records, as a restart is.
describe("an Assistant's panes across a restart (#16845)", () => {
  const liveStores: RealSessionStore[] = [];
  let saved: unknown;
  const disk = {
    load: () => saved,
    save: (records: unknown) => {
      saved = JSON.parse(JSON.stringify(records));
    },
  };

  function startRun() {
    _resetAssistantPaneCreationsForTests();
    const store = new RealSessionStore(() => {}, {
      ownershipObserver: assistantPaneCreationObserver,
    });
    liveStores.push(store);
    attachAssistantPaneCreationPersistence(disk);
    attachAssistantPaneCreationLedger(store.resourceOwnership);
    // The launch takes the id main wrote into its arguments, as the renderer does.
    const dispatchAction = vi.fn().mockImplementation((actionId: string, args: unknown) => {
      const { requestedId, terminalId } = (args ?? {}) as Record<string, string>;
      if (actionId === "agent.launch") {
        return Promise.resolve({
          result: { ok: true, result: { launched: true, terminalId: requestedId } },
          dispatchedWorkspace: PROJECT,
        });
      }
      if (actionId === "terminal.close") {
        return Promise.resolve({ result: { ok: true, result: { closedIds: [terminalId] } } });
      }
      return Promise.resolve({ result: { ok: true, result: null } });
    });
    const deps = fakeDeps({
      sessionStore: store,
      dispatchAction,
      requestManifest: vi.fn().mockResolvedValue(manifest()),
      getCachedManifest: vi.fn(() => manifest()),
    });
    return { store, deps, dispatchAction };
  }

  function helpBearer(
    run: ReturnType<typeof startRun>,
    sessionId: string,
    helpSessionId: string,
    conversationId: string
  ) {
    seedLiveSession(run.store, sessionId, "external");
    run.store.sessionOriginMap.set(sessionId, "external");
    const principal = helpOwnershipPrincipal(helpSessionId);
    run.store.resourceOwnership.bindPrincipal(sessionId, principal);
    run.store.resourceOwnership.attachConversation(principal, helpConversationKey(conversationId));
    return createSessionServer(sessionId, run.deps);
  }

  function localRelayBearer(
    run: ReturnType<typeof startRun>,
    sessionId: string,
    helpSessionId: string,
    conversationId: string
  ) {
    seedLiveSession(run.store, sessionId, "external");
    run.store.sessionOriginMap.set(sessionId, "external");
    const principal = relayOwnershipPrincipal("local", helpSessionId);
    run.store.resourceOwnership.bindPrincipal(sessionId, principal);
    run.store.resourceOwnership.attachConversation(
      principal,
      relayConversationKey("local", conversationId)
    );
    return createSessionServer(sessionId, run.deps);
  }

  /** The id main minted for the run's one launch. */
  function launchedId(run: ReturnType<typeof startRun>): string {
    const launch = run.dispatchAction.mock.calls.find(([actionId]) => actionId === "agent.launch");
    return (launch?.[1] as { requestedId: string }).requestedId;
  }

  afterEach(() => {
    while (liveStores.length > 0) {
      const store = liveStores.pop()!;
      store.drain();
      store.grantCache.dispose();
    }
    saved = undefined;
    _resetAssistantPaneCreationsForTests();
    vi.restoreAllMocks();
  });

  it("lets the resumed conversation close the pane it launched before the restart", async () => {
    const before = startRun();
    const launcher = helpBearer(before, "s-help-a", "help-a", "conv-1");
    await callTool(launcher, { name: "agent.launch", arguments: { agentId: "claude" } });
    const id = launchedId(before);
    expect(id).toMatch(/^claude-[0-9a-f]{4}$/);
    await Promise.resolve();

    const after = startRun();
    admitRestoredAssistantPanes("proj-1", [{ id, spawnedBy: "assistant" }], new Set(["conv-1"]));
    const resumed = helpBearer(after, "s-help-b", "help-b", "conv-1");
    const closed = await callTool(resumed, {
      name: "terminal.closeOwned",
      arguments: { terminalId: id },
    });

    expect(closed.isError).toBeUndefined();
    expect(after.dispatchAction).toHaveBeenCalledWith(
      "terminal.close",
      expect.objectContaining({ terminalId: id }),
      false
    );
    // Closed, so the next restart gives it to no one.
    await Promise.resolve();
    expect(saved).toEqual({});
  });

  it("lets the global Assistant's resumed relay conversation close what it launched", async () => {
    const before = startRun();
    const launcher = localRelayBearer(before, "r-help-a", "help-global", "conv-g");
    await callTool(launcher, { name: "agent.launch", arguments: { agentId: "claude" } });
    const id = launchedId(before);
    await Promise.resolve();

    const after = startRun();
    admitRestoredAssistantPanes("proj-1", [{ id, spawnedBy: "mcp" }], new Set(["conv-g"]));
    const resumed = localRelayBearer(after, "r-help-b", "help-global-2", "conv-g");
    const closed = await callTool(resumed, {
      name: "terminal.closeOwned",
      arguments: { terminalId: id },
    });

    expect(closed.isError).toBeUndefined();
  });

  it("gives a fresh conversation nothing after the restart", async () => {
    const before = startRun();
    const launcher = helpBearer(before, "s-help-a", "help-a", "conv-1");
    await callTool(launcher, { name: "agent.launch", arguments: { agentId: "claude" } });
    const id = launchedId(before);
    await Promise.resolve();

    const after = startRun();
    admitRestoredAssistantPanes("proj-1", [{ id, spawnedBy: "assistant" }], new Set(["conv-1"]));
    const fresh = helpBearer(after, "s-help-c", "help-c", "conv-2");
    const refused = await callTool(fresh, {
      name: "terminal.closeOwned",
      arguments: { terminalId: id },
    });

    expect(toolErrorPayload(refused).code).toBe("RESOURCE_NOT_OWNED");
  });

  it("keeps a launch that named its own id for its run only", async () => {
    const before = startRun();
    const launcher = helpBearer(before, "s-help-a", "help-a", "conv-1");
    const launched = await callTool(launcher, {
      name: "agent.launch",
      arguments: { agentId: "claude", requestedId: "mine-1" },
    });
    expect(launched.isError).toBeUndefined();
    expect(
      before.store.resourceOwnership.get(
        before.store.resourceOwnership.ownerOf("s-help-a"),
        "terminal",
        "mine-1"
      )
    ).toBeDefined();
    await Promise.resolve();

    const after = startRun();
    admitRestoredAssistantPanes(
      "proj-1",
      [{ id: "mine-1", spawnedBy: "assistant" }],
      new Set(["conv-1"])
    );
    const resumed = helpBearer(after, "s-help-b", "help-b", "conv-1");
    const refused = await callTool(resumed, {
      name: "terminal.closeOwned",
      arguments: { terminalId: "mine-1" },
    });

    expect(toolErrorPayload(refused).code).toBe("RESOURCE_NOT_OWNED");
    expect(after.dispatchAction).not.toHaveBeenCalledWith(
      "terminal.close",
      expect.anything(),
      expect.anything()
    );
  });

  it("lets a launch that lands after its session was gone end what an earlier run kept for the id", async () => {
    const before = startRun();
    const launcher = helpBearer(before, "s-help-a", "help-a", "conv-1");
    await callTool(launcher, { name: "agent.launch", arguments: { agentId: "claude" } });
    const id = launchedId(before);
    await Promise.resolve();
    expect(Object.keys(saved as object)).toEqual([id]);

    // Next run: an api-key client's launch lands under the same id, and its
    // session is gone by the time the result does.
    const after = startRun();
    seedLiveSession(after.store, "s-api", "external");
    after.store.sessionOriginMap.set("s-api", "external");
    const api = createSessionServer("s-api", after.deps);
    after.dispatchAction.mockImplementationOnce(async () => {
      after.store.sessions.delete("s-api");
      return {
        result: { ok: true, result: { launched: true, terminalId: id } },
        dispatchedWorkspace: PROJECT,
      };
    });
    await callTool(api, { name: "agent.launch", arguments: { agentId: "claude" } });
    admitRestoredAssistantPanes("proj-1", [{ id, spawnedBy: "assistant" }], new Set(["conv-1"]));
    const resumed = helpBearer(after, "s-help-b", "help-b", "conv-1");
    const refused = await callTool(resumed, {
      name: "terminal.closeOwned",
      arguments: { terminalId: id },
    });

    expect(toolErrorPayload(refused).code).toBe("RESOURCE_NOT_OWNED");
    expect(after.store.resourceOwnership.creatorOf("terminal", id)).toBeUndefined();
  });
});
