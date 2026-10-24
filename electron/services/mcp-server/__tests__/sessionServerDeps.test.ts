import { describe, expect, it, vi } from "vitest";

const { webContentsById } = vi.hoisted(() => ({
  webContentsById: new Map<number, { isDestroyed: () => boolean }>(),
}));
vi.mock("../../../store.js", () => ({ store: { get: vi.fn() } }));
vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => webContentsById.get(id) ?? null },
}));

import {
  createSessionServerDeps,
  type SessionServerDepsHost,
  type SessionServerDepsSource,
} from "../sessionServerDeps.js";
import { SessionBindingError } from "../rendererBridge.js";
import { helpNotifyKey } from "../terminalNotify.js";
import type { AssistantControlBinding, McpSessionOrigin } from "../shared.js";
import type { McpBearerIdentity } from "../../../../shared/types/ipc/mcpServer.js";
import type { WindowRegistry } from "../../../window/WindowRegistry.js";

const WS_A = "a".repeat(64);
const SHARED_MANIFEST = [{ id: "shared.only" }];

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
    isAgentPaneInWorkspace: vi.fn(async () => true),
    requestManifest: vi.fn(),
    dispatchAction: vi.fn(async () => ({ result: { ok: true, result: null } })),
    getCachedManifest: vi.fn(() => SHARED_MANIFEST),
  } as unknown as SessionServerDepsSource;
}

/** A host whose state can change after the session is built, as HttpLifecycle's does. */
function mutableHost() {
  const state: {
    registry: WindowRegistry | null;
    binding: AssistantControlBinding | null;
    terminalFor: ((helpSessionId: string) => string | null) | null;
    bearer: McpBearerIdentity | null;
  } = { registry: null, binding: null, terminalFor: null, bearer: null };
  const host: SessionServerDepsHost = {
    registry: () => state.registry,
    assistantControlBinding: () => state.binding,
    helpSessionTerminalResolver: () => state.terminalFor,
    getBearerInfoForSession: () => state.bearer,
    assistantControl: {} as AssistantControlBinding["control"],
  };
  return { state, host };
}

/** A registry whose only view, the given WebContents, shows `workspaceId`. */
function registryShowing(webContentsId: number, workspaceId: string): WindowRegistry {
  return {
    getByWebContentsId: (id: number) =>
      id === webContentsId
        ? {
            services: {
              projectViewManager: { getWorkspaceRefForWebContents: () => ({ workspaceId }) },
            },
          }
        : undefined,
  } as unknown as WindowRegistry;
}

describe("createSessionServerDeps", () => {
  it("asks the host for a help session's registry, binding and terminal when a call needs them", async () => {
    const deps = fakeSource();
    deps.sessionStore.sessionOriginMap.set("s", "help");
    deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
    deps.sessionStore.sessionWebContentsMap.set("s", 7);
    webContentsById.set(7, { isDestroyed: () => false });
    const { state, host } = mutableHost();

    const sessionDeps = createSessionServerDeps(deps, host, { sessionId: "s" });

    expect(sessionDeps.assistantControl).toBe(host.assistantControl);
    expect(sessionDeps.assistantCaller?.()).toBeNull();
    expect(sessionDeps.resolveOwnPane?.()).toBeNull();
    await expect(sessionDeps.isTerminalInPinnedWorkspace?.("term-9")).resolves.toBe(false);

    state.registry = registryShowing(7, WS_A);
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
    await expect(sessionDeps.isTerminalInPinnedWorkspace?.("term-9")).resolves.toBe(true);
    expect(deps.isAgentPaneInWorkspace).toHaveBeenCalledWith("term-9", WS_A);
  });

  it("names the external client the host reports at dispatch time, not at build", async () => {
    const deps = fakeSource();
    const { state, host } = mutableHost();

    const sessionDeps = createSessionServerDeps(deps, host, { sessionId: "x" });
    state.bearer = { token4LastChars: "wxyz", userAgent: "client/1.0" };
    await sessionDeps.dispatchAction("agent.launch", {}, false);

    expect(deps.dispatchAction).toHaveBeenCalledWith(
      "agent.launch",
      {},
      false,
      state.bearer,
      "external"
    );
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
    expect(sessionDeps.getCachedManifest()).toBeNull();
    expect(deps.requestManifest).not.toHaveBeenCalled();
    expect(deps.dispatchAction).not.toHaveBeenCalled();
    expect(deps.getCachedManifest).not.toHaveBeenCalled();

    expect(sessionDeps.getCurrentTurnId?.()).toBe("turn-1");
    expect(deps.turnOutcomeService.getCurrentTurnIdForSession).toHaveBeenCalledWith("help-1");
  });
});
