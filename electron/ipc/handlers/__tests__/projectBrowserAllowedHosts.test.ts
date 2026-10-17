import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const projectStoreMock = vi.hoisted(() => ({
  addBrowserAllowedHost: vi.fn(async (_projectId: string, hostname: string) => [hostname]),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, dialog: {} }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import { registerProjectSettingsHandlers } from "../projectCrud/settings.js";
import { CHANNELS } from "../../channels.js";

function addHost(payload: unknown): Promise<unknown> {
  const handler = ipcHandlers.get(CHANNELS.PROJECT_ADD_BROWSER_ALLOWED_HOST);
  if (typeof handler !== "function") throw new Error("handler not registered");
  return Promise.resolve(Reflect.apply(handler, undefined, [{ sender: {} }, payload]));
}

describe("project:add-browser-allowed-host", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    cleanup = registerProjectSettingsHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("hands Main's settings write the host in the form the allow-list compares", async () => {
    await addHost({ projectId: "p1", hostname: "  Example.COM " });

    expect(projectStoreMock.addBrowserAllowedHost).toHaveBeenCalledWith("p1", "example.com");
  });

  it.each(["", "example.com/path", "user@example.com", "exa mple.com"])(
    "refuses %j as a hostname",
    async (hostname) => {
      await addHost({ projectId: "p1", hostname }).catch(() => undefined);

      expect(projectStoreMock.addBrowserAllowedHost).not.toHaveBeenCalled();
    }
  );
});
