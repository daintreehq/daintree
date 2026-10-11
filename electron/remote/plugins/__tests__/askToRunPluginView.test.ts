import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  window: {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  },
}));
vi.mock("electron", () => ({
  dialog: { showMessageBox: electron.showMessageBox },
  webContents: { fromId: () => ({ isDestroyed: () => false }) },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: () => electron.window,
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({ getDriveLeaseService: () => null }));
vi.mock("../../../setup/protocols.js", () => ({
  fetchLocalPluginAsset: vi.fn(),
  setRemotePluginAssetProxy: vi.fn(),
}));
vi.mock("../shellRequests.js", () => ({
  defaultHostName: () => "studio-01",
  installPluginShellRequests: () => () => {},
}));

import { askToRunPluginView } from "../install.js";

const question = {
  hostId: "studio-01",
  pluginId: "acme.docker",
  kind: "new" as const,
  webContentsId: 7,
};

beforeEach(() => {
  electron.showMessageBox.mockReset();
  electron.window.destroyed = false;
});

describe("askToRunPluginView", () => {
  it("runs the view only on the person's yes", async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(askToRunPluginView(question)).resolves.toBe(true);
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(askToRunPluginView(question)).resolves.toBe(false);
  });

  it("holds no answer when the window closed under the question", async () => {
    electron.showMessageBox.mockImplementationOnce(async () => {
      electron.window.destroyed = true;
      return { response: 1 };
    });
    await expect(askToRunPluginView(question)).resolves.toBeNull();
  });
});
