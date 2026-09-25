// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { PluginParityRow } from "@shared/types/ipc/pluginParity";
import type { HostConnectionState } from "@shared/types/remoteHosts";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/hooks/useHostConnection", () => ({
  useHostConnection: () => ({
    hostId: "studio-01",
    hostName: "studio-01",
    connection: null,
    lastSeenAt: null,
  }),
}));

import { registerPanelKind, unregisterPluginPanelKinds } from "@shared/config/panelKindRegistry";
import { serializeError } from "@shared/utils/ipcErrorSerialization";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { takePendingHostPlugins } from "@/components/Settings/Hosts/hostPluginRequests";
import { isPluginNotOnHostError, isRemoteUnsupportedError } from "../remotePluginView";
import { PluginNotOnHostPlaceholder } from "../PluginNotOnHostPlaceholder";
import { _resetPluginPanelRemovalForTesting, trackPluginPanelKinds } from "../pluginPanelRemoval";
import { useHostPluginParityNotice } from "../useHostPluginParityNotice";
import { describeIncompatibility, summarizePluginParity } from "../pluginParityCopy";

function row(patch: Partial<PluginParityRow>): PluginParityRow {
  return {
    pluginId: "acme.md",
    displayName: "Markdown Preview",
    group: "only-here",
    localVersion: "1.0.0",
    hostVersion: null,
    incompatibility: null,
    action: "install-on-host",
    ...patch,
  };
}

const CONNECTED: HostConnectionState = {
  status: "connected",
  rttMs: null,
  handshake: {
    version: "0.38.0",
    commit: "abc",
    protocolVersion: 1,
    platform: "linux",
    arch: "x64",
  },
};

const parity = {
  diff: vi.fn(async (): Promise<PluginParityRow[]> => []),
  installOnHost: vi.fn(async () => undefined),
  updateOnHost: vi.fn(async () => undefined),
  claimSwitchNotice: vi.fn(async () => true),
};

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    value: { pluginParity: parity },
    configurable: true,
    writable: true,
  });
  window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  _resetPluginPanelRemovalForTesting();
  trackPluginPanelKinds();
});

afterEach(() => {
  vi.clearAllMocks();
  parity.diff.mockImplementation(async () => []);
  parity.claimSwitchNotice.mockImplementation(async () => true);
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  unregisterPluginPanelKinds("acme.md");
  useHostConnectionStore.setState({ connection: null, hostName: null });
});

/** How the preload hands a main-process AppError to the renderer across the contextBridge. */
function acrossBridge(error: object): Error {
  const serialized = serializeError(error);
  const user = serialized.userMessage ? `|${encodeURIComponent(serialized.userMessage)}` : "";
  const details = serialized.details
    ? `|#${encodeURIComponent(JSON.stringify(serialized.details))}`
    : "";
  return new Error(`[AppError|${serialized.code}${user}${details}] ${serialized.message}`);
}

describe("typed plugin errors from the host", () => {
  it("are recognised from the details that survive the bridge", () => {
    const notOnHost = acrossBridge({
      name: "AppError",
      message: "Plugin acme.md is not installed on host local",
      code: "PLUGIN_NOT_ON_HOST",
      details: { code: "PLUGIN_NOT_ON_HOST", pluginId: "acme.md", hostId: "local" },
    });
    expect(isPluginNotOnHostError(notOnHost)).toBe(true);
    expect(isRemoteUnsupportedError(notOnHost)).toBe(false);
    expect(isPluginNotOnHostError(new Error("Failed to fetch dynamically imported module"))).toBe(
      false
    );

    const unsupported = acrossBridge({
      name: "AppError",
      message: "x",
      code: "PLUGIN_INCOMPATIBLE",
      details: {
        code: "PLUGIN_INCOMPATIBLE",
        pluginId: "acme.graph",
        hostId: "local",
        reason: { kind: "remote-unsupported" },
      },
    });
    expect(isRemoteUnsupportedError(unsupported)).toBe(true);
  });
});

describe("PluginNotOnHostPlaceholder", () => {
  it("names the plugin and the host and installs this machine's copy there on request", async () => {
    parity.diff.mockResolvedValue([row({})]);
    const { container, findByRole, getByRole } = render(
      <PluginNotOnHostPlaceholder pluginId="acme.md" />
    );
    await findByRole("button", { name: "Install on studio-01" });
    expect(container.textContent).toContain("Markdown Preview isn't installed on studio-01");
    expect(parity.installOnHost).not.toHaveBeenCalled();
    // The empty state remounts its cells as the copy settles; click the live button.
    await waitFor(() => {
      fireEvent.click(getByRole("button", { name: "Install on studio-01" }));
      expect(parity.installOnHost).toHaveBeenCalledWith({
        hostId: "studio-01",
        pluginId: "acme.md",
      });
    });
  });

  it("explains why a plugin can't run on the host and offers no install", async () => {
    parity.diff.mockResolvedValue([
      row({
        group: "incompatible",
        action: null,
        incompatibility: { kind: "platform", hostPlatform: "linux", supported: ["darwin"] },
      }),
    ]);
    const { container, queryByRole } = render(<PluginNotOnHostPlaceholder pluginId="acme.md" />);
    await waitFor(() => expect(container.textContent).toContain("Has no build for Linux"));
    expect(queryByRole("button", { name: /Install on/ })).toBeNull();
  });

  it("shows one toast when the host removes a plugin under open panels, none for a restore", async () => {
    parity.diff.mockResolvedValue([row({})]);
    registerPanelKind({
      id: "acme.md.preview",
      name: "Preview",
      iconId: "puzzle",
      color: "#888",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "acme.md",
    });
    unregisterPluginPanelKinds("acme.md");

    render(<PluginNotOnHostPlaceholder pluginId="acme.md" kind="acme.md.preview" />);
    render(<PluginNotOnHostPlaceholder pluginId="acme.md" kind="acme.md.preview" />);
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({
      title: "Plugin removed",
      message: expect.stringContaining("Markdown Preview was removed from studio-01"),
    });

    notifyMock.mockClear();
    render(<PluginNotOnHostPlaceholder pluginId="acme.other" kind="acme.other.view" />);
    await act(async () => {});
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("the switch notice", () => {
  it("says once how many of this machine's plugins the host lacks, with Review", async () => {
    parity.diff.mockResolvedValue([
      row({}),
      row({ pluginId: "acme.b", displayName: "B" }),
      row({ pluginId: "acme.c", group: "only-on-host", action: null }),
    ]);
    useHostConnectionStore.setState({
      hostName: "studio-01",
      connection: CONNECTED,
    });
    renderHook(() => useHostPluginParityNotice());
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.message).toBe("2 of your plugins aren't installed on studio-01");
    expect(payload.action.label).toBe("Review");
    payload.action.onClick();
    expect(takePendingHostPlugins()).toBe("studio-01");
    expect(dispatchMock).toHaveBeenCalledWith("host.add", undefined, { source: "user" });
  });

  it("stays quiet when main says this switch was already announced", async () => {
    parity.diff.mockResolvedValue([row({})]);
    parity.claimSwitchNotice.mockResolvedValue(false);
    useHostConnectionStore.setState({ connection: CONNECTED });
    renderHook(() => useHostPluginParityNotice());
    await waitFor(() => expect(parity.claimSwitchNotice).toHaveBeenCalled());
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("asks nothing in a window on this machine", async () => {
    delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    useHostConnectionStore.setState({ connection: CONNECTED });
    renderHook(() => useHostPluginParityNotice());
    await act(async () => {});
    expect(parity.diff).not.toHaveBeenCalled();
  });
});

describe("parity copy", () => {
  it("summarizes a host's differences in one line", () => {
    expect(
      summarizePluginParity([
        row({}),
        row({ pluginId: "b", group: "version-differs", action: "update-on-host" }),
        row({ pluginId: "c", group: "same", action: null }),
      ])
    ).toBe("plugins: 1 missing · 1 older");
    expect(summarizePluginParity([row({ group: "same", action: null })])).toBeNull();
  });

  it("names the host in every reason", () => {
    expect(
      describeIncompatibility(
        { kind: "engine", required: ">=0.40.0", hostVersion: "0.38.0" },
        "studio-01"
      )
    ).toBe(
      "Requires Daintree >=0.40.0; studio-01 runs 0.38.0. It still loads there, but may not work."
    );
    expect(
      describeIncompatibility({ kind: "unconfigured", missing: ["apiToken"] }, "studio-01")
    ).toBe("Set it up on studio-01: apiToken isn't set there.");
  });
});
