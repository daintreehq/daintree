// @vitest-environment jsdom
import type React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAccessSnapshot } from "@shared/types/remote";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";
import { RemoteAccessSettingsTab } from "../RemoteAccessSettingsTab";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,pairing") },
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    children,
    confirmLabel,
    onConfirm,
    onClose,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    children?: React.ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
    onClose?: () => void;
  }) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        {children}
        <button onClick={() => void onConfirm()}>Confirm {confirmLabel}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    ) : null,
}));

const baseSnapshot: RemoteAccessSnapshot = {
  config: {
    enabled: false,
    bindAddress: "127.0.0.1",
    port: 45_123,
    discoveryEnabled: true,
    displayName: "Studio host",
  },
  status: { state: "disabled" },
  protocolVersion: 1,
  secureStorage: "protected",
  host: null,
  endpoint: null,
  interfaces: [{ address: "127.0.0.1", name: "This device only", family: "IPv4", internal: true }],
  devices: [],
  pendingApprovals: [],
  activeSessions: 0,
  activeDevices: 0,
  activeSubscriptions: 0,
  recentActivity: [],
};

function installApi(snapshot: RemoteAccessSnapshot = baseSnapshot) {
  const api = {
    getState: vi.fn().mockResolvedValue(snapshot),
    updateConfig: vi.fn().mockImplementation(async (patch) => ({
      ...snapshot,
      config: { ...snapshot.config, ...patch },
      status: patch.enabled
        ? { state: "listening" as const, bindAddress: snapshot.config.bindAddress, port: 45_123 }
        : snapshot.status,
    })),
    openPairingWindow: vi.fn().mockResolvedValue({
      bootstrap: {
        pairingId: "pair-1",
        oneTimeSecret: "s".repeat(43),
        expiresAt: Date.now() + 60_000,
        host: {
          hostId: "host-1",
          publicKey: "p".repeat(32),
          fingerprint: `sha256:${"a".repeat(43)}`,
          createdAt: 1,
        },
        tlsCertificateFingerprint: `sha256:${"b".repeat(43)}`,
        endpointHints: ["wss://127.0.0.1:45123"],
        protocol: { min: 1, max: 1 },
        verificationCode: "123456",
      },
      encodedPayload: "pairing-payload",
    }),
    approvePairing: vi.fn().mockResolvedValue(snapshot),
    rejectPairing: vi.fn().mockResolvedValue(snapshot),
    setDeviceCapabilities: vi.fn().mockResolvedValue(snapshot),
    renameDevice: vi.fn().mockResolvedValue(snapshot),
    disconnectDevice: vi.fn().mockResolvedValue(snapshot),
    disconnectAllDevices: vi.fn().mockResolvedValue(snapshot),
    revokeDevice: vi.fn().mockResolvedValue(snapshot),
  };
  window.electron = { remoteAccess: api } as unknown as typeof window.electron;
  return api;
}

function renderTab() {
  return render(
    <SettingsValidationProvider>
      <RemoteAccessSettingsTab />
    </SettingsValidationProvider>
  );
}

describe("RemoteAccessSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders safe chrome immediately and blocks enablement without protected storage", async () => {
    installApi({ ...baseSnapshot, secureStorage: "unavailable" });
    renderTab();

    expect(screen.getByText("Remote access")).toBeTruthy();
    await screen.findByText("Protected storage unavailable");
    expect(
      screen.getByRole("switch", { name: "Enable Remote access" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("enables the gateway explicitly through the typed management API", async () => {
    const api = installApi();
    renderTab();

    const toggle = await screen.findByRole("switch", { name: "Enable Remote access" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith({ enabled: true }));
  });

  it("selects an available private interface before enabling remote access", async () => {
    const snapshot: RemoteAccessSnapshot = {
      ...baseSnapshot,
      interfaces: [
        ...baseSnapshot.interfaces,
        { address: "192.168.1.20", name: "Wi-Fi", family: "IPv4", internal: false },
      ],
    };
    const api = installApi(snapshot);
    renderTab();

    const interfaceSelect = await screen.findByRole("combobox", { name: "Network interface" });
    await waitFor(() => expect((interfaceSelect as HTMLSelectElement).value).toBe("192.168.1.20"));
    fireEvent.click(screen.getByRole("switch", { name: "Enable Remote access" }));

    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        enabled: true,
        bindAddress: "192.168.1.20",
        discoveryEnabled: true,
        displayName: "Studio host",
      })
    );
  });

  it("edits grants and revokes a paired device only after confirmation", async () => {
    const deviceSnapshot: RemoteAccessSnapshot = {
      ...baseSnapshot,
      devices: [
        {
          id: "device-1",
          hostId: "host-1",
          displayName: "Justin's phone",
          platform: "ios",
          publicKey: "p".repeat(32),
          capabilities: ["observe-projects", "prompt-agents"],
          createdAt: 1,
          lastSeenAt: Date.now(),
          revokedAt: null,
          revocationReason: null,
          activeSessions: 1,
          activeSubscriptions: 1,
        },
      ],
      activeSessions: 1,
      activeDevices: 1,
      activeSubscriptions: 1,
    };
    const api = installApi(deviceSnapshot);
    renderTab();

    const promptGrant = await screen.findByRole("checkbox", { name: "Send prompts" });
    fireEvent.click(promptGrant);
    await waitFor(() =>
      expect(api.setDeviceCapabilities).toHaveBeenCalledWith({
        deviceId: "device-1",
        capabilities: ["observe-projects"],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Revoke device" }));
    expect(await screen.findByText("Revoke 'Justin's phone'?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Revoke device" }));
    await waitFor(() =>
      expect(api.revokeDevice).toHaveBeenCalledWith({
        deviceId: "device-1",
        reason: "Revoked by the desktop user",
      })
    );
  });

  it("keeps an offline trusted device visible as paired", async () => {
    installApi({
      ...baseSnapshot,
      devices: [
        {
          id: "device-1",
          hostId: "host-1",
          displayName: "My Portal device",
          platform: "android",
          publicKey: "p".repeat(32),
          capabilities: ["observe-projects"],
          createdAt: 1,
          lastSeenAt: Date.now(),
          revokedAt: null,
          revocationReason: null,
          activeSessions: 0,
          activeSubscriptions: 0,
        },
      ],
    });
    renderTab();

    expect(await screen.findByText("My Portal device")).toBeTruthy();
    expect(screen.getByText("Paired")).toBeTruthy();
    expect(screen.queryByText("Pair your first Portal device")).toBeNull();
  });

  it("renames a paired device without changing its grants", async () => {
    const deviceSnapshot: RemoteAccessSnapshot = {
      ...baseSnapshot,
      devices: [
        {
          id: "device-1",
          hostId: "host-1",
          displayName: "My Portal device",
          platform: "android",
          publicKey: "p".repeat(32),
          capabilities: ["observe-projects", "prompt-agents"],
          createdAt: 1,
          lastSeenAt: Date.now(),
          revokedAt: null,
          revocationReason: null,
          activeSessions: 0,
          activeSubscriptions: 0,
        },
      ],
    };
    const api = installApi(deviceSnapshot);
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Device name" });
    fireEvent.change(input, { target: { value: "Travel phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(api.renameDevice).toHaveBeenCalledWith({
        deviceId: "device-1",
        displayName: "Travel phone",
      })
    );
  });

  it("keeps device rename editable when the host rejects the update", async () => {
    const deviceSnapshot: RemoteAccessSnapshot = {
      ...baseSnapshot,
      devices: [
        {
          id: "device-1",
          hostId: "host-1",
          displayName: "My Portal device",
          platform: "android",
          publicKey: "p".repeat(32),
          capabilities: ["observe-projects"],
          createdAt: 1,
          lastSeenAt: Date.now(),
          revokedAt: null,
          revocationReason: null,
          activeSessions: 0,
          activeSubscriptions: 0,
        },
      ],
    };
    const api = installApi(deviceSnapshot);
    api.renameDevice.mockRejectedValueOnce(new Error("Rename unavailable"));
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Device name" }), {
      target: { value: "Travel phone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByText("Rename unavailable")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Device name" }) as HTMLInputElement).value).toBe(
      "Travel phone"
    );
  });

  it("keeps activity history collapsed until requested", async () => {
    installApi({
      ...baseSnapshot,
      recentActivity: [
        {
          id: "event-new",
          actorDeviceId: null,
          sessionId: null,
          operation: "connection.end",
          result: "ended",
          targetProjectId: null,
          targetWorktreeId: null,
          targetPanelId: null,
          characterCount: null,
          byteCount: null,
          occurredAt: Date.now(),
        },
        {
          id: "event-old",
          actorDeviceId: null,
          sessionId: null,
          operation: "pairing.result",
          result: "accepted",
          targetProjectId: null,
          targetWorktreeId: null,
          targetPanelId: null,
          characterCount: null,
          byteCount: null,
          occurredAt: Date.now() - 60_000,
        },
      ],
    });
    renderTab();

    expect(await screen.findByText("connection end · ended")).toBeTruthy();
    expect(screen.queryByText("pairing result · accepted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show history (2)" }));
    expect(screen.getByText("pairing result · accepted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide history" }));
    expect(screen.queryByText("pairing result · accepted")).toBeNull();
  });

  it("opens a time-limited QR pairing window only through the enabled gateway", async () => {
    const listening: RemoteAccessSnapshot = {
      ...baseSnapshot,
      config: { ...baseSnapshot.config, enabled: true, bindAddress: "192.168.1.20" },
      status: { state: "listening" as const, bindAddress: "192.168.1.20", port: 45_123 },
      endpoint: "wss://192.168.1.20:45123",
      interfaces: [
        ...baseSnapshot.interfaces,
        { address: "192.168.1.20", name: "Wi-Fi", family: "IPv4", internal: false },
      ],
    };
    const api = installApi(listening);
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
    await waitFor(() => expect(api.openPairingWindow).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("123456")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy pairing data" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("pairing-payload")
    );
  });
});
