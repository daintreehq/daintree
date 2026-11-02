import { afterEach, describe, expect, it, vi } from "vitest";
import { recordOwnershipFromDispatch } from "../sessionCallOwnership.js";
import {
  helpOwnershipPrincipal,
  principalOwnerKey,
  relayOwnershipPrincipal,
} from "../resourceOwnership.js";
import { setAssistantWorkerSink } from "../../scheduledRuns/assistantWorkerLaunches.js";
import type { DispatchEnvelope } from "../shared.js";

afterEach(() => {
  setAssistantWorkerSink(null);
});

// A session with no authority left: a launch still happened, and is still the run's.
const sessionStore = {
  resourceOwnership: { isPrincipalOwner: () => false },
  terminalAdoption: {},
  workerCreations: {},
  hasLiveTransport: () => false,
  sessionWorkspaceMap: new Map([["mcp-1", "project-bound"]]),
} as never;

const envelope = (result: DispatchEnvelope["result"], workspaceId?: string): DispatchEnvelope =>
  ({
    result,
    ...(workspaceId
      ? { dispatchedWorkspace: { kind: "project", workspaceId, workspacePath: "/repo" } }
      : {}),
  }) as DispatchEnvelope;

const NOT_OWNED = {
  ownedResource: undefined,
  ownedResourceId: undefined,
  ownedResourceRecord: undefined,
};

describe("an assistant's launches, seen where they're recorded (#16169)", () => {
  it("tells the run history what a help session's launch was answered with, and where it ran", () => {
    const sink = vi.fn();
    setAssistantWorkerSink(sink);

    recordOwnershipFromDispatch(
      {
        sessionId: "mcp-1",
        actionId: "agent.launch",
        sessionStore,
        ownershipOwner: principalOwnerKey(helpOwnershipPrincipal("help-1")),
        args: { agentId: "claude" },
        askedAt: 42,
      },
      NOT_OWNED,
      envelope({ ok: true, result: { launched: true, terminalId: "t-1" } }, "project-1")
    );

    expect(sink).toHaveBeenCalledWith({
      helpSessionId: "help-1",
      tool: "agent.launch",
      args: { agentId: "claude" },
      result: { launched: true, terminalId: "t-1" },
      hostId: null,
      hostName: null,
      projectId: "project-1",
      askedAt: 42,
    });
  });

  it("falls back to the session's bound project when the dispatch named none", () => {
    const sink = vi.fn();
    setAssistantWorkerSink(sink);

    recordOwnershipFromDispatch(
      {
        sessionId: "mcp-1",
        actionId: "agent.launch",
        sessionStore,
        ownershipOwner: principalOwnerKey(helpOwnershipPrincipal("help-1")),
      },
      NOT_OWNED,
      envelope({ ok: true, result: { launched: true, terminalId: "t-1" } })
    );

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-bound" }));
  });

  it("says nothing for another machine's assistant, a pane bearer, or a launch that didn't happen", () => {
    const sink = vi.fn();
    setAssistantWorkerSink(sink);
    const launched = envelope({ ok: true, result: { launched: true, terminalId: "t-1" } });

    for (const ownershipOwner of [
      principalOwnerKey(relayOwnershipPrincipal("sender", "help-1")),
      principalOwnerKey("pane-bearer"),
    ]) {
      recordOwnershipFromDispatch(
        { sessionId: "mcp-1", actionId: "agent.launch", sessionStore, ownershipOwner },
        NOT_OWNED,
        launched
      );
    }
    recordOwnershipFromDispatch(
      {
        sessionId: "mcp-1",
        actionId: "agent.launch",
        sessionStore,
        ownershipOwner: principalOwnerKey(helpOwnershipPrincipal("help-1")),
      },
      NOT_OWNED,
      envelope({ ok: true, result: { launched: false, terminalId: null } })
    );

    expect(sink).not.toHaveBeenCalled();
  });
});
