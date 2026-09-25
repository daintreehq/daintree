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
  cached: new Set<number>(),
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
  isCachedViewWebContents: (id: number) => registry.cached.has(id),
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
import {
  PluginFrontendMethod,
  REMOTE_CLIPBOARD_TIMEOUT_MS,
} from "../../../services/plugin/pluginFrontendRequests.js";
import type { PluginCapabilityConsentOutcome } from "../../../../shared/types/pluginCapabilityConsent.js";
import { installPluginShellRequests } from "../shellRequests.js";
import type { ClipboardGrantStore } from "../clipboardGrants.js";

function memoryGrants() {
  const decisions = new Map<string, "allow" | "deny">();
  const grants: ClipboardGrantStore = {
    get: (hostId, pluginId, access) => decisions.get(`${hostId}|${pluginId}|${access}`) ?? null,
    set: (hostId, pluginId, access, decision) => {
      decisions.set(`${hostId}|${pluginId}|${access}`, decision);
    },
  };
  return { grants, decisions };
}

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
  let clock = 0;
  let grants: ClipboardGrantStore;
  let decisions: Map<string, "allow" | "deny">;
  let askGrant: ReturnType<
    typeof vi.fn<(...args: unknown[]) => Promise<PluginCapabilityConsentOutcome>>
  >;

  beforeEach(() => {
    registry.views.clear();
    vi.clearAllMocks();
    _resetReverseRequestMethodsForTesting();
    registry.cached.clear();
    ({ grants, decisions } = memoryGrants());
    askGrant = vi.fn(async (): Promise<PluginCapabilityConsentOutcome> => "approved-and-pin");
    teardown = installPluginShellRequests({
      hostName: (id) => `name-of-${id}`,
      clipboardGrants: grants,
      askClipboardGrant: askGrant,
      now: () => clock,
    });
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

  it("asks once before a host's plugin writes this machine's clipboard, then remembers", async () => {
    makeView();
    const write = () =>
      ask(PluginFrontendMethod.CLIPBOARD, { op: "writeText", pluginId: "acme.deploy", text: "hi" });
    await write();
    await write();
    expect(electronMock.clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(askGrant).toHaveBeenCalledTimes(1);
    expect(askGrant).toHaveBeenCalledWith(expect.objectContaining({ id: WC_ID }), {
      hostId: HOST,
      pluginId: "acme.deploy",
      access: "write",
    });
    expect(decisions.get(`${HOST}|acme.deploy|write`)).toBe("allow");
  });

  it("refuses without a grant, and remembers a refusal", async () => {
    makeView();
    askGrant.mockResolvedValue("rejected");
    const write = () =>
      ask(PluginFrontendMethod.CLIPBOARD, { op: "writeText", pluginId: "acme.deploy", text: "hi" });
    await expect(write()).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(write()).rejects.toMatchObject({ code: "PERMISSION" });
    expect(askGrant).toHaveBeenCalledTimes(1);
    expect(electronMock.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("decides nothing when the question never reached anyone", async () => {
    makeView();
    askGrant.mockResolvedValue("undeliverable");
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "readText", pluginId: "acme.deploy" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(decisions.size).toBe(0);
    expect(electronMock.clipboard.readText).not.toHaveBeenCalled();
  });

  it("never lets a write grant stand in for reading, nor one host's grant for another's", async () => {
    makeView();
    grants.set(HOST, "acme.deploy", "write", "allow");
    askGrant.mockResolvedValue("rejected");
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "readText", pluginId: "acme.deploy" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(askGrant).toHaveBeenCalledWith(expect.anything(), {
      hostId: HOST,
      pluginId: "acme.deploy",
      access: "read",
    });
    expect(electronMock.clipboard.readText).not.toHaveBeenCalled();

    // The same plugin id on another host is another plugin.
    registry.views.clear();
    makeView(`other-host:${PROJECT}`);
    askGrant.mockClear();
    askGrant.mockResolvedValue("rejected");
    await expect(
      ask(
        PluginFrontendMethod.CLIPBOARD,
        { op: "writeText", pluginId: "acme.deploy", text: "x" },
        "other-host"
      )
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(askGrant).toHaveBeenCalledTimes(1);
  });

  it("shares one question between calls that arrive while it is open", async () => {
    makeView();
    let answer!: (outcome: PluginCapabilityConsentOutcome) => void;
    askGrant.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const payload = { op: "writeText", pluginId: "acme.deploy", text: "hi" };
    const first = ask(PluginFrontendMethod.CLIPBOARD, payload);
    const second = ask(PluginFrontendMethod.CLIPBOARD, payload);
    await new Promise((r) => setTimeout(r, 0));
    answer("approved-and-pin");
    await Promise.all([first, second]);
    expect(askGrant).toHaveBeenCalledTimes(1);
  });

  it("uses this machine's clipboard only from the view in front", async () => {
    grants.set(HOST, "acme.deploy", "read", "allow");
    grants.set(HOST, "acme.deploy", "write", "allow");
    makeView(undefined, true);
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "readText", pluginId: "acme.deploy" })
    ).resolves.toBe("shell clipboard");
    makeView(undefined, false);
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "readText", pluginId: "acme.deploy" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "writeText", pluginId: "acme.deploy", text: "x" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    // A cached view of a focused window is not the one the person sees.
    makeView(undefined, true);
    registry.cached.add(WC_ID);
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "readText", pluginId: "acme.deploy" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(askGrant).not.toHaveBeenCalled();
  });

  it("carries out a first call the person took a minute to approve", async () => {
    makeView();
    clock = 0;
    askGrant.mockImplementation(async () => {
      clock = 60_000;
      return "approved-and-pin";
    });
    await ask(PluginFrontendMethod.CLIPBOARD, {
      op: "writeText",
      pluginId: "acme.deploy",
      text: "hi",
    });
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith("hi");
  });

  it("remembers a late approval but does not carry out the call the host gave up on", async () => {
    makeView();
    clock = 0;
    askGrant.mockImplementation(async () => {
      clock = REMOTE_CLIPBOARD_TIMEOUT_MS;
      return "approved-and-pin";
    });
    const write = () =>
      ask(PluginFrontendMethod.CLIPBOARD, { op: "writeText", pluginId: "acme.deploy", text: "hi" });
    await expect(write()).rejects.toMatchObject({ code: "STALE_GENERATION" });
    expect(electronMock.clipboard.writeText).not.toHaveBeenCalled();
    expect(decisions.get(`${HOST}|acme.deploy|write`)).toBe("allow");
    await write();
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith("hi");
  });

  it("re-checks the view is still in front after the person answers", async () => {
    makeView();
    askGrant.mockImplementation(async () => {
      registry.views.get(WC_ID)!.focused = false;
      return "approved-and-pin";
    });
    await expect(
      ask(PluginFrontendMethod.CLIPBOARD, { op: "readText", pluginId: "acme.deploy" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(electronMock.clipboard.readText).not.toHaveBeenCalled();
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
