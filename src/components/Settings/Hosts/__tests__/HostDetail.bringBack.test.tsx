// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostBringBackAnswer } from "@shared/types/hostWake";
import type { HostDescriptor, HostListEntry } from "@shared/types/remoteHosts";

const client = vi.hoisted(() => ({
  update: vi.fn(async (payload: unknown) => payload),
  bringBack: vi.fn(),
  connectAndSettle: vi.fn(),
  listClipboardGrants: vi.fn(async () => []),
  listPluginViewConsents: vi.fn(async () => []),
  resetClipboardGrants: vi.fn(async () => undefined),
}));

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({ HostCopySettingsSection: () => null }));
vi.mock("../HostSessionsSection", () => ({ HostSessionsSection: () => null }));

import { HostDetail } from "../HostDetail";

function entry(
  descriptor: Partial<HostDescriptor> = {},
  connection: HostListEntry["connection"] = {
    status: "unreachable",
    lastSeenAt: null,
    detail: "timed out",
  }
): HostListEntry {
  return {
    descriptor: {
      id: "studio-01",
      name: "studio-01",
      connection: { kind: "ssh", target: "greg@studio" },
      platform: "darwin",
      arch: "arm64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: true,
      ...descriptor,
    },
    connection,
    summary: null,
  };
}

function answer(overrides: Partial<HostBringBackAnswer>): HostBringBackAnswer {
  return {
    status: "connected",
    wake: "not_set_up",
    reached: false,
    startRequested: false,
    observed: null,
    elapsedMs: 1_000,
    ...overrides,
  };
}

const bringBackButton = () => screen.getByRole("button", { name: "Bring back" });

beforeEach(() => {
  client.update.mockReset();
  client.update.mockImplementation(async (payload: unknown) => payload);
  client.bringBack.mockReset();
});

describe("HostDetail Bring back (#16170)", () => {
  it("says what the attempt observed when the host didn't come back, once per press", async () => {
    let finish!: (value: HostBringBackAnswer) => void;
    client.bringBack.mockImplementation(
      () => new Promise<HostBringBackAnswer>((resolve) => (finish = resolve))
    );
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(bringBackButton());
    });
    // A press while it runs joins nothing new here.
    await act(async () => {
      fireEvent.click(bringBackButton());
    });
    expect(client.bringBack).toHaveBeenCalledTimes(1);
    expect(client.bringBack).toHaveBeenCalledWith("studio-01");
    await act(async () => {
      finish(answer({ status: "not_wakeable", observed: "Operation timed out" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "studio-01 didn't answer over SSH, and no wake is set up for it: Operation timed out"
    );
  });

  it("drops what an attempt said once the link comes up some other way", async () => {
    client.bringBack.mockResolvedValue(answer({ status: "timed_out", elapsedMs: 120_000 }));
    const { rerender } = render(<HostDetail entry={entry()} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(bringBackButton());
    });
    expect(screen.getByRole("alert").textContent).toContain("wasn't back within 120 s");
    rerender(
      <HostDetail
        entry={entry(
          {},
          {
            status: "connected",
            rttMs: 3,
            handshake: {
              version: "1.0.0",
              commit: "abc",
              protocolVersion: 1,
              platform: "darwin",
              arch: "arm64",
            },
          }
        )}
        onBack={() => {}}
      />
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says nothing more once the host is back: its status says so", async () => {
    client.bringBack.mockResolvedValue(answer({ status: "started", startRequested: true }));
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(bringBackButton());
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("isn't offered while the link is up or on its way", () => {
    render(
      <HostDetail entry={entry({}, { status: "connecting", attempt: 1 })} onBack={() => {}} />
    );
    expect(screen.queryByRole("button", { name: "Bring back" })).toBeNull();
  });
});

describe("HostDetail wake setup (#16170)", () => {
  const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
  const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

  it("saves the adapter and LAN together, normalized, only once both read right", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(save().disabled).toBe(true);
    fireEvent.change(field("Hardware address"), { target: { value: "AA-BB-CC-DD-EE-F0" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(field("LAN"), { target: { value: "192.168.1.0/33" } });
    fireEvent.blur(field("LAN"));
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/such as 192.168.1.0\/24/)).toBeTruthy();
    fireEvent.change(field("LAN"), { target: { value: "192.168.1.30/24" } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(client.update).toHaveBeenCalledWith({
      hostId: "studio-01",
      wake: { mac: "aa:bb:cc:dd:ee:f0", lan: "192.168.1.0/24" },
    });
  });

  it("removes a saved wake, and says what the host must allow without changing it", async () => {
    render(
      <HostDetail
        entry={entry({ wake: { mac: "aa:bb:cc:dd:ee:f0", lan: "192.168.1.0/24" } })}
        onBack={() => {}}
      />
    );
    expect(field("Hardware address").value).toBe("aa:bb:cc:dd:ee:f0");
    expect(screen.getByText(/Wake for network access/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove wake" }));
    });
    expect(client.update).toHaveBeenCalledWith({ hostId: "studio-01", wake: null });
  });

  it("follows a wake saved elsewhere into untouched fields, and keeps one being edited", () => {
    const { rerender } = render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.change(field("Hardware address"), { target: { value: "00:11:22:33:44:55" } });
    rerender(
      <HostDetail
        entry={entry({ wake: { mac: "aa:bb:cc:dd:ee:f0", lan: "10.0.0.0/24" } })}
        onBack={() => {}}
      />
    );
    expect(field("Hardware address").value).toBe("00:11:22:33:44:55");
    expect(field("LAN").value).toBe("10.0.0.0/24");
  });

  it("is clean once saved, and stays clean for another spelling of what is saved", async () => {
    const saved = { mac: "aa:bb:cc:dd:ee:f0", lan: "192.168.1.0/24" };
    client.update.mockImplementation(async () => entry({ wake: saved }).descriptor);
    const { rerender } = render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.change(field("Hardware address"), { target: { value: "AA-BB-CC-DD-EE-F0" } });
    fireEvent.change(field("LAN"), { target: { value: "192.168.1.30/24" } });
    await act(async () => {
      fireEvent.click(save());
    });
    rerender(<HostDetail entry={entry({ wake: saved })} onBack={() => {}} />);
    expect(field("Hardware address").value).toBe(saved.mac);
    expect(save().disabled).toBe(true);
    fireEvent.change(field("Hardware address"), { target: { value: "aabb.ccdd.eef0" } });
    expect(save().disabled).toBe(true);
  });

  it("holds the fields while a save is on its way, so its answer never replaces newer typing", async () => {
    let answer!: (value: unknown) => void;
    client.update.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.change(field("Hardware address"), { target: { value: "aa:bb:cc:dd:ee:f0" } });
    fireEvent.change(field("LAN"), { target: { value: "192.168.1.0/24" } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(field("Hardware address").disabled).toBe(true);
    expect(field("LAN").disabled).toBe(true);
    await act(async () => {
      answer(entry({ wake: { mac: "aa:bb:cc:dd:ee:f0", lan: "192.168.1.0/24" } }).descriptor);
    });
    expect(field("Hardware address").disabled).toBe(false);
  });

  it("is only offered for a host reached over SSH", () => {
    render(
      <HostDetail
        entry={entry({ connection: { kind: "wsl", distro: "Ubuntu" }, platform: "linux" })}
        onBack={() => {}}
      />
    );
    expect(screen.queryByText("Wake on LAN")).toBeNull();
  });
});
