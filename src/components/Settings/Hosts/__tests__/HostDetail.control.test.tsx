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

const LABEL = "Let the assistant work on this host";

function entry(assistantControlEnabled = false): HostListEntry {
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
      assistantControlEnabled,
    },
    connection: { status: "unreachable", lastSeenAt: null, detail: null },
    summary: null,
  };
}

const controlSwitch = () => screen.getByRole("switch", { name: LABEL });

beforeEach(() => {
  client.update.mockReset();
  client.update.mockImplementation(async (payload: unknown) => payload);
  platform.windows = false;
});

describe("HostDetail assistant control (#13493, #13496)", () => {
  it("is the one assistant switch beside notifications, and saves only its own field", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(screen.getByText("Notify me about this host")).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(controlSwitch().getAttribute("aria-checked")).toBe("false");
    expect(controlSwitch().hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(controlSwitch());
    });
    expect(client.update).toHaveBeenCalledTimes(1);
    expect(client.update).toHaveBeenCalledWith({
      hostId: "studio-01",
      assistantControlEnabled: true,
    });
  });

  it("names the host in the switch's description", () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    const describedBy = controlSwitch().getAttribute("aria-describedby") ?? "";
    const description = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("studio-01");
  });

  it("shows the saved value, and keeps it when saving fails", async () => {
    client.update.mockRejectedValueOnce(new Error("disk full"));
    render(<HostDetail entry={entry(true)} onBack={() => {}} />);
    expect(controlSwitch().getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(controlSwitch());
    });
    expect(controlSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Couldn't save this setting|disk full/)).toBeTruthy();
  });

  it("follows a change made elsewhere", () => {
    const { rerender } = render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(controlSwitch().getAttribute("aria-checked")).toBe("false");
    rerender(<HostDetail entry={entry(true)} onBack={() => {}} />);
    expect(controlSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("isn't offered on Windows", () => {
    platform.windows = true;
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(screen.queryByText(LABEL)).toBeNull();
    expect(screen.getByText("Notify me about this host")).toBeTruthy();
  });
});
