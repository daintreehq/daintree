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

  it("claims nothing about the list while it loads", async () => {
    client.listPluginViewConsents.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      render(<HostPluginViewConsents hostId="studio-01" hostName="studio" />);
    });
    expect(screen.queryByText(/has asked to run its view here/)).toBeNull();
  });

  it("says a failed load failed, never that nothing has asked, and reads again on Retry", async () => {
    client.listPluginViewConsents.mockRejectedValueOnce(new Error("link down"));
    await act(async () => {
      render(<HostPluginViewConsents hostId="studio-01" hostName="studio" />);
    });
    expect(screen.getByText("Couldn't load plugin views")).toBeTruthy();
    expect(screen.queryByText(/has asked to run its view here/)).toBeNull();

    client.plugins = [{ pluginId: "acme.graph", state: "allowed" }];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByText("Couldn't load plugin views")).toBeNull();
    expect(screen.getByText("acme.graph")).toBeTruthy();
  });

  it("keeps a failed reset on its own row, and its Retry resets again", async () => {
    client.plugins = [{ pluginId: "acme.graph", state: "allowed" }];
    client.resetPluginViewConsent.mockRejectedValueOnce(new Error("host gone"));
    await act(async () => {
      render(<HostPluginViewConsents hostId="studio-01" hostName="studio" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset the plugin view for acme.graph" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't reset the plugin view for acme.graph"
    );
    expect(screen.queryByText("Couldn't load plugin views")).toBeNull();
    expect(client.listPluginViewConsents).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Retry resetting the plugin view for acme.graph" })
      );
    });
    expect(client.resetPluginViewConsent).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("acme.graph")).toBeNull();
  });

  it("starts one reset however often it is pressed while it runs", async () => {
    client.plugins = [{ pluginId: "acme.graph", state: "allowed" }];
    let finish: () => void = () => {};
    client.resetPluginViewConsent.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    await act(async () => {
      render(<HostPluginViewConsents hostId="studio-01" hostName="studio" />);
    });
    const button = screen.getByRole("button", { name: "Reset the plugin view for acme.graph" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(client.resetPluginViewConsent).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});
