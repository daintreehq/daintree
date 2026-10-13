// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { HostProbeResult } from "@shared/types/ipc/remoteHosts";

const client = vi.hoisted(() => ({
  update: vi.fn(async (payload: unknown) => payload),
  probe: vi.fn(),
  connect: vi.fn(async () => undefined),
  connectAndSettle: vi.fn(async () => ({ status: "connecting", attempt: 1 })),
  disconnect: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
  listClipboardGrants: vi.fn(async () => []),
  listPluginViewConsents: vi.fn(async () => []),
  resetClipboardGrants: vi.fn(async () => undefined),
}));

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));

import { HostDetail } from "../HostDetail";

function entry(name = "studio-01"): HostListEntry {
  return {
    descriptor: {
      id: "studio-01",
      name,
      connection: { kind: "ssh", target: "greg@studio" },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
    },
    connection: { status: "disconnected" },
    summary: null,
  };
}

function probe(overrides: Partial<HostProbeResult> = {}): HostProbeResult {
  return {
    connection: { kind: "ssh", target: "greg@newbox" },
    reachable: true,
    sshError: null,
    platform: "linux",
    arch: "x64",
    install: null,
    hostModeListening: false,
    suggestedCommands: [],
    appRunning: false,
    appImages: [],
    canDownload: true,
    matchesClient: null,
    advice: {
      sleepObserved: null,
      sleepDisabled: null,
      keyring: null,
      linger: null,
      hostModeUnit: null,
      startAtLoginInstalled: null,
      fuse: null,
    },
    hostModeState: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockClear();
  client.probe.mockImplementation(async () => probe());
});

afterEach(() => cleanup());

describe("HostDetail SSH target", () => {
  it("is never edited in place, so a blur can't re-point the host", () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(screen.queryByDisplayValue("greg@studio")).toBeNull();
    expect(screen.getByText("greg@studio")).toBeTruthy();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("checks the new target, says what changing it does, and only then changes it", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Change target…" }));
    const field = screen.getByDisplayValue("greg@studio");
    fireEvent.change(field, { target: { value: "greg@newbox" } });
    expect(screen.queryByRole("button", { name: "Change target" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check target" }));
    });
    expect(client.probe).toHaveBeenCalledWith({ kind: "ssh", target: "greg@newbox" });
    const preview = screen.getByTestId("change-host-target-probe").textContent ?? "";
    expect(preview).toContain("What answered at greg@newbox");
    expect(preview).toContain("Linux");
    const dialog = screen.getByTestId("change-host-target-dialog").textContent ?? "";
    expect(dialog).toContain("Windows showing studio-01 return to this machine");
    expect(dialog).toContain("plugin permissions");
    expect(client.update).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change target" }));
    });
    expect(client.update).toHaveBeenCalledWith({
      hostId: "studio-01",
      connection: { kind: "ssh", target: "greg@newbox" },
    });
  });

  it("asks for another check when the target is edited after one", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Change target…" }));
    fireEvent.change(screen.getByDisplayValue("greg@studio"), {
      target: { value: "greg@newbox" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check target" }));
    });
    fireEvent.change(screen.getByDisplayValue("greg@newbox"), {
      target: { value: "greg@otherbox" },
    });
    expect(screen.queryByRole("button", { name: "Change target" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check target" })).toBeTruthy();
  });
});

describe("HostDetail name", () => {
  it("follows a rename made in another window when nothing was typed here", () => {
    const { rerender } = render(<HostDetail entry={entry("studio-01")} onBack={() => {}} />);
    rerender(<HostDetail entry={entry("Studio")} onBack={() => {}} />);
    const field = screen.getByDisplayValue("Studio");
    fireEvent.blur(field);
    expect(client.update).not.toHaveBeenCalled();
  });

  it("never writes an edit begun before another window's rename over it without asking", async () => {
    const { rerender } = render(<HostDetail entry={entry("studio-01")} onBack={() => {}} />);
    fireEvent.change(screen.getByDisplayValue("studio-01"), { target: { value: "Mine" } });
    rerender(<HostDetail entry={entry("Theirs")} onBack={() => {}} />);
    const field = screen.getByDisplayValue("Mine");
    fireEvent.blur(field);
    expect(client.update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Renamed to "Theirs" in another window');

    fireEvent.blur(field);
    await waitFor(() =>
      expect(client.update).toHaveBeenCalledWith({ hostId: "studio-01", name: "Mine" })
    );
  });
});
