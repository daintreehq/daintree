import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn() }));
const registryMock = vi.hoisted(() => ({
  getWebContentsForProject: vi.fn((_projectId: string): unknown[] => []),
  isCachedViewWebContents: vi.fn((_id: number): boolean => false),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, webContents: { fromId: vi.fn() } }));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: () => null,
  getProjectViewManager: () => null,
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: registryMock.getWebContentsForProject,
  isCachedViewWebContents: registryMock.isCachedViewWebContents,
}));

import { PluginUIPromptDispatcher } from "../PluginUIPromptDispatcher.js";
import {
  _resetPluginFrontendRoutingForTesting,
  getPluginInvokeOrigin,
  runInPluginInvocation,
  setPluginFrontendRouter,
  type PluginFrontend,
} from "../pluginFrontendRouting.js";
import { PluginFrontendMethod } from "../pluginFrontendRequests.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { PluginUiPromptParams } from "../../../../shared/types/pluginUiPrompt.js";

const PROJECT = "a".repeat(64);
const CONFIRM: PluginUiPromptParams = { kind: "confirm", options: { title: "Deploy?" } };
const PICK: PluginUiPromptParams = {
  kind: "quickPick",
  items: [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ],
  options: {},
};

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function makeEndpoint(endpointId = "s1:ep", projectId: string = PROJECT) {
  const requests: Array<{ method: string; payload: unknown; deferred: Deferred }> = [];
  let closed = false;
  const endpoint: ClientEndpoint = {
    endpointId,
    clientId: "client-mbp",
    projectId,
    kind: "remote-view",
    handle: -3,
    send: vi.fn(),
    request: vi.fn((method: string, payload: unknown) => {
      return new Promise((resolve, reject) => {
        requests.push({ method, payload, deferred: { resolve, reject } });
      });
    }),
    onClose: () => ({ dispose: () => {} }),
    isClosed: () => closed,
  };
  return { endpoint, requests, close: () => (closed = true) };
}

let frontend: PluginFrontend = { kind: "local" };
let changeListener: (() => void) | null = null;

function installRouter() {
  setPluginFrontendRouter({
    resolve: () => frontend,
    onChange: (listener) => {
      changeListener = listener;
      return () => {
        changeListener = null;
      };
    },
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PluginUIPromptDispatcher with a remote driver", () => {
  let dispatcher: PluginUIPromptDispatcher;

  beforeEach(() => {
    _resetPluginFrontendRoutingForTesting();
    frontend = { kind: "local" };
    changeListener = null;
    dispatcher = new PluginUIPromptDispatcher({ isDisposed: () => false, now: () => 1_000 });
    installRouter();
  });

  afterEach(() => {
    dispatcher.dispose();
    _resetPluginFrontendRoutingForTesting();
  });

  it("asks the drive-lease holder's endpoint and returns its answer", async () => {
    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, undefined, {
      pluginDisplayName: "Deploy",
    });
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe(PluginFrontendMethod.PROMPT);
    expect(requests[0]!.payload).toMatchObject({
      pluginId: "acme.deploy",
      pluginDisplayName: "Deploy",
      params: CONFIRM,
    });
    expect(requests[0]!.payload).not.toHaveProperty("askedAt");
    expect(endpoint.request).toHaveBeenCalledWith(PluginFrontendMethod.PROMPT, expect.anything(), {
      timeoutMs: 0,
    });
    requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("maps a quick pick answer back onto the host's own items", async () => {
    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const answer = dispatcher.requestPrompt("acme.deploy", PICK, PROJECT);
    await flush();
    requests[0]!.deferred.resolve({ id: "b", label: "Injected label" });
    await expect(answer).resolves.toEqual({ id: "b", label: "Beta" });
  });

  it("fails with NO_FRONTEND_ATTACHED when nobody is attached — not the dismiss value", async () => {
    frontend = { kind: "none", reason: "vacant" };
    const error = await dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("NO_FRONTEND_ATTACHED");
    expect((error as AppError).message).toMatch(/^NO_FRONTEND_ATTACHED:/);
  });

  it("queues an opted-in prompt and shows it, marked as waited, when a frontend attaches", async () => {
    frontend = { kind: "none", reason: "vacant" };
    let now = 1_000;
    dispatcher = new PluginUIPromptDispatcher({ isDisposed: () => false, now: () => now });
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, undefined, {
      whenNoFrontend: "queue",
    });
    let settled = false;
    void answer.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);

    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    now = 61_000;
    changeListener?.();
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toMatchObject({ askedAt: 1_000 });
    requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("an aborted queued prompt settles with the dismiss value", async () => {
    frontend = { kind: "none", reason: "vacant" };
    const controller = new AbortController();
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, controller.signal, {
      whenNoFrontend: "queue",
    });
    controller.abort();
    await expect(answer).resolves.toBe(false);
  });

  it("counts a queued prompt against the one-prompt-per-plugin cap", async () => {
    frontend = { kind: "none", reason: "vacant" };
    void dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, undefined, {
      whenNoFrontend: "queue",
    });
    await expect(
      dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, undefined, {
        whenNoFrontend: "queue",
      })
    ).resolves.toBe(false);
  });

  it("aborting takes the prompt off the remote screen", async () => {
    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const controller = new AbortController();
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, controller.signal);
    await flush();
    const promptId = (requests[0]!.payload as { promptId: string }).promptId;
    controller.abort();
    await expect(answer).resolves.toBe(false);
    expect(requests[1]).toMatchObject({
      method: PluginFrontendMethod.PROMPT_CANCEL,
      payload: { pluginId: "acme.deploy", promptId },
    });
  });

  it("a driver that leaves before answering is NO_FRONTEND_ATTACHED", async () => {
    const { endpoint, requests, close } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    close();
    frontend = { kind: "none", reason: "reserved" };
    requests[0]!.deferred.reject(new AppError({ code: "HOST_DISCONNECTED", message: "gone" }));
    await expect(answer).rejects.toMatchObject({ code: "NO_FRONTEND_ATTACHED" });
  });

  it("cancelForPlugin dismisses the remote dialog and resolves the dismiss value", async () => {
    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    dispatcher.cancelForPlugin("acme.deploy");
    await expect(answer).resolves.toBe(false);
    expect(requests[1]).toMatchObject({
      method: PluginFrontendMethod.PROMPT_CANCEL,
      payload: { pluginId: "acme.deploy" },
    });
  });

  it("with no router the prompt path is the local one", async () => {
    _resetPluginFrontendRoutingForTesting();
    // No project view anywhere: the unchanged local path answers PROJECT_VIEW_UNAVAILABLE.
    await expect(dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT)).rejects.toMatchObject({
      code: "PROJECT_VIEW_UNAVAILABLE",
    });
    await expect(dispatcher.requestPrompt("acme.deploy", CONFIRM, null)).resolves.toBe(false);
  });

  it("moves an open prompt to whoever takes the project over", async () => {
    const a = makeEndpoint("a");
    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    expect(a.requests).toHaveLength(1);
    const promptId = (a.requests[0]!.payload as { promptId: string }).promptId;

    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    changeListener?.();
    await flush();
    expect(a.requests[1]).toMatchObject({
      method: PluginFrontendMethod.PROMPT_CANCEL,
      payload: { pluginId: "acme.deploy", promptId },
    });
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.method).toBe(PluginFrontendMethod.PROMPT);

    // The old driver's approval arrives late: it is nobody's answer now.
    a.requests[0]!.deferred.resolve(true);
    let settled = false;
    void answer.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    b.requests[0]!.deferred.resolve(false);
    await expect(answer).resolves.toBe(false);
  });

  it("never returns an approval from a driver whose lease has gone, even unannounced", async () => {
    const a = makeEndpoint("a");
    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    a.requests[0]!.deferred.resolve(true);
    await flush();
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("refuses the same driver's approval once it has lost and retaken the lease", async () => {
    const a = makeEndpoint("a");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 3 };
    a.requests[0]!.deferred.resolve(true);
    await flush();
    expect(a.requests.map((r) => r.method)).toEqual([
      PluginFrontendMethod.PROMPT,
      PluginFrontendMethod.PROMPT_CANCEL,
      PluginFrontendMethod.PROMPT,
    ]);
    a.requests[2]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("takes a stale driver's dismissal as it is", async () => {
    const a = makeEndpoint("a");
    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    a.requests[0]!.deferred.resolve(false);
    await expect(answer).resolves.toBe(false);
    expect(b.requests).toHaveLength(0);
  });

  it("re-routes a queued app-global prompt to the caller whose invocation asked", async () => {
    const a = makeEndpoint("a", PROJECT);
    const b = makeEndpoint("b", "b".repeat(64));
    let attached = false;
    setPluginFrontendRouter({
      resolve: ({ pluginId }) => {
        const origin = getPluginInvokeOrigin(pluginId);
        if (!attached || !origin) return { kind: "none", reason: "vacant" };
        return { kind: "remote", endpoint: origin.endpoint };
      },
      onChange: (listener) => {
        changeListener = listener;
        return () => (changeListener = null);
      },
    });
    const answer = runInPluginInvocation("acme.global", a.endpoint, () =>
      dispatcher.requestPrompt("acme.global", CONFIRM, null, undefined, {
        whenNoFrontend: "queue",
      })
    );
    // B calls the same plugin meanwhile; it must not inherit A's question.
    await runInPluginInvocation("acme.global", b.endpoint, async () => {
      await flush();
    });
    attached = true;
    changeListener?.();
    await flush();
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(0);
    a.requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("takes a local prompt down when a remote driver takes the project over", async () => {
    const send = vi.fn();
    const wc = {
      id: 7,
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      send,
    };
    registryMock.getWebContentsForProject.mockReturnValue([wc]);
    const { webContents } = await import("electron");
    vi.mocked(webContents.fromId).mockReturnValue(wc as never);
    frontend = { kind: "local" };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    changeListener?.();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ pluginId: "acme.deploy" });
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
    registryMock.getWebContentsForProject.mockReturnValue([]);
  });

  it("does not hand a prompt cancelled mid-move to the next driver", async () => {
    const a = makeEndpoint("a");
    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const controller = new AbortController();
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, controller.signal);
    await flush();
    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    // A's approval lands stale, and the caller cancels in the same turn.
    a.requests[0]!.deferred.resolve(true);
    controller.abort();
    await expect(answer).resolves.toBe(false);
    await flush();
    expect(b.requests).toHaveLength(0);
  });

  it("shows a local app-global prompt in the view of the caller's project, not the front window", async () => {
    const wc = {
      id: 9,
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    };
    registryMock.getWebContentsForProject.mockImplementation((projectId: string) =>
      projectId === PROJECT ? [wc] : []
    );
    frontend = { kind: "local" };
    const caller = makeEndpoint("caller", PROJECT).endpoint;
    void runInPluginInvocation("acme.global", caller, () =>
      dispatcher.requestPrompt("acme.global", CONFIRM, null)
    );
    await flush();
    expect(registryMock.getWebContentsForProject).toHaveBeenCalledWith(PROJECT);
    expect(wc.send).toHaveBeenCalledTimes(1);
    registryMock.getWebContentsForProject.mockReset().mockReturnValue([]);
  });
});
