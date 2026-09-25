import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    ipcMain: {
      on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(handler);
      }),
      removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
        listeners.get(channel)?.delete(handler);
      }),
    },
    emit(channel: string, event: unknown, payload: unknown) {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(event, payload);
    },
    clipboard: {
      writeText: vi.fn(),
      writeImage: vi.fn(),
      readText: vi.fn(() => "shell clipboard"),
    },
  };
});

const registry = vi.hoisted(() => ({
  views: new Map<number, { projectKey: string | null; focused: boolean; wc: unknown }>(),
}));

const consentMock = vi.hoisted(() => ({
  requestConsentInWebContents: vi.fn(async (): Promise<string> => "approved-once"),
}));

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
  clipboard: electronMock.clipboard,
  webContents: { fromId: (id: number) => registry.views.get(id)?.wc },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  resolveLiveWebContents: (id: number) => registry.views.get(id)?.wc ?? null,
  getProjectForWebContents: (id: number) => registry.views.get(id)?.projectKey ?? null,
  getWindowForWebContents: (wc: { id: number }) => ({
    isFocused: () => registry.views.get(wc.id)?.focused ?? false,
  }),
  getWebContentsForProject: () => [],
  isCachedViewWebContents: () => false,
}));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: () => null,
  getProjectViewManager: () => null,
}));
vi.mock("../../../ipc/handlers/pluginCapability.js", () => ({
  requestConsentInWebContents: consentMock.requestConsentInWebContents,
}));
vi.mock("../../runtime.js", () => ({ getRemoteService: () => undefined }));

import { CHANNELS } from "../../../ipc/channels.js";
import {
  _resetReverseRequestMethodsForTesting,
  answerReverseRequest,
} from "../../client/reverseRequests.js";
import { PluginFrontendMethod } from "../../../services/plugin/pluginFrontendRequests.js";
import { installPluginShellRequests } from "../shellRequests.js";

const HOST = "studio-01";
const PROJECT = "a".repeat(64);
const WC_ID = 11;

function makeView(projectKey: string | null = `${HOST}:${PROJECT}`, focused = true) {
  const wc = {
    id: WC_ID,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  registry.views.set(WC_ID, { projectKey, focused, wc });
  return wc;
}

const ask = (method: string, payload: unknown, hostId = HOST) =>
  answerReverseRequest({ hostId, webContentsId: WC_ID, method, payload });

const promptPayload = (overrides: Record<string, unknown> = {}) => ({
  promptId: "p-1",
  pluginId: "acme.deploy",
  pluginDisplayName: "Deploy",
  params: { kind: "confirm", options: { title: "Ship it?" } },
  ...overrides,
});

describe("Shell answers for a host's plugins", () => {
  let teardown: () => void;

  beforeEach(() => {
    registry.views.clear();
    vi.clearAllMocks();
    _resetReverseRequestMethodsForTesting();
    teardown = installPluginShellRequests({ hostName: (id) => `name-of-${id}` });
  });

  afterEach(() => {
    teardown();
    _resetReverseRequestMethodsForTesting();
  });

  it("shows a host plugin's prompt in the driving view and answers with the person's value", async () => {
    const wc = makeView();
    const answer = ask(PluginFrontendMethod.PROMPT, promptPayload());
    await Promise.resolve();
    const [channel, request] = wc.send.mock.calls[0]!;
    expect(channel).toBe(CHANNELS.PLUGIN_UI_PROMPT_REQUEST);
    expect(request).toMatchObject({
      pluginId: "acme.deploy",
      params: { kind: "confirm", options: { title: "Ship it?" } },
    });
    expect(request.params.waited).toBeUndefined();
    electronMock.emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: WC_ID } },
      { promptId: request.promptId, result: true }
    );
    await expect(answer).resolves.toBe(true);
  });

  it("marks a prompt that waited with the host's name and the time it was asked", async () => {
    const wc = makeView();
    void ask(PluginFrontendMethod.PROMPT, promptPayload({ askedAt: 12_345 }));
    await Promise.resolve();
    expect(wc.send.mock.calls[0]![1].params.waited).toEqual({
      hostName: `name-of-${HOST}`,
      askedAt: 12_345,
    });
  });

  it("refuses a view bound to another host, and a project plugin of another project", async () => {
    makeView(`other-host:${PROJECT}`);
    await expect(ask(PluginFrontendMethod.PROMPT, promptPayload())).rejects.toMatchObject({
      code: "VALIDATION",
    });
    makeView();
    await expect(
      ask(
        PluginFrontendMethod.PROMPT,
        promptPayload({ pluginId: `project__${"b".repeat(64)}__acme.deploy` })
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a malformed payload", async () => {
    makeView();
    await expect(
      ask(PluginFrontendMethod.PROMPT, { promptId: "x", pluginId: "acme.deploy" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("takes a prompt down when the host cancels it", async () => {
    const wc = makeView();
    const answer = ask(PluginFrontendMethod.PROMPT, promptPayload());
    await Promise.resolve();
    await ask(PluginFrontendMethod.PROMPT_CANCEL, { pluginId: "acme.deploy", promptId: "p-1" });
    await expect(answer).resolves.toBe(false);
    expect(wc.send).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_UI_PROMPT_CANCEL,
      expect.objectContaining({ pluginId: "acme.deploy" })
    );
  });

  it("puts a consent question to the view's own dialog, scoped to its project", async () => {
    const wc = makeView();
    const payload = {
      pluginId: "acme.deploy",
      pluginDisplayName: "Deploy",
      capability: "shell:exec",
      declaredCapabilities: ["shell:exec"],
    };
    await expect(ask(PluginFrontendMethod.CONSENT, payload)).resolves.toBe("approved-once");
    expect(consentMock.requestConsentInWebContents).toHaveBeenCalledWith(wc, payload);
    await expect(
      ask(PluginFrontendMethod.CONSENT, { ...payload, capability: "not-a-capability" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("writes to this machine's clipboard for the driving view", async () => {
    makeView();
    await ask(PluginFrontendMethod.CLIPBOARD, {
      op: "writeText",
      pluginId: "acme.deploy",
      text: "hi",
    });
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith("hi");
  });

  it("reads this machine's clipboard only while the host's window is focused", async () => {
    makeView(undefined, true);
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "readText", pluginId: "acme.deploy" })
    ).resolves.toBe("shell clipboard");
    makeView(undefined, false);
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "readText", pluginId: "acme.deploy" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
  });
});

describe("host plugin toasts", () => {
  let teardown: () => void;
  beforeEach(() => {
    registry.views.clear();
    _resetReverseRequestMethodsForTesting();
    teardown = installPluginShellRequests({ hostName: (id) => id });
  });
  afterEach(() => teardown());

  it("shows a host plugin's toast in the driving view only", async () => {
    const wc = makeView();
    await ask(PluginFrontendMethod.TOAST, {
      pluginId: "acme.deploy",
      type: "success",
      message: "Deploy: shipped",
    });
    expect(wc.send).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "success",
      message: "Deploy: shipped",
      duration: undefined,
      rateLimitKey: `plugin:${HOST}:acme.deploy:success`,
    });
  });
});

describe("host prompts when the link drops", () => {
  it("takes the prompt down when the link it came over closes", async () => {
    registry.views.clear();
    _resetReverseRequestMethodsForTesting();
    const closers = new Set<() => void>();
    const session = {
      onClose: (cb: () => void) => {
        closers.add(cb);
        return () => closers.delete(cb);
      },
    };
    let opened:
      ((hostId: string, info: { session: typeof session; webContentsId: number }) => void) | null =
      null;
    const teardown = installPluginShellRequests({
      hostName: (id) => id,
      onEndpointOpened: (listener) => {
        opened = listener;
        return () => {};
      },
    });
    makeView();
    opened!(HOST, { session, webContentsId: WC_ID });
    const answer = ask(PluginFrontendMethod.PROMPT, promptPayload());
    await Promise.resolve();
    for (const close of [...closers]) close();
    await expect(answer).resolves.toBe(false);
    expect(closers.size).toBe(0);
    teardown();
  });
});
