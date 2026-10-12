// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostPluginClipboardGrant } from "@shared/types/ipc/remoteHosts";

const client = vi.hoisted(() => ({
  grants: [] as HostPluginClipboardGrant[],
  listClipboardGrants: vi.fn(),
  resetClipboardGrants: vi.fn(),
}));

vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: {
    listClipboardGrants: client.listClipboardGrants,
    resetClipboardGrants: client.resetClipboardGrants,
  },
}));

import { HostClipboardGrants } from "../HostClipboardGrants";

beforeEach(() => {
  client.grants = [];
  client.listClipboardGrants.mockReset().mockImplementation(async () => client.grants);
  client.resetClipboardGrants.mockReset().mockImplementation(async (_h: string, id: string) => {
    client.grants = client.grants.filter((g) => g.pluginId !== id);
  });
});

describe("HostClipboardGrants", () => {
  it("says when no plugin on the host has asked", async () => {
    await act(async () => {
      render(<HostClipboardGrants hostId="studio-01" hostName="studio" />);
    });
    expect(client.listClipboardGrants).toHaveBeenCalledWith("studio-01");
    expect(screen.getByText(/No plugin on studio has asked/)).toBeTruthy();
  });

  it("lists this host's answers and resets one so the plugin asks again", async () => {
    client.grants = [
      { pluginId: "acme.snippets", write: "allow" },
      { pluginId: `project__${"a".repeat(64)}__acme.peek`, read: "deny" },
    ];
    await act(async () => {
      render(<HostClipboardGrants hostId="studio-01" hostName="studio" />);
    });
    expect(screen.getByText("Read not asked · Write allowed")).toBeTruthy();
    expect(screen.getByText("acme.peek")).toBeTruthy();
    expect(screen.getByText("Read denied · Write not asked")).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Reset clipboard access for acme.snippets" })
      );
    });
    expect(client.resetClipboardGrants).toHaveBeenCalledWith("studio-01", "acme.snippets");
    expect(screen.queryByText("acme.snippets")).toBeNull();
  });
});
