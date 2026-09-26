import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";

const m = vi.hoisted(() => ({
  notify: vi.fn(),
  hosts: [] as HostListEntry[],
  switchWindowHost: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/notify", () => ({ notify: m.notify }));
vi.mock("../hostList", () => ({
  getHostListSnapshot: () => ({ hosts: m.hosts, localSummary: null }),
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve({ ok: true })) },
}));

import { ClientAppError } from "@/utils/clientAppError";
import {
  _resetHostProjectPickerForTesting,
  currentHostProjectPickerRequest,
  registerHostProjectPickerHost,
} from "@/components/HostSwitch/hostProjectPickerRequests";
import { takePendingHostUpdate } from "@/components/Settings/Hosts/hostUpdateRequests";
import { switchToHost } from "../hostSwitching";

const HANDSHAKE = {
  version: "1.3.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;

function studio(connection: HostListEntry["connection"]): HostListEntry {
  return {
    descriptor: {
      id: "h1",
      name: "studio-01",
      connection: { kind: "ssh", target: "greg@studio" },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
    },
    connection,
    summary: null,
  };
}

beforeEach(() => {
  _resetHostProjectPickerForTesting();
  m.notify.mockClear();
  m.switchWindowHost.mockReset();
  m.hosts = [];
  (globalThis as unknown as { window: unknown }).window = {
    electron: {
      remoteHosts: { switchWindowHost: m.switchWindowHost },
      update: { checkForUpdates: m.checkForUpdates },
    },
  };
});

afterEach(() => _resetHostProjectPickerForTesting());

describe("switchToHost", () => {
  it("shows the host's project list when the host had nothing to return to", async () => {
    registerHostProjectPickerHost();
    m.switchWindowHost.mockResolvedValue({ outcome: "choose-project", hostId: "h1" });
    await switchToHost("h1", false);
    expect(m.switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: false });
    expect(currentHostProjectPickerRequest()).toMatchObject({ hostId: "h1" });
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("leaves nothing open when the switch landed", async () => {
    registerHostProjectPickerHost();
    m.switchWindowHost.mockResolvedValue({ outcome: "switched", hostId: "h1", projectId: "p" });
    await switchToHost("h1", false);
    expect(currentHostProjectPickerRequest()).toBeNull();
  });

  it("offers the refused host's update, named for it, instead of a retry", async () => {
    m.hosts = [
      studio({
        status: "version-mismatch",
        mismatch: { kind: "version", local: "1.4.0", remote: "1.3.0" },
        remote: HANDSHAKE,
      }),
    ];
    m.switchWindowHost.mockRejectedValue(
      new ClientAppError("HOST_VERSION_MISMATCH", "different build", "Update it to connect.")
    );
    await switchToHost("h1", false);
    const toast = m.notify.mock.calls[0]![0] as {
      title: string;
      actions: Array<{ label: string; onClick: () => void }>;
    };
    expect(toast.title).toBe("Couldn't switch to studio-01");
    expect(toast.actions.map((action) => action.label)).toEqual(["Update studio-01"]);
    toast.actions[0]!.onClick();
    expect(takePendingHostUpdate()).toBe("h1");
  });

  it("offers a retry for any other failure", async () => {
    m.hosts = [studio({ status: "unreachable", lastSeenAt: null, detail: null })];
    m.switchWindowHost.mockRejectedValue(new ClientAppError("HOST_DISCONNECTED", "gone"));
    await switchToHost("h1", false);
    const toast = m.notify.mock.calls[0]![0] as { actions: Array<{ label: string }> };
    expect(toast.actions.map((action) => action.label)).toEqual(["Retry"]);
  });
});
