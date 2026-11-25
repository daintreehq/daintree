import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_REMOTE_CONFIRM_MARGIN_MS } from "../../../../shared/config/mcpConfirmWindow.js";

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
import { setMcpDriveTargetResolver, type McpDriveTarget } from "../driveTarget.js";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import { SessionBindingError } from "../rendererBridge.js";
import { helpNotifyKey } from "../terminalNotify.js";
import { setPluginAssistantReachSource } from "../../plugin/pluginAssistantReach.js";
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

/** Which kind of session the capture stands for; nothing here reads it but the deps it is copied to. */
const ROLE = "external-client" as const;
describe("a session in a view reopening a saved session (#16341)", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  function inView() {
    const deps = fakeSource();
    deps.handleAgentResumeOwned = vi.fn();
    deps.sessionStore.sessionWebContentsMap.set("s", 7);
    webContentsById.set(7, { isDestroyed: () => false });
    const { state, host } = mutableHost();
    state.registry = registryShowing(7, WS_A);
    return {
      deps,
      sessionDeps: createSessionServerDeps(deps, host, { sessionId: "s", role: ROLE }),
    };
  }

  /** The lease's answer for the view's project; every other project is vacant. */
  const driven = (target: McpDriveTarget, projectId = WS_A) => {
    restore = setMcpDriveTargetResolver((asked) =>
      asked === projectId ? target : { state: "vacant" }
    );
  };

  it("runs while routing is off, a view here drives, or nobody does", () => {
    const { sessionDeps } = inView();
    expect(sessionDeps.refuseViewWrite?.(undefined)).toBeNull();

    driven({ state: "vacant" });
    expect(sessionDeps.refuseViewWrite?.(undefined)).toBeNull();

    driven({ state: "live", endpoint: { kind: "local-view", isClosed: () => false } as never });
    expect(sessionDeps.refuseViewWrite?.(undefined)).toBeNull();
  });

  it("refuses behind another machine's drive, naming it", () => {
    const { sessionDeps } = inView();
    driven({
      state: "live",
      endpoint: { kind: "remote-view", linkSessionId: "link-1", isClosed: () => false } as never,
      holderName: "studio-02",
    });

    const refusal = sessionDeps.refuseViewWrite?.(undefined);

    expect(refusal?.code).toBe("DRIVEN_ELSEWHERE");
    expect(refusal?.message).toContain("studio-02");
  });

  it("asks about the project it is named, once the view that showed it has gone", () => {
    const { deps, sessionDeps } = inView();
    driven({
      state: "live",
      endpoint: { kind: "remote-view", linkSessionId: "link-1", isClosed: () => false } as never,
      holderName: "studio-02",
    });
    deps.sessionStore.sessionWebContentsMap.delete("s");

    expect(sessionDeps.refuseViewWrite?.(undefined)).toBeNull();
    expect(sessionDeps.refuseViewWrite?.(WS_A)?.code).toBe("DRIVEN_ELSEWHERE");
  });

  it("refuses while the holder can't be reached", () => {
    const { sessionDeps } = inView();
    driven({ state: "unavailable", reason: "reserved" });

    expect(sessionDeps.refuseViewWrite?.(undefined)?.code).toBe("DRIVEN_ELSEWHERE");
  });

  it("reopens in the project the view shows, asking the caller's own check", async () => {
    const { deps, sessionDeps } = inView();
    const { signal } = new AbortController();
    const authorize = vi.fn();

    await sessionDeps.handleAgentResumeOwned({ sessionId: "x" }, signal, authorize);

    expect(deps.handleAgentResumeOwned).toHaveBeenCalledWith(
      { sessionId: "x" },
      WS_A,
      signal,
      authorize
    );
  });
});

describe("createSessionServerDeps", () => {
  it("asks the host for a help session's registry, binding and terminal when a call needs them", async () => {
    const deps = fakeSource();
    deps.sessionStore.sessionOriginMap.set("s", "help");
    deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
    deps.sessionStore.sessionWebContentsMap.set("s", 7);
    webContentsById.set(7, { isDestroyed: () => false });
    const { state, host } = mutableHost();

    const sessionDeps = createSessionServerDeps(deps, host, { sessionId: "s", role: ROLE });

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
  ])("hands %s the closed-process and closed-pane worktree readers", (_label, capture) => {
    const deps = fakeSource();
    const readClosedPanelProcess = vi.fn();
    const readClosingAgentPane = vi.fn();
    const readClosedPaneWorktrees = vi.fn();
    Object.assign(deps, { readClosedPanelProcess, readClosingAgentPane, readClosedPaneWorktrees });

    const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
      sessionId: "s",
      role: ROLE,
      ...capture,
    });

    expect(sessionDeps.readClosedPanelProcess).toBe(readClosedPanelProcess);
    // #18173: every agent close's answer says what its worktree holds.
    expect(sessionDeps.readClosingAgentPane).toBe(readClosingAgentPane);
    expect(sessionDeps.readClosedPaneWorktrees).toBe(readClosedPaneWorktrees);
  });

  // #15729: an owned worktree delete refuses outright without it; #15737: a
  // retirement refuses outright without the git reader.
  it("hands a local and a relayed session the terminal process and git readers", () => {
    const deps = fakeSource();
    const readTerminalProcesses = vi.fn();
    const readWorktreeGit = vi.fn();
    (deps as { readTerminalProcesses?: unknown }).readTerminalProcesses = readTerminalProcesses;
    (deps as { readWorktreeGit?: unknown }).readWorktreeGit = readWorktreeGit;

    for (const capture of [
      {},
      {
        relay: {
          linkSessionId: "link-1",
          senderId: "shell-1",
          helpSessionId: "help-1",
          shellName: "Shell",
        },
      },
    ]) {
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
        ...capture,
      });
      expect(sessionDeps.readTerminalProcesses).toBe(readTerminalProcesses);
      expect(sessionDeps.readWorktreeGit).toBe(readWorktreeGit);
    }
  });

  // #14552: the target narrows discovery for the global Assistant only if the flag reaches the session.
  it.each([
    ["the global Assistant's", { global: true as const }, true],
    ["a project assistant's", {}, undefined],
  ])("hands %s relay session its caller's classification", (_label, caller, expected) => {
    const sessionDeps = createSessionServerDeps(fakeSource(), mutableHost().host, {
      sessionId: "s",
      role: ROLE,
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

  // #18153: the session reads `local` beside `global` to reach plugin actions,
  // so the projection must carry it, and only for the in-process relay.
  it.each([
    ["this machine's own relay", { local: true as const }, true],
    ["another machine's relay", {}, undefined],
  ])("hands %s session its locality", (_label, caller, expected) => {
    const sessionDeps = createSessionServerDeps(fakeSource(), mutableHost().host, {
      sessionId: "s",
      role: ROLE,
      relay: {
        linkSessionId: "link-1",
        senderId: "shell-1",
        helpSessionId: "help-1",
        shellName: "Shell",
        global: true,
        ...caller,
      },
    });

    expect(sessionDeps.relay?.local).toBe(expected);
  });

  // #15698: the Shell's view can only match a dispatch to its own call if the call is named.
  it("names the Shell's own call on each of a relay session's dispatches, and only its own", async () => {
    const bound = (relay?: Record<string, unknown>) => {
      const deps = fakeSource();
      const dispatchActionForWorkspace = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      (deps as { dispatchActionForWorkspace?: unknown }).dispatchActionForWorkspace =
        dispatchActionForWorkspace;
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
        workspaceBinding: { workspaceId: WS_A },
        ...(relay ? { relay: relay as never } : {}),
      });
      const relays = () =>
        dispatchActionForWorkspace.mock.calls.map(
          (call) => ((call as unknown[])[5] as { relay?: { call?: unknown } } | undefined)?.relay
        );
      return { sessionDeps, relays };
    };
    const caller = {
      linkSessionId: "link-1",
      senderId: "shell-1",
      helpSessionId: "help-1",
      shellName: "Shell",
    };

    for (const relay of [caller, { ...caller, local: true as const }]) {
      const { sessionDeps, relays } = bound(relay);
      const del = { worktreeId: "/wt" };
      await sessionDeps.dispatchAction("worktree.delete", del, false, undefined, "call-1");
      await sessionDeps.dispatchAction("worktree.delete", del, false, undefined, "call-2");
      await sessionDeps.dispatchAction("worktree.delete", del, false);
      const [first, second, unnamed] = relays();
      expect(first?.call).toEqual({ callId: "call-1", helpSessionId: "help-1" });
      expect(second?.call).toEqual({ callId: "call-2", helpSessionId: "help-1" });
      expect(unnamed).toBeDefined();
      expect(unnamed).not.toHaveProperty("call");
    }

    // A session that isn't relayed carries no relay, whatever id reaches it.
    const { sessionDeps, relays } = bound();
    await sessionDeps.dispatchAction(
      "worktree.delete",
      { worktreeId: "/wt" },
      false,
      undefined,
      "call-1"
    );
    expect(relays()).toEqual([undefined]);
  });

  // #17917: a local call's matcher reaches its dispatch bound to that one call,
  // and another machine's relay never carries one.
  it("binds a local relay's next-fallback matcher to the call each dispatch runs", async () => {
    const ran = vi.fn();
    const offers = vi.fn(() => ran);
    const bound = (relay: Record<string, unknown>) => {
      const deps = fakeSource();
      const dispatchActionForWorkspace = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      (deps as { dispatchActionForWorkspace?: unknown }).dispatchActionForWorkspace =
        dispatchActionForWorkspace;
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
        workspaceBinding: { workspaceId: WS_A },
        relay: relay as never,
      });
      type Bound = (p: string, a: string, x: unknown) => (() => void) | null;
      const matchers = () =>
        dispatchActionForWorkspace.mock.calls.map(
          (call) =>
            ((call as unknown[])[5] as { relay?: { nextFallback?: Bound } } | undefined)?.relay
              ?.nextFallback
        );
      return { sessionDeps, matchers };
    };
    const caller = {
      linkSessionId: "local",
      senderId: "local",
      helpSessionId: "help-1",
      shellName: "Mac",
      nextFallback: offers,
    };
    const move = { terminalId: "t-1", presetId: "work" };

    const local = bound({ ...caller, local: true });
    await local.sessionDeps.dispatchAction(
      "terminal.restartOnPreset",
      move,
      false,
      undefined,
      "call-1"
    );
    await local.sessionDeps.dispatchAction("terminal.restartOnPreset", move, false);
    const [named, unnamed] = local.matchers();
    expect(named?.("proj-1", "terminal.restartOnPreset", move)).toBe(ran);
    expect(offers).toHaveBeenCalledWith({
      callId: "call-1",
      helpSessionId: "help-1",
      projectId: "proj-1",
      actionId: "terminal.restartOnPreset",
      args: move,
    });
    expect(unnamed).toBeUndefined();

    const remote = bound(caller);
    await remote.sessionDeps.dispatchAction(
      "terminal.restartOnPreset",
      move,
      false,
      undefined,
      "call-2"
    );
    expect(remote.matchers()).toEqual([undefined]);
  });

  // #18153: only this machine's own global Assistant's call tells the view who
  // asked, and a plugin's opted-in query never reads as one another machine's
  // driving view could answer.
  it("marks the local global Assistant's dispatches, and never counts a plugin action a read", async () => {
    const REACH = "acme.stages.inspect";
    const uninstall = setPluginAssistantReachSource({
      has: (id) => id === REACH,
      ids: () => [REACH],
    });
    try {
      const bound = (relay: Record<string, unknown>) => {
        const deps = fakeSource();
        const queries = [
          { id: REACH, kind: "query", danger: "confirm" },
          { id: "terminal.list", kind: "query", danger: "safe" },
        ];
        (deps as { getCachedManifest?: unknown }).getCachedManifest = vi.fn(() => queries);
        const dispatchActionForWorkspace = vi.fn(async () => ({
          result: { ok: true, result: null },
        }));
        (deps as { dispatchActionForWorkspace?: unknown }).dispatchActionForWorkspace =
          dispatchActionForWorkspace;
        const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
          sessionId: "s",
          role: ROLE,
          workspaceBinding: { workspaceId: WS_A },
          relay: relay as never,
        });
        const options = () =>
          dispatchActionForWorkspace.mock.calls.map(
            (call) =>
              (call as unknown[])[5] as
                { callerOrigin?: string; relay?: { readOnly?: boolean } } | undefined
          );
        return { sessionDeps, options };
      };
      const caller = {
        linkSessionId: "local",
        senderId: "local",
        helpSessionId: "help-1",
        shellName: "Mac",
      };

      const globalLocal = bound({ ...caller, local: true, global: true });
      await globalLocal.sessionDeps.dispatchAction(REACH, {}, false, undefined, "call-1");
      await globalLocal.sessionDeps.dispatchAction("terminal.list", {}, false, undefined, "call-2");
      const [plugin, read] = globalLocal.options();
      expect(plugin?.callerOrigin).toBe("global-assistant");
      expect(plugin?.relay?.readOnly).toBe(false);
      expect(read?.callerOrigin).toBe("global-assistant");
      expect(read?.relay?.readOnly).toBe(true);

      for (const relay of [
        { ...caller, global: true },
        { ...caller, local: true },
      ]) {
        const other = bound(relay);
        await other.sessionDeps.dispatchAction(REACH, {}, false, undefined, "call-3");
        expect(other.options()[0]).not.toHaveProperty("callerOrigin");
      }
    } finally {
      uninstall();
    }
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
        role: ROLE,
        relay: { ...relay, global: true },
      });
      expect(sessionDeps.relay?.global).toBe(true);
      const target = {
        projectId: "p",
        terminalId: "t",
        generation: 1,
        inputOwner: "principal-a",
        authorize: () => {},
      };

      const refused = { code: "WORKER_NOT_FOUND" };
      const steerOf = (tag: string) => ({
        prompt: vi.fn(async () => `${tag}:prompt`),
        keys: vi.fn(async () => `${tag}:keys`),
        interrupt: vi.fn(async () => `${tag}:interrupt`),
        reveal: vi.fn(async () => `${tag}:reveal`),
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
      const show = vi.fn(async () => "shown");
      const steer = sessionDeps.globalSteer!;
      const callAll = () =>
        Promise.all([
          steer.prompt(target, prompt),
          steer.keys(target, keys),
          steer.interrupt(target),
          steer.reveal(target, show),
        ]);

      // Unbound, every call is refused, never run some other way.
      await expect(steer.prompt(target, prompt)).rejects.toMatchObject(refused);
      await expect(steer.keys(target, keys)).rejects.toMatchObject(refused);
      await expect(steer.interrupt(target)).rejects.toMatchObject(refused);
      await expect(steer.reveal(target, show)).rejects.toMatchObject(refused);
      expect(show).not.toHaveBeenCalled();

      const first = steerOf("a");
      bind(first);
      await expect(callAll()).resolves.toEqual(["a:prompt", "a:keys", "a:interrupt", "a:reveal"]);
      expect(first.prompt).toHaveBeenCalledWith(target, prompt);
      expect(first.keys).toHaveBeenCalledWith(target, keys);
      expect(first.interrupt).toHaveBeenCalledWith(target);
      expect(first.reveal).toHaveBeenCalledWith(target, show);

      // Replaced, then gone: each call reads the binding as it finds it.
      bind(steerOf("b"));
      await expect(callAll()).resolves.toEqual(["b:prompt", "b:keys", "b:interrupt", "b:reveal"]);
      bind(undefined);
      await expect(steer.keys(target, keys)).rejects.toMatchObject(refused);
    }
  );

  // #16750: the close's read follows the binding, and no binding is no agent to close.
  it("reads a close target through the steer bound at each call", async () => {
    const { state, host } = mutableHost();
    const sessionDeps = createSessionServerDeps(fakeSource(), host, {
      sessionId: "s",
      role: ROLE,
      relay: { ...RELAY, global: true },
    });
    const steer = sessionDeps.globalSteer!;

    await expect(steer.closeTarget("p", "t")).resolves.toBeNull();

    const found = { generation: 1, closeClass: "handback" as const };
    const closeTarget = vi.fn(async () => found);
    state.binding = {
      control: {} as AssistantControlBinding["control"],
      sessionProject: () => null,
      steer: { closeTarget } as never,
    };
    await expect(steer.closeTarget("p", "t")).resolves.toBe(found);
    expect(closeTarget).toHaveBeenCalledWith("p", "t");
  });

  // #16750: the close's question goes to the Shell inside the call's own wait.
  it("asks the Shell about a global close inside its call's deadline, and not after it", async () => {
    const requestApproval = vi.fn(async () => ({ decision: "approved" as const, deadline: 1 }));
    let deadline: number | undefined = 100_000;
    const sessionDeps = createSessionServerDeps(fakeSource(), mutableHost().host, {
      sessionId: "s",
      role: ROLE,
      relay: {
        ...RELAY,
        global: true,
        requestApproval,
        callDeadline: () => deadline,
      },
    });
    const ask = {
      actionId: "terminal.close",
      args: { terminalId: "t" },
      subject: "Fix it",
      lines: ["Panel: Fix it (t)"],
      closeClass: "handback" as const,
    };

    await sessionDeps.relay!.askClose!("call-1", ask);
    expect(requestApproval).toHaveBeenCalledWith({
      ...ask,
      callId: "call-1",
      holdUntil: 100_000 - MCP_REMOTE_CONFIRM_MARGIN_MS,
    });

    // The call has already been answered: nobody is asked about it.
    deadline = undefined;
    await expect(sessionDeps.relay!.askClose!("call-1", ask)).resolves.toEqual({
      decision: "timeout",
    });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("gives a project assistant's relay session no way to ask about a close", () => {
    const sessionDeps = createSessionServerDeps(fakeSource(), mutableHost().host, {
      sessionId: "s",
      role: ROLE,
      relay: { ...RELAY, requestApproval: vi.fn() },
    });
    expect(sessionDeps.relay?.askClose).toBeUndefined();
  });

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
      role: ROLE,
      ...capture,
    });
    expect(sessionDeps.globalSteer).toBeUndefined();
    expect(sessionDeps.relay?.global).toBeUndefined();
  });

  // #16620: any assistant reaching another through `host.call` reads and withdraws what it holds.
  it.each([
    ["a project assistant's relay session", { relay: RELAY }, true],
    [
      "this machine's project assistant reaching another project",
      { relay: { ...RELAY, local: true as const } },
      true,
    ],
    ["the global Assistant's relay session", { relay: { ...RELAY, global: true as const } }, true],
    ["a direct session", {}, false],
    // #18172: an agent pane holds sends for its own workers under its bearer.
    ["an agent pane's own session", { role: "agent-pane" as const }, true],
  ])("hands %s the held-send reads as it should", (_label, capture, expected) => {
    const workerSteerQueue = { status: vi.fn(), cancel: vi.fn() };
    const deps = fakeSource();
    (deps as { workerSteerQueue?: unknown }).workerSteerQueue = workerSteerQueue;
    const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
      sessionId: "s",
      role: ROLE,
      ...capture,
    });
    expect(sessionDeps.workerSteerQueue).toBe(expected ? workerSteerQueue : undefined);
  });

  it("names the external client the host reports at dispatch time, not at build", async () => {
    const deps = fakeSource();
    const { state, host } = mutableHost();

    const sessionDeps = createSessionServerDeps(deps, host, { sessionId: "x", role: ROLE });
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

  // #17036: main's own actions.list walk asks a local view for one large page,
  // and only on the routes that reach one.
  describe("main's own actions.list walk", () => {
    const WALK = { actionsListWalk: true } as const;

    it("rides an unpinned dispatch beside its authorization", async () => {
      const deps = fakeSource();
      const { state, host } = mutableHost();
      const sessionDeps = createSessionServerDeps(deps, host, { sessionId: "x", role: ROLE });
      state.bearer = { token4LastChars: "wxyz", userAgent: "client/1.0" };

      await sessionDeps.dispatchAction(
        "actions.list",
        { limit: 100 },
        true,
        "skip-preference",
        undefined,
        WALK
      );
      await sessionDeps.dispatchAction("actions.list", { limit: 100 }, false);

      expect(deps.dispatchAction).toHaveBeenNthCalledWith(
        1,
        "actions.list",
        { limit: 100 },
        true,
        state.bearer,
        "external",
        "skip-preference",
        WALK
      );
      expect(deps.dispatchAction).toHaveBeenNthCalledWith(
        2,
        "actions.list",
        { limit: 100 },
        false,
        state.bearer,
        "external"
      );
    });

    it("rides a pinned dispatch's options", async () => {
      const deps = fakeSource();
      const dispatchActionForWebContents = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      (deps as { dispatchActionForWebContents?: unknown }).dispatchActionForWebContents =
        dispatchActionForWebContents;
      deps.sessionStore.sessionOriginMap.set("s", "help");
      deps.sessionStore.sessionWebContentsMap.set("s", 7);
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
      });

      await sessionDeps.dispatchAction("actions.list", {}, false, undefined, undefined, WALK);

      expect((dispatchActionForWebContents.mock.calls[0] as unknown[])[6]).toEqual(WALK);
    });

    it("carries the dialog's hand-over offer to this machine's own help session's view only (#16752)", async () => {
      const offer = { label: "Delete a worktree it created", detail: "Only a clean one" };
      const dispatchActionForWebContents = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      const deps = fakeSource();
      (deps as { dispatchActionForWebContents?: unknown }).dispatchActionForWebContents =
        dispatchActionForWebContents;
      deps.sessionStore.sessionOriginMap.set("s", "help");
      deps.sessionStore.sessionWebContentsMap.set("s", 7);
      deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
      const help = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
      });

      await help.dispatchAction("worktree.delete", {}, false, undefined, undefined, {
        delegationOffer: offer,
      });

      expect((dispatchActionForWebContents.mock.calls[0] as unknown[])[6]).toMatchObject({
        delegationOffer: offer,
      });

      // A pinned session that isn't one of this machine's help sessions never carries it.
      deps.sessionStore.sessionOriginMap.set("p", "external");
      deps.sessionStore.sessionWebContentsMap.set("p", 8);
      const other = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "p",
        role: ROLE,
      });
      await other.dispatchAction("worktree.delete", {}, false, undefined, undefined, {
        delegationOffer: offer,
      });

      const sent = (dispatchActionForWebContents.mock.calls[1] as unknown[])[6] as
        Record<string, unknown> | undefined;
      expect(sent?.delegationOffer).toBeUndefined();
    });

    it("rides a workspace-bound dispatch's options without dropping a pane's own", async () => {
      const deps = fakeSource();
      const dispatchActionForWorkspace = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      (deps as { dispatchActionForWorkspace?: unknown }).dispatchActionForWorkspace =
        dispatchActionForWorkspace;
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
        workspaceBinding: { workspaceId: WS_A },
        paneBinding: {
          workspaceId: WS_A,
          launchWebContentsId: 7,
          actionContext: { focusedTerminalId: "term-focused" },
        },
      });

      await sessionDeps.dispatchAction("actions.list", {}, false, undefined, undefined, WALK);
      await sessionDeps.dispatchAction("actions.list", {}, false);

      const [walked, plain] = dispatchActionForWorkspace.mock.calls.map(
        (call) => (call as unknown[])[5] as Record<string, unknown>
      );
      expect(walked).toEqual({ ...plain, actionsListWalk: true });
      expect(plain).not.toHaveProperty("actionsListWalk");
      expect(plain).toHaveProperty("preferredWebContentsId", 7);
    });
  });

  it("keeps the pin and help-session id it captured after teardown clears the store", async () => {
    const deps = fakeSource();
    deps.sessionStore.sessionOriginMap.set("s", "help");
    deps.sessionStore.sessionWebContentsMap.set("s", 7);
    deps.sessionStore.sessionHelpIdMap.set("s", "help-1");

    const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
      sessionId: "s",
      role: ROLE,
    });

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

  // #14992: a dialog names the pane that asked only if every route its
  // questions take carries the bearer's own terminal.
  describe("the requester a confirmation names", () => {
    function paneSession(ownPane: { key: string; terminalId: string; relay?: unknown } | null) {
      const deps = fakeSource();
      const dispatchActionForWorkspace = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      (deps as { dispatchActionForWorkspace?: unknown }).dispatchActionForWorkspace =
        dispatchActionForWorkspace;
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
        workspaceBinding: { workspaceId: WS_A },
        paneBinding: {
          workspaceId: WS_A,
          launchWebContentsId: 7,
          // The pane that had focus at launch, which is not the one asking.
          actionContext: { focusedTerminalId: "term-focused" },
        },
        ownPane: ownPane as never,
      });
      return { sessionDeps, dispatchActionForWorkspace };
    }

    it("is the pane's own terminal on its dispatches and its above-tier questions", async () => {
      const { sessionDeps, dispatchActionForWorkspace } = paneSession({
        key: "pane:p",
        terminalId: "term-own",
      });

      await sessionDeps.dispatchAction("terminal.close", { terminalId: "x" }, false);
      await sessionDeps.requestApproval?.("terminal.close", { terminalId: "x" });

      const requesters = dispatchActionForWorkspace.mock.calls.map(
        (call) => (call as unknown[])[5] as { requester?: unknown; approvalOnly?: boolean }
      );
      expect(requesters).toHaveLength(2);
      for (const options of requesters) {
        expect(options.requester).toEqual({ kind: "pane", terminalId: "term-own" });
      }
      expect(requesters[1]?.approvalOnly).toBe(true);
    });

    it.each([
      ["a pane whose terminal didn't resolve", null],
      [
        "a relayed pane, which lives on another machine",
        {
          key: "relay:p",
          terminalId: "relay:p",
          relay: { projectId: WS_A, helpSessionId: "h", deliver: () => {} },
        },
      ],
    ])("is absent for %s", async (_label, ownPane) => {
      const { sessionDeps, dispatchActionForWorkspace } = paneSession(ownPane);

      await sessionDeps.dispatchAction("terminal.close", {}, false);

      const options = (dispatchActionForWorkspace.mock.calls[0] as unknown[])[5] as {
        requester?: unknown;
        offerSessionApproval?: boolean;
      };
      expect(options.offerSessionApproval).toBe(true);
      expect(options.requester).toBeUndefined();
    });

    it("is the help session on the assistant's pinned dispatches and close questions", async () => {
      const deps = fakeSource();
      const dispatchActionForWebContents = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      (deps as { dispatchActionForWebContents?: unknown }).dispatchActionForWebContents =
        dispatchActionForWebContents;
      deps.sessionStore.sessionOriginMap.set("s", "help");
      deps.sessionStore.sessionWebContentsMap.set("s", 7);
      deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
      });

      await sessionDeps.dispatchAction("worktree.delete", {}, false);
      await sessionDeps.dispatchAction("worktree.delete", {}, true, "skip-preference");
      await sessionDeps.requestCloseApproval?.("terminal.close", {});

      const approvals = dispatchActionForWebContents.mock.calls.map(
        (call) => (call as unknown[])[6] as Record<string, unknown>
      );
      const requester = { kind: "assistant", helpSessionId: "help-1" };
      expect(approvals[0]).toEqual({ requester });
      expect(approvals[1]).toEqual({ authorization: "skip-preference", requester });
      expect(approvals[2]).toEqual({
        approvalOnly: true,
        approvalReason: "protected-close",
        requester,
      });
    });

    it.each([
      ["a help session with no help id", "help" as const, null, {}],
      ["a pinned session that isn't the assistant's", "external" as const, "help-1", {}],
      [
        "a relayed call, whose tab is on another machine",
        "help" as const,
        "help-1",
        { relay: RELAY },
      ],
    ])("is absent on the pinned route for %s", async (_label, origin, helpId, capture) => {
      const deps = fakeSource();
      const dispatchActionForWebContents = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      (deps as { dispatchActionForWebContents?: unknown }).dispatchActionForWebContents =
        dispatchActionForWebContents;
      deps.sessionStore.sessionOriginMap.set("s", origin);
      deps.sessionStore.sessionWebContentsMap.set("s", 7);
      if (helpId !== null) deps.sessionStore.sessionHelpIdMap.set("s", helpId);
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
        ...capture,
      });

      await sessionDeps.requestCloseApproval?.("terminal.close", {});

      const approval = (dispatchActionForWebContents.mock.calls[0] as unknown[])[6] as Record<
        string,
        unknown
      >;
      expect(approval).toEqual({ approvalOnly: true, approvalReason: "protected-close" });
    });

    it.each([
      ["another machine's", RELAY],
      ["this machine's, reaching another project", { ...RELAY, local: true as const }],
    ])("is absent for a relay session carrying %s assistant", async (_label, relay) => {
      // As `openRelaySession` builds one: a workspace route, no pane, no pane bearer.
      const deps = fakeSource();
      const dispatchActionForWorkspace = vi.fn(async () => ({
        result: { ok: true, result: null },
      }));
      (deps as { dispatchActionForWorkspace?: unknown }).dispatchActionForWorkspace =
        dispatchActionForWorkspace;
      deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
      const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
        sessionId: "s",
        role: ROLE,
        workspaceBinding: { workspaceId: WS_A },
        ownPane: null,
        relay,
      });

      await sessionDeps.dispatchAction("terminal.close", {}, false);

      const options = (dispatchActionForWorkspace.mock.calls[0] as unknown[])[5] as Record<
        string,
        unknown
      >;
      expect(options).toHaveProperty("relay");
      expect(options).not.toHaveProperty("requester");
    });
  });
});

describe("a close question with no window to ask in (#18176)", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  /** A help session with no pin, held by `viewlessProjectId` as the handshake leaves it when given one. */
  function unpinnedSession(
    viewlessProjectId: string | null,
    role: "project-assistant" | "global-assistant" = "project-assistant"
  ) {
    const deps = fakeSource();
    const dispatchActionForWebContents = vi.fn(async () => ({
      result: { ok: true, result: null },
    }));
    (deps as { dispatchActionForWebContents?: unknown }).dispatchActionForWebContents =
      dispatchActionForWebContents;
    deps.sessionStore.sessionOriginMap.set("s", "help");
    deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
    if (viewlessProjectId !== null) {
      deps.sessionStore.sessionViewlessHelpMap.set("s", viewlessProjectId);
    }
    const sessionDeps = createSessionServerDeps(deps, mutableHost().host, {
      sessionId: "s",
      role,
    });
    const refusal = () =>
      sessionDeps.requestCloseApproval!("terminal.close", { terminalIds: ["t"] }).then(
        () => null,
        (err: Error) => err.message
      );
    return { deps, refusal, dispatchActionForWebContents };
  }

  it("tells a project assistant with no view how a window takes it over, in the mode it asks in", async () => {
    const { refusal, dispatchActionForWebContents } = unpinnedSession(WS_A);

    const routingOff = await refusal();
    expect(routingOff).toMatch(/^This assistant isn't attached to a window of this project/);
    expect(routingOff).toMatch(/Opening the project in one window here takes it over/);
    expect(routingOff).toMatch(/opening this assistant in the project's Assistant panel/);

    // Read when it asks, not when the session was built.
    restore = setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    const routingOn = await refusal();
    expect(routingOn).toMatch(/The window that has control of this project takes it over/);
    expect(routingOn).toMatch(
      /while no window has control, opening this assistant in the project's Assistant panel/
    );
    expect(routingOn).not.toMatch(/one window here/);

    expect(dispatchActionForWebContents).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the global assistant, which no project window takes over",
      GLOBAL_ASSISTANT_ID,
      "global-assistant" as const,
      false,
    ],
    ["a session whose viewless binding is gone", WS_A, "project-assistant" as const, true],
  ])("refuses %s as any session without a window", async (_label, projectId, role, unbind) => {
    const ordinary = await unpinnedSession(null).refusal();
    const { deps, refusal } = unpinnedSession(projectId, role);
    if (unbind) deps.sessionStore.sessionViewlessHelpMap.delete("s");

    const message = await refusal();
    expect(message).not.toBeNull();
    expect(message).toBe(ordinary);
    expect(message).not.toMatch(/takes it over/);
  });
});
