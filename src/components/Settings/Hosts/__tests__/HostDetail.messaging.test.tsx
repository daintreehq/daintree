// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";

const client = vi.hoisted(() => ({
  update: vi.fn(async (payload: unknown) => payload),
  listClipboardGrants: vi.fn(async () => []),
  listPluginViewConsents: vi.fn(async () => []),
  resetClipboardGrants: vi.fn(async () => undefined),
}));
const platform = vi.hoisted(() => ({ windows: false }));

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({ HostCopySettingsSection: () => null }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isWindows: () => platform.windows,
}));

import { HostDetail } from "../HostDetail";

const LABEL = "Allow assistant messaging with this host";

function entry(assistantMessagingEnabled = false): HostListEntry {
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
      assistantMessagingEnabled,
    },
    connection: { status: "unreachable", lastSeenAt: null, detail: null },
    summary: null,
  };
}

function messagingSwitch(): HTMLElement {
  const label = screen.getByText(LABEL);
  return screen.getByRole("switch", { name: label.textContent ?? LABEL });
}

beforeEach(() => {
  client.update.mockReset();
  client.update.mockImplementation(async (payload: unknown) => payload);
  platform.windows = false;
});

describe("HostDetail assistant messaging opt-in", () => {
  it("sits beside the notifications switch and saves only its own field", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(screen.getByText("Notify me about this host")).toBeTruthy();
    const toggle = messagingSwitch();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(client.update).toHaveBeenCalledWith({
      hostId: "studio-01",
      assistantMessagingEnabled: true,
    });
  });

  it("shows the saved opt-in, and says when saving fails", async () => {
    client.update.mockRejectedValueOnce(new Error("disk full"));
    render(<HostDetail entry={entry(true)} onBack={() => {}} />);
    const toggle = messagingSwitch();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(messagingSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Couldn't save this setting|disk full/)).toBeTruthy();
  });

  it("isn't offered on Windows", () => {
    platform.windows = true;
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(screen.queryByText(LABEL)).toBeNull();
    expect(screen.getByText("Notify me about this host")).toBeTruthy();
  });
});
