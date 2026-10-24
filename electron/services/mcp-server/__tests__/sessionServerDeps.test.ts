import { describe, expect, it, vi } from "vitest";

vi.mock("../../../store.js", () => ({ store: { get: vi.fn() } }));
vi.mock("electron", () => ({ webContents: { fromId: () => null } }));

import {
  createSessionServerDeps,
  type SessionServerDepsHost,
  type SessionServerDepsSource,
} from "../sessionServerDeps.js";
import { SessionBindingError } from "../rendererBridge.js";
import { helpNotifyKey } from "../terminalNotify.js";
import type { AssistantControlBinding, McpSessionOrigin } from "../shared.js";

const WS_A = "a".repeat(64);

function fakeSource(): SessionServerDepsSource {
  return {
    sessionStore: {
      sessionWebContentsMap: new Map<string, number>(),
      sessionContextMap: new Map(),
      sessionOriginMap: new Map<string, McpSessionOrigin>(),
      sessionViewlessHelpMap: new Map<string, string>(),
      sessionHelpIdMap: new Map<string, string>(),
      getOrigin(sessionId: string) {
        return this.sessionOriginMap.get(sessionId) ?? "external";
      },
      isRendererOwnedOrigin(sessionId: string) {
        return this.getOrigin(sessionId) === "help";
      },
    },
    turnOutcomeService: { getCurrentTurnIdForSession: vi.fn(() => "turn-1") },
    requestManifest: vi.fn(),
    dispatchAction: vi.fn(),
    getCachedManifest: vi.fn(() => null),
  } as unknown as SessionServerDepsSource;
}

/** A host whose state can change after the session is built, as HttpLifecycle's does. */
function mutableHost() {
  const state: {
    binding: AssistantControlBinding | null;
    terminalFor: ((helpSessionId: string) => string | null) | null;
  } = { binding: null, terminalFor: null };
  const host: SessionServerDepsHost = {
    registry: () => null,
    assistantControlBinding: () => state.binding,
    helpSessionTerminalResolver: () => state.terminalFor,
    getBearerInfoForSession: () => null,
    assistantControl: {} as AssistantControlBinding["control"],
  };
  return { state, host };
}

describe("createSessionServerDeps", () => {
  it("reads the host's state when a call needs it, never when the session is built", () => {
    const deps = fakeSource();
    deps.sessionStore.sessionOriginMap.set("s", "help");
    deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
    const { state, host } = mutableHost();

    const sessionDeps = createSessionServerDeps(deps, host, { sessionId: "s" });

    expect(sessionDeps.assistantControl).toBe(host.assistantControl);
    expect(sessionDeps.assistantCaller?.()).toBeNull();
    expect(sessionDeps.resolveOwnPane?.()).toBeNull();

    state.binding = {
      control: {} as AssistantControlBinding["control"],
      sessionProject: () => WS_A,
    };
    state.terminalFor = () => "term-1";

    expect(sessionDeps.assistantCaller?.()).toEqual({
      kind: "local",
      helpSessionId: "help-1",
      projectId: WS_A,
      machineName: "this machine",
    });
    expect(sessionDeps.resolveOwnPane?.()).toEqual({
      key: helpNotifyKey("help-1"),
      terminalId: "term-1",
    });
  });

  it("keeps the pin and help-session id it captured after teardown clears the store", async () => {
    const deps = fakeSource();
    deps.sessionStore.sessionOriginMap.set("s", "help");
    deps.sessionStore.sessionWebContentsMap.set("s", 7);
    deps.sessionStore.sessionHelpIdMap.set("s", "help-1");

    const sessionDeps = createSessionServerDeps(deps, mutableHost().host, { sessionId: "s" });

    deps.sessionStore.sessionOriginMap.clear();
    deps.sessionStore.sessionWebContentsMap.clear();
    deps.sessionStore.sessionHelpIdMap.clear();

    await expect(sessionDeps.requestManifest()).rejects.toBeInstanceOf(SessionBindingError);
    await expect(sessionDeps.dispatchAction("agent.launch", {}, false)).rejects.toBeInstanceOf(
      SessionBindingError
    );
    expect(deps.requestManifest).not.toHaveBeenCalled();
    expect(deps.dispatchAction).not.toHaveBeenCalled();

    expect(sessionDeps.getCurrentTurnId?.()).toBe("turn-1");
    expect(deps.turnOutcomeService.getCurrentTurnIdForSession).toHaveBeenCalledWith("help-1");
  });
});
