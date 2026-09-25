import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type InvokeListener = (event: unknown, ...args: unknown[]) => unknown;
type OnListener = (event: unknown, ...args: unknown[]) => unknown;

const { appMock, handlers, onListeners, ipcMainMock, getWindowMock, getProjectMock } = vi.hoisted(
  () => {
    const handlers = new Map<string, InvokeListener>();
    const onListeners = new Map<string, OnListener[]>();
    return {
      appMock: { isPackaged: false, on: () => undefined },
      handlers,
      onListeners,
      ipcMainMock: {
        handle: (channel: string, listener: InvokeListener) => {
          handlers.set(channel, listener);
        },
        handleOnce: (channel: string, listener: InvokeListener) => {
          handlers.set(channel, listener);
        },
        removeHandler: (channel: string) => {
          handlers.delete(channel);
        },
        on: (channel: string, listener: OnListener) => {
          onListeners.set(channel, [...(onListeners.get(channel) ?? []), listener]);
        },
        removeListener: () => undefined,
        removeAllListeners: () => undefined,
        off: () => undefined,
      },
      getWindowMock: vi.fn<(wc: unknown) => unknown>(() => null),
      getProjectMock: vi.fn<(id: number) => string | null>(() => null),
    };
  }
);

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
  session: { defaultSession: {}, fromPartition: () => ({}) },
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn(() => true),
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: vi.fn(() => "corr-1"),
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowMock,
  getProjectForWebContents: getProjectMock,
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => false),
  isCachedViewWebContents: vi.fn(() => false),
}));

import { enforceIpcSenderValidation } from "../../setup/security.js";
import { _resetIpcGuardForTesting } from "../ipcGuard.js";
import { typedHandle, typedHandleWithContext } from "../utils.js";
import { getIpcDispatcher } from "../dispatcher.js";
import { getEndpointRegistry, _resetEndpointRegistryForTesting } from "../endpointRegistry.js";
import { _resetLocalEndpointsForTesting } from "../localEndpoint.js";
import { AppError } from "../../utils/errorTypes.js";
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";
import type { ClientEndpoint, ClientRef, RemoteRouter } from "../endpoint.js";
import type { IpcContext } from "../types.js";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";

const HOST_CHANNEL = "git:get-file-diff";
const SHELL_CHANNEL = "window:new";
const HYBRID_CHANNEL = "app:get-state";
const UNCLASSIFIED_CHANNEL = "not-a:channel";

function makeSender(id: number) {
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
  };
}

function makeEvent(sender = makeSender(5)) {
  return { sender, senderFrame: { url: "app://daintree/index.html" } };
}

function invokeLocal(channel: string, event: unknown, ...args: unknown[]): Promise<IpcEnvelope> {
  const listener = handlers.get(channel);
  if (!listener) throw new Error(`no handler for ${channel}`);
  return listener(event, ...args) as Promise<IpcEnvelope>;
}

function makeRemoteEndpoint(handle = -3, projectId: string | null = "proj-1") {
  const send = vi.fn();
  const endpoint: ClientEndpoint = {
    endpointId: `remote:${handle}`,
    clientId: "client-b",
    projectId,
    kind: "remote-view",
    handle,
    send,
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
  return { endpoint, send };
}

const REMOTE_CLIENT: ClientRef = {
  clientId: "client-b",
  clientName: "greg-mbp",
  platform: "darwin",
  kind: "remote",
};

// Every registration below is torn down so the handler maps stay per-test.
const cleanups: Array<() => void> = [];
// enforceIpcSenderValidation monkeypatches ipcMain; restore the bare mock
// before each install so wrappers never stack.
const bareIpcMain = { ...ipcMainMock };

beforeEach(() => {
  Object.assign(ipcMainMock, bareIpcMain);
  handlers.clear();
  onListeners.clear();
  appMock.isPackaged = false;
  getWindowMock.mockReset().mockReturnValue(null);
  getProjectMock.mockReset().mockReturnValue(null);
  _resetIpcGuardForTesting();
  _resetEndpointRegistryForTesting();
  _resetLocalEndpointsForTesting();
  enforceIpcSenderValidation();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  getIpcDispatcher().setRemoteRouter(null);
});

describe("local ipcMain invocations", () => {
  it("builds the same context as before plus a local endpoint and client", async () => {
    const window = { id: 1 };
    getWindowMock.mockReturnValue(window);
    getProjectMock.mockReturnValue("proj-a");
    let seen: IpcContext | null = null;
    cleanups.push(
      typedHandleWithContext(
        HOST_CHANNEL as never,
        ((ctx: IpcContext) => {
          seen = ctx;
          return { diff: "x" };
        }) as never
      )
    );

    const event = makeEvent();
    const envelope = await invokeLocal(HOST_CHANNEL, event, { path: "a" });

    expect(envelope).toEqual(wrapSuccess({ diff: "x" }));
    const ctx = seen as unknown as IpcContext;
    expect(ctx.event).toBe(event);
    expect(ctx.senderWindow).toBe(window);
    expect(ctx.webContentsId).toBe(5);
    expect(ctx.projectId).toBe("proj-a");
    expect(ctx.client).toMatchObject({ clientId: "local", kind: "local" });
    expect(ctx.endpoint).toMatchObject({
      endpointId: "local:5",
      kind: "local-view",
      handle: 5,
      projectId: "proj-a",
    });
    expect(getEndpointRegistry().getByHandle(5)).toBe(ctx.endpoint);
  });

  it("does not create an endpoint for handlers that never read it", async () => {
    cleanups.push(typedHandleWithContext(HOST_CHANNEL as never, (() => 1) as never));
    const sender = makeSender(8);
    await invokeLocal(HOST_CHANNEL, makeEvent(sender));
    expect(sender.once).not.toHaveBeenCalled();
    expect(getEndpointRegistry().getByHandle(8)).toBeUndefined();
  });

  it("keeps the packaged sanitiser: context stripped, details kept", async () => {
    appMock.isPackaged = true;
    const details = { code: "PLUGIN_NOT_ON_HOST" as const, pluginId: "p", hostId: "box" };
    cleanups.push(
      typedHandle(
        HOST_CHANNEL as never,
        (() => {
          throw new AppError({
            code: "PLUGIN_NOT_ON_HOST",
            message: "missing at /Users/greg/secret",
            context: { path: "/Users/greg/x" },
            details,
          });
        }) as never
      )
    );

    const envelope = await invokeLocal(HOST_CHANNEL, makeEvent());

    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(envelope.error.code).toBe("PLUGIN_NOT_ON_HOST");
    expect(envelope.error.message).toBe("missing at <path>");
    expect(envelope.error.context).toBeUndefined();
    expect(envelope.error.stack).toBeUndefined();
    expect(envelope.error.correlationId).toBe("corr-1");
    expect((envelope.error as { details?: unknown }).details).toEqual(details);
  });
});

describe("invokeForEndpoint", () => {
  it("runs a context handler for a remote endpoint with no event or window", async () => {
    let seen: IpcContext | null = null;
    cleanups.push(
      typedHandleWithContext(
        HOST_CHANNEL as never,
        ((ctx: IpcContext, payload: unknown) => {
          seen = ctx;
          return { echoed: payload };
        }) as never
      )
    );
    const { endpoint } = makeRemoteEndpoint(-3, "proj-1");

    const envelope = await getIpcDispatcher().invokeForEndpoint(
      { endpoint, client: REMOTE_CLIENT },
      HOST_CHANNEL,
      [{ path: "a" }]
    );

    expect(envelope).toEqual({
      __daintreeIpcEnvelope: true,
      ok: true,
      data: { echoed: { path: "a" } },
    });
    const ctx = seen as unknown as IpcContext;
    expect(ctx.event).toBeNull();
    expect(ctx.senderWindow).toBeNull();
    expect(ctx.webContentsId).toBe(-3);
    expect(ctx.projectId).toBe("proj-1");
    expect(ctx.endpoint).toBe(endpoint);
    expect(ctx.client).toBe(REMOTE_CLIENT);
  });

  it("produces the same error envelope as a local call, sanitiser included", async () => {
    appMock.isPackaged = true;
    cleanups.push(
      typedHandleWithContext(
        HOST_CHANNEL as never,
        (() => {
          throw new AppError({
            code: "NOT_FOUND",
            message: "gone /Users/greg/a",
            context: { a: 1 },
          });
        }) as never
      )
    );
    const { endpoint } = makeRemoteEndpoint();

    const local = await invokeLocal(HOST_CHANNEL, makeEvent());
    const remote = await getIpcDispatcher().invokeForEndpoint(
      { endpoint, client: REMOTE_CLIENT },
      HOST_CHANNEL,
      []
    );

    expect(remote).toEqual(local);
  });

  it("refuses a raw ipcMain.handle channel with CHANNEL_NOT_REMOTABLE", async () => {
    const raw = vi.fn(() => "raw");
    ipcMainMock.handle("git:list-commits", raw);
    const { endpoint } = makeRemoteEndpoint();

    const envelope = await getIpcDispatcher().invokeForEndpoint(
      { endpoint, client: REMOTE_CLIENT },
      "git:list-commits",
      []
    );

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("CHANNEL_NOT_REMOTABLE");
    expect(raw).not.toHaveBeenCalled();
  });

  it.each([SHELL_CHANNEL, UNCLASSIFIED_CHANNEL])(
    "refuses %s over a link even with a context handler",
    async (channel) => {
      const handler = vi.fn(() => "ran");
      getIpcDispatcher().registerInvoke(channel, handler);
      const { endpoint } = makeRemoteEndpoint();

      const envelope = await getIpcDispatcher().invokeForEndpoint(
        { endpoint, client: REMOTE_CLIENT },
        channel,
        []
      );

      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe("CHANNEL_NOT_REMOTABLE");
      expect(handler).not.toHaveBeenCalled();
    }
  );

  it("applies the arg-count cap and payload budget like an ipcMain call", async () => {
    const handler = vi.fn(() => "ran");
    cleanups.push(typedHandleWithContext(HOST_CHANNEL as never, handler as never));
    const { endpoint } = makeRemoteEndpoint();
    const invocation = { endpoint, client: REMOTE_CLIENT };

    const tooMany = await getIpcDispatcher().invokeForEndpoint(
      invocation,
      HOST_CHANNEL,
      Array.from({ length: 9 }, () => 1)
    );
    const tooBig = await getIpcDispatcher().invokeForEndpoint(invocation, HOST_CHANNEL, [
      "x".repeat(600 * 1024),
    ]);

    expect(tooMany.ok || tooMany.error.code).toBe("ARG_COUNT_EXCEEDED");
    expect(tooBig.ok || tooBig.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers link sends to context send listeners and drops raw-only channels", () => {
    const listener = vi.fn();
    cleanups.push(getIpcDispatcher().registerSend("terminal:input", listener));
    const { endpoint } = makeRemoteEndpoint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    getIpcDispatcher().sendForEndpoint({ endpoint, client: REMOTE_CLIENT }, "terminal:input", [
      "id",
      "ls",
    ]);
    getIpcDispatcher().sendForEndpoint({ endpoint, client: REMOTE_CLIENT }, "terminal:resize", []);

    return vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ event: null, webContentsId: -3 }),
        "id",
        "ls"
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("terminal:resize"));
      warn.mockRestore();
    });
  });
});

describe("remote router", () => {
  function installRouter(overrides: Partial<RemoteRouter> = {}) {
    const router: RemoteRouter = {
      hostForSender: vi.fn((id: number) => (id === 5 ? "box" : null)),
      forwardInvoke: vi.fn(async () => wrapSuccess("from-host")),
      forwardSend: vi.fn(),
      ...overrides,
    };
    getIpcDispatcher().setRemoteRouter(router);
    return router;
  }

  it("forwards host channels and returns the host envelope verbatim", async () => {
    const hostEnvelope = {
      __daintreeIpcEnvelope: true as const,
      ok: false as const,
      error: { name: "AppError", message: "host said no", code: "DRIVEN_ELSEWHERE" },
    };
    const router = installRouter({ forwardInvoke: vi.fn(async () => hostEnvelope) });
    const handler = vi.fn(() => "local");
    cleanups.push(typedHandle(HOST_CHANNEL as never, handler as never));

    const envelope = await invokeLocal(HOST_CHANNEL, makeEvent(), { path: "a" });

    expect(envelope).toBe(hostEnvelope);
    expect(router.forwardInvoke).toHaveBeenCalledWith("box", 5, HOST_CHANNEL, [{ path: "a" }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("turns a malformed host error envelope into a local error envelope", async () => {
    installRouter({
      forwardInvoke: vi.fn(
        async () => ({ __daintreeIpcEnvelope: true, ok: false, error: null }) as never
      ),
    });
    cleanups.push(typedHandle(HOST_CHANNEL as never, (() => "local") as never));
    const envelope = await invokeLocal(HOST_CHANNEL, makeEvent());
    expect(envelope.ok || envelope.error.code).toBe("INTERNAL");
  });

  it("forwards raw ipcMain.handle host channels too", async () => {
    installRouter();
    const raw = vi.fn(() => "raw");
    ipcMainMock.handle("git:list-commits", raw);
    const envelope = await invokeLocal("git:list-commits", makeEvent());
    expect(envelope).toEqual(wrapSuccess("from-host"));
    expect(raw).not.toHaveBeenCalled();
  });

  it("runs shell channels locally", async () => {
    const router = installRouter();
    cleanups.push(typedHandle(SHELL_CHANNEL as never, (() => "local") as never));
    await expect(invokeLocal(SHELL_CHANNEL, makeEvent())).resolves.toEqual(wrapSuccess("local"));
    expect(router.forwardInvoke).not.toHaveBeenCalled();
  });

  it("leaves senders that are not remote-bound untouched", async () => {
    const router = installRouter();
    cleanups.push(typedHandle(HOST_CHANNEL as never, (() => "local") as never));
    await expect(invokeLocal(HOST_CHANNEL, makeEvent(makeSender(6)))).resolves.toEqual(
      wrapSuccess("local")
    );
    expect(router.forwardInvoke).not.toHaveBeenCalled();
  });

  it("hands hybrid channels to their split and wraps the merged value once", async () => {
    const router = installRouter({
      forwardInvoke: vi.fn(async (_h, _w, channel, args) => wrapSuccess({ channel, args })),
    });
    const handler = vi.fn((...args: unknown[]) => ({ local: args }));
    cleanups.push(typedHandle(HYBRID_CHANNEL as never, handler as never));
    cleanups.push(
      getIpcDispatcher().registerHybridSplit(HYBRID_CHANNEL, async ({ local, remote }) => ({
        device: await local(["device-only"]),
        host: await remote("app:get-state-host", ["host-only"]),
      }))
    );

    const envelope = await invokeLocal(HYBRID_CHANNEL, makeEvent(), "orig");

    expect(envelope).toEqual(
      wrapSuccess({
        device: { local: ["device-only"] },
        host: { channel: "app:get-state-host", args: ["host-only"] },
      })
    );
    expect(router.forwardInvoke).toHaveBeenCalledWith("box", 5, "app:get-state-host", [
      "host-only",
    ]);
  });

  it("surfaces a host error from a split's remote leg with its code", async () => {
    installRouter({
      forwardInvoke: vi.fn(async () => ({
        __daintreeIpcEnvelope: true as const,
        ok: false as const,
        error: { name: "AppError", message: "down", code: "HOST_DISCONNECTED" },
      })),
    });
    cleanups.push(typedHandle(HYBRID_CHANNEL as never, (() => "local") as never));
    cleanups.push(getIpcDispatcher().registerHybridSplit(HYBRID_CHANNEL, ({ remote }) => remote()));

    const envelope = await invokeLocal(HYBRID_CHANNEL, makeEvent());
    expect(envelope.ok || envelope.error.code).toBe("HOST_DISCONNECTED");
  });

  it("refuses a hybrid channel with no split and an unclassified channel", async () => {
    installRouter();
    const handler = vi.fn(() => "local");
    cleanups.push(typedHandle(HYBRID_CHANNEL as never, handler as never));
    ipcMainMock.handle(UNCLASSIFIED_CHANNEL, handler);

    const hybrid = await invokeLocal(HYBRID_CHANNEL, makeEvent());
    const unknown = await invokeLocal(UNCLASSIFIED_CHANNEL, makeEvent());

    expect(hybrid.ok || hybrid.error.code).toBe("CHANNEL_NOT_REMOTABLE");
    expect(unknown.ok || unknown.error.code).toBe("CHANNEL_NOT_REMOTABLE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes sends: host forwarded once per message, shell local, unknown dropped", () => {
    const router = installRouter();
    const hostA = vi.fn();
    const hostB = vi.fn();
    const shell = vi.fn();
    const unknown = vi.fn();
    ipcMainMock.on("terminal:input", hostA);
    ipcMainMock.on("terminal:input", hostB);
    ipcMainMock.on(SHELL_CHANNEL, shell);
    ipcMainMock.on(UNCLASSIFIED_CHANNEL, unknown);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const event = makeEvent();
    for (const listener of onListeners.get("terminal:input")!) listener(event, "id", "ls");
    onListeners.get(SHELL_CHANNEL)![0]!(makeEvent());
    onListeners.get(UNCLASSIFIED_CHANNEL)![0]!(makeEvent());

    expect(router.forwardSend).toHaveBeenCalledTimes(1);
    expect(router.forwardSend).toHaveBeenCalledWith("box", 5, "terminal:input", ["id", "ls"]);
    expect(hostA).not.toHaveBeenCalled();
    expect(hostB).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledTimes(1);
    expect(unknown).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("changes nothing once the router is removed", async () => {
    installRouter();
    getIpcDispatcher().setRemoteRouter(null);
    const handler = vi.fn(() => "local");
    cleanups.push(typedHandle(HOST_CHANNEL as never, handler as never));
    await expect(invokeLocal(HOST_CHANNEL, makeEvent())).resolves.toEqual(wrapSuccess("local"));
  });
});
