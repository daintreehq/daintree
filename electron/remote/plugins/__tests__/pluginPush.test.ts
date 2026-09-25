import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => false),
  isCachedViewWebContents: vi.fn(() => false),
}));

import { broadcastToProjectRenderers } from "../../../ipc/utils.js";
import {
  _resetEndpointRegistryForTesting,
  getEndpointRegistry,
} from "../../../ipc/endpointRegistry.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import { acceptHostPush } from "../../hybrid/eventsPush.js";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);

function remote(handle: number, projectId: string): ClientEndpoint {
  return {
    endpointId: `ep-${handle}`,
    clientId: "client-mbp",
    projectId,
    kind: "remote-view",
    handle,
    send: vi.fn(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => {} }),
    isClosed: () => false,
  };
}

describe("plugin push channels for windows on another machine", () => {
  beforeEach(() => _resetEndpointRegistryForTesting());

  it("reach the remote endpoints of the plugin's project, and only those", () => {
    const mine = remote(-1, PROJECT);
    const theirs = remote(-2, OTHER);
    getEndpointRegistry().add(mine);
    getEndpointRegistry().add(theirs);
    const envelope = { panelId: null, payload: { n: 1 } };
    broadcastToProjectRenderers(PROJECT, "plugin:acme.graph:update", envelope);
    expect(mine.send).toHaveBeenCalledWith({
      type: "event",
      channel: "plugin:acme.graph:update",
      args: [envelope],
    });
    expect(theirs.send).not.toHaveBeenCalled();
  });

  it("are taken from the host by the Shell", () => {
    expect(acceptHostPush("plugin:acme.graph:update", [{ panelId: null, payload: 1 }])).toBe(true);
  });
});
