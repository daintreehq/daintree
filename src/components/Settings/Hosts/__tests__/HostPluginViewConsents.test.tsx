// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  plugins: [] as Array<{ pluginId: string; state: "allowed" | "refused" }>,
  listPluginViewConsents: vi.fn(),
  resetPluginViewConsent: vi.fn(),
}));

vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: {
    listPluginViewConsents: client.listPluginViewConsents,
    resetPluginViewConsent: client.resetPluginViewConsent,
  },
}));

import { HostPluginViewConsents } from "../HostPluginViewConsents";

beforeEach(() => {
  client.plugins = [];
  client.listPluginViewConsents.mockReset().mockImplementation(async () => client.plugins);
  client.resetPluginViewConsent.mockReset().mockImplementation(async (_h: string, id: string) => {
    client.plugins = client.plugins.filter((p) => p.pluginId !== id);
  });
});

describe("HostPluginViewConsents", () => {
  it("says when no plugin from the host runs its view here", async () => {
    await act(async () => {
      render(<HostPluginViewConsents hostId="studio-01" hostName="studio" />);
    });
    expect(client.listPluginViewConsents).toHaveBeenCalledWith("studio-01");
    expect(screen.getByText("No plugin from studio has asked to run its view here")).toBeTruthy();
  });

  it("lists allowed and refused plugins and resets one so it asks again", async () => {
    client.plugins = [
      { pluginId: "acme.graph", state: "allowed" },
      { pluginId: `project__${"a".repeat(64)}__acme.peek`, state: "refused" },
    ];
    await act(async () => {
      render(<HostPluginViewConsents hostId="studio-01" hostName="studio" />);
    });
    expect(screen.getByText("acme.graph")).toBeTruthy();
    expect(screen.getByText("acme.peek")).toBeTruthy();
    expect(screen.getByText("Blocked until Daintree restarts here")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset the plugin view for acme.graph" }));
    });
    expect(client.resetPluginViewConsent).toHaveBeenCalledWith("studio-01", "acme.graph");
    expect(screen.queryByText("acme.graph")).toBeNull();
  });
});
