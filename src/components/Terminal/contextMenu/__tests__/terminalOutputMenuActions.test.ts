// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchMock, copyWithToastMock, client } = vi.hoisted(() => ({
  dispatchMock: vi.fn(() => Promise.resolve({ ok: true, result: undefined })),
  copyWithToastMock: vi.fn<(label: string, value: string) => void>(),
  client: { windows: false },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/lib/copyWithToast", () => ({ copyWithToast: copyWithToastMock }));
vi.mock("@/services/terminal/FileLinksAddon", () => ({ reportFileLinkFailure: vi.fn() }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => !client.windows,
  isWindows: () => client.windows,
}));

import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import { runTerminalOutputMenuAction } from "../terminalOutputMenuActions";

const PATH = "/home/greg/repo/src/index.ts";
const target = { openHoveredLink: vi.fn(), openLink: vi.fn() };

function reveal() {
  return runTerminalOutputMenuAction(`reveal-in-finder:${PATH}`, target, "context-menu");
}

beforeEach(() => {
  client.windows = false;
  dispatchMock.mockClear();
  copyWithToastMock.mockClear();
});

afterEach(() => {
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("runTerminalOutputMenuAction reveal", () => {
  it("reveals a local path in the file manager", () => {
    expect(reveal()).toBe(true);

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.showItemInFolder",
      { path: PATH },
      { source: "context-menu" }
    );
    expect(copyWithToastMock).not.toHaveBeenCalled();
  });

  it("copies an ssh host's path, before main has named the connection too", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };

    reveal();

    expect(copyWithToastMock).toHaveBeenCalledWith("Host path", PATH);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("reveals a WSL distro's path in Explorer from a Windows PC before main names the connection", () => {
    // The row already reads "Show in Explorer" here; copying instead would
    // contradict it.
    client.windows = true;
    window.__DAINTREE_HOST_ID__ = { id: "wsl-ubuntu" };

    reveal();

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.showItemInFolder",
      { path: PATH },
      { source: "context-menu" }
    );
    expect(copyWithToastMock).not.toHaveBeenCalled();
  });

  it("follows the connection main reports", () => {
    window.__DAINTREE_HOST_ID__ = { id: "wsl-ubuntu" };
    setHostPlatformInfo({ connection: { kind: "wsl", distro: "Ubuntu" } });

    reveal();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(copyWithToastMock).not.toHaveBeenCalled();
  });
});
