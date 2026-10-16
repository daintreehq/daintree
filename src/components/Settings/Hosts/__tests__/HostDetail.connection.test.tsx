// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";

const client = vi.hoisted(() => ({
  update: vi.fn(async (payload: unknown) => payload),
  connect: vi.fn(async () => undefined),
  connectAndSettle: vi.fn(async (): Promise<HostConnectionState> => ({
    status: "connecting",
    attempt: 1,
  })),
  disconnect: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
  listClipboardGrants: vi.fn(async () => []),
  listPluginViewConsents: vi.fn(async () => []),
  resetClipboardGrants: vi.fn(async () => undefined),
}));

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({ HostCopySettingsSection: () => null }));

import { HostDetail } from "../HostDetail";

function entry(connection: HostConnectionState): HostListEntry {
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
      assistantMessagingEnabled: false,
      assistantStartEnabled: false,
    },
    connection,
    summary: null,
  };
}

const HANDSHAKE = {
  version: "1",
  commit: "c",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;

beforeEach(() => {
  client.connect.mockClear();
  client.connectAndSettle.mockClear();
  client.disconnect.mockClear();
});

describe("HostDetail connection controls", () => {
  it("disconnects a connected host with no window on it", async () => {
    render(
      <HostDetail
        entry={entry({ status: "connected", rttMs: 4, handshake: HANDSHAKE })}
        onBack={() => {}}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    });
    expect(client.disconnect).toHaveBeenCalledWith("studio-01");
  });

  it("stops a link that is still retrying", () => {
    render(
      <HostDetail
        entry={entry({ status: "unreachable", lastSeenAt: null, detail: "timed out" })}
        onBack={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry for a link that stopped retrying", async () => {
    render(
      <HostDetail
        entry={entry({
          status: "unreachable",
          lastSeenAt: null,
          detail: "Permission denied (publickey).",
          stoppedRetrying: true,
        })}
        onBack={() => {}}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(client.connectAndSettle).toHaveBeenCalledWith("studio-01");
  });

  it("says a Connect failed when the link reports it unreachable, in ssh's words", async () => {
    client.connectAndSettle.mockResolvedValueOnce({
      status: "unreachable",
      lastSeenAt: null,
      detail: "Permission denied (publickey).",
      stoppedRetrying: true,
    });
    render(<HostDetail entry={entry({ status: "disconnected" })} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't connect: Permission denied (publickey)."
    );
  });

  it("leaves Host mode off to its own row rather than calling it a failed connect", async () => {
    client.connectAndSettle.mockResolvedValueOnce({
      status: "unreachable",
      lastSeenAt: null,
      detail: null,
      hostModeOff: true,
      stoppedRetrying: true,
    });
    render(<HostDetail entry={entry({ status: "disconnected" })} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps Retry beside Set up when Host mode is off there", () => {
    render(
      <HostDetail
        entry={entry({
          status: "unreachable",
          lastSeenAt: null,
          detail: null,
          hostModeOff: true,
          stoppedRetrying: true,
        })}
        onBack={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Set up…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("offers Connect for a host nothing has dialled", () => {
    render(<HostDetail entry={entry({ status: "disconnected" })} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });
});
