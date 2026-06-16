// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeWebContents {
  id: number;
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

function makeFakeWindow(id: number): { webContents: FakeWebContents; isDestroyed: () => boolean } {
  const wc: FakeWebContents = {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  return { webContents: wc, isDestroyed: () => false };
}

let focusedWindow: ReturnType<typeof makeFakeWindow> | null = null;

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => `/mock/electron/${key}`),
    getVersion: vi.fn(() => "0.0.0"),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: () => focusedWindow,
    getAllWindows: () => (focusedWindow ? [focusedWindow] : []),
  },
}));

vi.mock("../../../window/windowRef.js", () => ({
  getMainWindow: () => focusedWindow,
}));

import { handleResolveConsent, _resetCapabilityConsentBridgeForTest } from "../pluginCapability.js";
import {
  getPluginCapabilityConsentService,
  _resetPluginCapabilityServicesForTest,
} from "../../../services/plugin-capability/instances.js";
import type { IpcContext } from "../../types.js";

function ctx(webContentsId: number): IpcContext {
  return { event: {} as never, webContentsId, senderWindow: null, projectId: null };
}

beforeEach(() => {
  focusedWindow = makeFakeWindow(7);
  // Install the bridge directly (mirrors registerPluginCapabilityHandlers).
  getPluginCapabilityConsentService();
});

afterEach(() => {
  _resetCapabilityConsentBridgeForTest();
  _resetPluginCapabilityServicesForTest();
  focusedWindow = null;
});

describe("pluginCapability consent bridge", () => {
  it("pushes a consent-request to the focused window and ignores a reply from a different sender", async () => {
    // Wire the real bridge onto the service via the handler's install path.
    const { registerPluginCapabilityHandlers } = await import("../pluginCapability.js");
    const dispose = registerPluginCapabilityHandlers();

    const decisionPromise = getPluginCapabilityConsentService().ensureAllowed(
      "acme.x",
      "Acme",
      "shell:exec",
      ["shell:exec"]
    );

    // The bridge pushed exactly one consent-request to the focused window.
    const send = focusedWindow!.webContents.send;
    expect(send).toHaveBeenCalledTimes(1);
    const pushed = send.mock.calls[0][1] as {
      name: string;
      payload: { requestId: string; capability: string };
    };
    expect(pushed.name).toBe("plugin-capability:consent-request");
    expect(pushed.payload.capability).toBe("shell:exec");
    const requestId = pushed.payload.requestId;

    // A reply from the WRONG WebContents must not settle the prompt.
    await handleResolveConsent(ctx(999), { requestId, decision: "approved-and-pin" });

    // The correct sender settles it.
    await handleResolveConsent(ctx(7), { requestId, decision: "approved-and-pin" });
    await expect(decisionPromise).resolves.toBeUndefined();

    dispose();
  });

  it("is a no-op for an unknown requestId", async () => {
    await expect(
      handleResolveConsent(ctx(7), { requestId: "does-not-exist", decision: "rejected" })
    ).resolves.toBeUndefined();
  });
});
