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

function makeEndpoint() {
  const requests: Array<{ method: string; payload: unknown; deferred: Deferred }> = [];
  let closed = false;
  const endpoint: ClientEndpoint = {
    endpointId: "s1:ep",
    clientId: "client-mbp",
    projectId: PROJECT,
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
});
