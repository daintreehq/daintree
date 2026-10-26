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

  // #14474: a close's answer says what the host saw of each closed panel's
  // process only if every session, a host call's relay session included, is
  // handed the reader.
  it.each([
    ["a direct session", {}],
    [
      "a host call's relay session",
      {
        relay: {
          linkSessionId: "link-1",
          senderId: "shell-1",
          helpSessionId: "help-1",
          shellName: "Shell",
        },
      },
    ],
  ])("hands %s the closed-process reader", (_label, capture) => {
    const deps = fakeSource();
    const readClosedPanelProcess = vi.fn();
    (deps as { readClosedPanelProcess?: unknown }).readClosedPanelProcess = readClosedPanelProcess;

    const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
      sessionId: "s",
      ...capture,
    });

    expect(sessionDeps.readClosedPanelProcess).toBe(readClosedPanelProcess);
  });

  // #14552: the target narrows discovery for the global Assistant only if the flag reaches the session.
  it.each([
    ["the global Assistant's", { global: true as const }, true],
    ["a project assistant's", {}, undefined],
  ])("hands %s relay session its caller's classification", (_label, caller, expected) => {
    const sessionDeps = createSessionServerDeps(fakeSource(), mutableHost().host, {
      sessionId: "s",
      relay: {
        linkSessionId: "link-1",
        senderId: "shell-1",
        helpSessionId: "help-1",
        shellName: "Shell",
        ...caller,
      },
    });

    expect(sessionDeps.relay?.global).toBe(expected);
  });

  // #14551: only a relay caller its Shell's runtime named global is handed the
  // steer, from this machine's global Assistant or another's.
  const RELAY = {
    linkSessionId: "link-1",
    senderId: "shell-1",
    helpSessionId: "help-1",
    shellName: "Shell",
  };
  it.each([
    ["another machine's", RELAY],
    ["this machine's", { ...RELAY, local: true as const }],
  ])(
    "hands %s global Assistant the steer, read from the binding at each call",
    async (_l, relay) => {
      const { state, host } = mutableHost();
      const sessionDeps = createSessionServerDeps(fakeSource(), host, {
        sessionId: "s",
        relay: { ...relay, global: true },
      });
      expect(sessionDeps.relay?.global).toBe(true);
      const target = {
        projectId: "p",
        terminalId: "t",
        generation: 1,
        authorize: () => {},
      };

      const refused = { code: "WORKER_NOT_FOUND" };
      const steerOf = (tag: string) => ({
        prompt: vi.fn(async () => `${tag}:prompt`),
        keys: vi.fn(async () => `${tag}:keys`),
        interrupt: vi.fn(async () => `${tag}:interrupt`),
      });
      const bind = (steer: ReturnType<typeof steerOf> | undefined) => {
        state.binding = {
          control: {} as AssistantControlBinding["control"],
          sessionProject: () => null,
          ...(steer ? { steer: steer as never } : {}),
        };
      };
      const prompt = { command: "go", handback: false, machineName: "m" };
      const keys = { keys: ["Enter"] };
      const steer = sessionDeps.globalSteer!;
      const callAll = () =>
        Promise.all([
          steer.prompt(target, prompt),
          steer.keys(target, keys),
          steer.interrupt(target),
        ]);

      // Unbound, every call is refused, never run some other way.
      await expect(steer.prompt(target, prompt)).rejects.toMatchObject(refused);
      await expect(steer.keys(target, keys)).rejects.toMatchObject(refused);
      await expect(steer.interrupt(target)).rejects.toMatchObject(refused);

      const first = steerOf("a");
      bind(first);
      await expect(callAll()).resolves.toEqual(["a:prompt", "a:keys", "a:interrupt"]);
      expect(first.prompt).toHaveBeenCalledWith(target, prompt);
      expect(first.keys).toHaveBeenCalledWith(target, keys);
      expect(first.interrupt).toHaveBeenCalledWith(target);

      // Replaced, then gone: each call reads the binding as it finds it.
      bind(steerOf("b"));
      await expect(callAll()).resolves.toEqual(["b:prompt", "b:keys", "b:interrupt"]);
      bind(undefined);
      await expect(steer.keys(target, keys)).rejects.toMatchObject(refused);
    }
  );

  it.each([
    ["a project assistant's relay session", { relay: RELAY }],
    [
      "this machine's project assistant reaching another project",
      { relay: { ...RELAY, local: true as const } },
    ],
    ["a direct session", {}],
  ])("hands %s no steer", (_label, capture) => {
    const sessionDeps = createSessionServerDeps(fakeSource(), mutableHost().host, {
      sessionId: "s",
      ...capture,
    });
    expect(sessionDeps.globalSteer).toBeUndefined();
    expect(sessionDeps.relay?.global).toBeUndefined();
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
