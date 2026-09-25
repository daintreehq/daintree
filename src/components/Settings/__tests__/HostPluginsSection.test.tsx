// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { PluginParityRow } from "@shared/types/ipc/pluginParity";
import { HostPluginsSection } from "../Hosts/HostPluginsSection";
import { unavailableSecretStorageText } from "../PluginSettingsForm";
import { PluginParitySummary } from "@/components/Hosts/PluginParitySummary";

function row(patch: Partial<PluginParityRow>): PluginParityRow {
  return {
    pluginId: "acme.md",
    displayName: "Markdown Preview",
    group: "only-here",
    localVersion: "1.0.0",
    hostVersion: null,
    incompatibility: null,
    action: "install-on-host",
    ...patch,
  };
}

const parity = {
  diff: vi.fn(async (): Promise<PluginParityRow[]> => []),
  installOnHost: vi.fn(async () => undefined),
  updateOnHost: vi.fn(async () => undefined),
  claimSwitchNotice: vi.fn(async () => true),
};

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    value: { pluginParity: parity },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const ROWS = [
  row({}),
  row({
    pluginId: "acme.a",
    displayName: "Alpha",
    group: "version-differs",
    localVersion: "1.3.0",
    hostVersion: "1.2.0",
    action: "update-on-host",
  }),
  row({
    pluginId: "acme.graph",
    displayName: "Graph View",
    group: "incompatible",
    action: null,
    incompatibility: { kind: "platform", hostPlatform: "linux", supported: ["darwin"] },
  }),
  row({
    pluginId: "acme.h",
    displayName: "Host only",
    group: "only-on-host",
    localVersion: null,
    hostVersion: "2.0.0",
    action: null,
  }),
  row({
    pluginId: "acme.s",
    displayName: "Same",
    group: "same",
    hostVersion: "1.0.0",
    action: null,
  }),
];

describe("Settings → Hosts → host → Plugins", () => {
  it("asks nothing of a host that isn't connected", () => {
    const { container } = render(
      <HostPluginsSection hostId="studio-01" hostName="studio-01" connected={false} />
    );
    expect(container.textContent).toContain("Connect to this host to compare its plugins");
    expect(parity.diff).not.toHaveBeenCalled();
  });

  it("groups the differences and offers each row's one fix", async () => {
    parity.diff.mockResolvedValue(ROWS);
    const { container, findByRole, queryAllByRole } = render(
      <HostPluginsSection hostId="studio-01" hostName="studio-01" connected />
    );
    await findByRole("button", { name: "Install on studio-01" });
    const text = container.textContent ?? "";
    for (const heading of [
      "Only on this machine",
      "Different versions",
      "Can't run as they are on studio-01",
      "Only on studio-01",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("studio-01 has 1.2.0 · you have 1.3.0");
    expect(text).toContain("Has no build for Linux, so it can't run on studio-01.");
    expect(text).toContain("1 plugin is the same version on both machines");
    expect(queryAllByRole("button", { name: /on studio-01$/ })).toHaveLength(2);

    fireEvent.click(await findByRole("button", { name: "Update on studio-01" }));
    expect(parity.updateOnHost).toHaveBeenCalledWith({ hostId: "studio-01", pluginId: "acme.a" });
    await waitFor(() => expect(parity.diff).toHaveBeenCalledTimes(2));
  });

  it("shows an install failure on its row", async () => {
    parity.diff.mockResolvedValue([row({})]);
    parity.installOnHost.mockRejectedValueOnce(
      new Error("[AppError|HOST_DISCONNECTED] link closed at /Users/alice/.daintree/host.sock")
    );
    const { container, findByRole } = render(
      <HostPluginsSection hostId="studio-01" hostName="studio-01" connected />
    );
    fireEvent.click(await findByRole("button", { name: "Install on studio-01" }));
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Not connected to studio-01. Connect to it and try again."
      )
    );
    expect(container.textContent).not.toContain("/Users/alice");
  });
});

describe("PluginParitySummary", () => {
  it("renders the compact line for the overview card", async () => {
    parity.diff.mockResolvedValue(ROWS);
    const { findByTestId } = render(<PluginParitySummary hostId="studio-01" connected />);
    expect((await findByTestId("plugin-parity-summary")).textContent).toBe(
      "plugins: 1 missing · 1 older · 1 can't run"
    );
  });
});

describe("secret storage on a host with no keyring", () => {
  it("says why and names the host", () => {
    expect(unavailableSecretStorageText({ name: "studio-01", platform: "linux" })).toBe(
      "No keyring on studio-01 (headless Linux) — secrets can't be saved there; use environment variables or the CLI's own login on that host"
    );
  });

  it("keeps this machine's wording for a local window", () => {
    expect(unavailableSecretStorageText(null)).toBe(
      "Secure storage unavailable — secrets can't be saved on this device"
    );
  });
});
