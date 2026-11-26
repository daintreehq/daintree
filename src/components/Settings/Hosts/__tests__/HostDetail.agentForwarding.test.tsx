// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAgentForwardingCheck } from "@shared/types/ipc/remoteHosts";
import type { HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";

const client = vi.hoisted(() => ({
  update: vi.fn(async (payload: unknown) => payload),
  checkAgentForwarding: vi.fn(async (_hostId: string): Promise<HostAgentForwardingCheck> => ({
    localAgent: true,
  })),
  listClipboardGrants: vi.fn(async () => []),
  readSshHostKeys: vi.fn(async () => ({ outcome: { status: "not-connected" }, baselines: [] })),
  listPluginViewConsents: vi.fn(async () => []),
  resetClipboardGrants: vi.fn(async () => undefined),
}));
const platform = vi.hoisted(() => ({ windows: false }));

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({ HostCopySettingsSection: () => null }));
vi.mock("../HostSessionsSection", () => ({ HostSessionsSection: () => null }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isWindows: () => platform.windows,
}));

import { HostDetail } from "../HostDetail";

const LABEL = "Forward this computer's ssh-agent to terminals";

function entry(
  forwardSshAgent?: boolean,
  connection: HostConnectionState = { status: "unreachable", lastSeenAt: null, detail: null }
): HostListEntry {
  return {
    descriptor: {
      id: "studio-01",
      name: "studio-01",
      connection: { kind: "ssh", target: "greg@studio" },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: true,
      ...(forwardSshAgent === undefined ? {} : { forwardSshAgent }),
    },
    connection,
    summary: null,
  };
}

const CONNECTED: HostConnectionState = {
  status: "connected",
  rttMs: null,
  handshake: { version: "1", commit: "c", protocolVersion: 1, platform: "linux", arch: "x64" },
};

const forwardSwitch = () => screen.getByRole("switch", { name: LABEL });

function description(): string {
  return (forwardSwitch().getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

beforeEach(() => {
  client.update.mockReset();
  client.update.mockImplementation(async (payload: unknown) => payload);
  client.checkAgentForwarding.mockReset();
  client.checkAgentForwarding.mockResolvedValue({ localAgent: true });
  platform.windows = false;
});

describe("HostDetail agent forwarding (#17432)", () => {
  it("is off by default, saves only its own field, and checks nothing while off", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(forwardSwitch().getAttribute("aria-checked")).toBe("false");
    expect(description()).toContain("studio-01");
    expect(client.checkAgentForwarding).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(forwardSwitch());
    });

    expect(client.update).toHaveBeenCalledWith({ hostId: "studio-01", forwardSshAgent: true });
    expect(client.checkAgentForwarding).toHaveBeenCalledWith("studio-01");
  });

  it("warns when the connected host's ssh config names another IdentityAgent, or none", async () => {
    client.checkAgentForwarding.mockResolvedValue({
      localAgent: true,
      hostIdentityAgent: "/home/greg/.1password/agent.sock",
    });
    const { rerender } = render(<HostDetail entry={entry(true, CONNECTED)} onBack={() => {}} />);
    await act(async () => {});
    expect(description()).toMatch(/studio-01's ssh config sets IdentityAgent/);

    // Disconnected, main reports only this computer's side, and the warning goes.
    client.checkAgentForwarding.mockResolvedValue({ localAgent: true });
    await act(async () => {
      rerender(<HostDetail entry={entry(true)} onBack={() => {}} />);
    });
    expect(description()).not.toMatch(/IdentityAgent/);

    client.checkAgentForwarding.mockResolvedValue({ localAgent: true, hostIdentityAgent: "none" });
    await act(async () => {
      rerender(<HostDetail entry={entry(true, CONNECTED)} onBack={() => {}} />);
    });
    expect(description()).toMatch(/studio-01's ssh config sets IdentityAgent/);
  });

  it("turns a saved switch off", async () => {
    render(<HostDetail entry={entry(true)} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(forwardSwitch());
    });
    expect(client.update).toHaveBeenCalledWith({ hostId: "studio-01", forwardSshAgent: false });
  });

  it("says nothing of an IdentityAgent that still names SSH_AUTH_SOCK, or none", async () => {
    client.checkAgentForwarding.mockResolvedValue({
      localAgent: true,
      hostIdentityAgent: "SSH_AUTH_SOCK",
    });
    const { rerender } = render(<HostDetail entry={entry(true)} onBack={() => {}} />);
    await act(async () => {});
    expect(description()).not.toMatch(/IdentityAgent/);

    client.checkAgentForwarding.mockResolvedValue({ localAgent: true, hostIdentityAgent: null });
    await act(async () => {
      rerender(<HostDetail entry={entry(true, CONNECTED)} onBack={() => {}} />);
    });
    expect(client.checkAgentForwarding).toHaveBeenCalledTimes(2);
    expect(description()).not.toMatch(/IdentityAgent/);
  });

  it("says when this computer has no agent to forward", async () => {
    client.checkAgentForwarding.mockResolvedValue({ localAgent: false });
    await act(async () => {
      render(<HostDetail entry={entry(true)} onBack={() => {}} />);
    });

    expect(description()).toMatch(/No ssh-agent is running on this computer/);
  });

  it("keeps the saved value when saving fails", async () => {
    client.update.mockRejectedValueOnce(new Error("disk full"));
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(forwardSwitch());
    });
    expect(forwardSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Couldn't save this setting|disk full/)).toBeTruthy();
  });

  it("isn't offered on Windows", () => {
    platform.windows = true;
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(screen.queryByText(LABEL)).toBeNull();
  });
});
