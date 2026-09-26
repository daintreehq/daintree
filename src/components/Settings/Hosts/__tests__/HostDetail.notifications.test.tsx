// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";

const update = vi.hoisted(() => vi.fn(async (payload: unknown) => payload));

vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: {
    update,
    connect: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    listClipboardGrants: vi.fn(async () => []),
    resetClipboardGrants: vi.fn(async () => undefined),
  },
}));

import { HostDetail } from "../HostDetail";

function entry(notificationsEnabled: boolean): HostListEntry {
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
      notificationsEnabled,
    },
    connection: { status: "disconnected" },
    summary: null,
  };
}

beforeEach(() => update.mockClear());

describe("HostDetail notifications toggle", () => {
  it("is off by default and turns cross-host notifications on for this host only", async () => {
    render(<HostDetail entry={entry(false)} onBack={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /Notify me about this host/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(update).toHaveBeenCalledWith({ hostId: "studio-01", notificationsEnabled: true });
  });

  it("turns them back off", async () => {
    render(<HostDetail entry={entry(true)} onBack={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /Notify me about this host/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(update).toHaveBeenCalledWith({ hostId: "studio-01", notificationsEnabled: false });
  });
});
