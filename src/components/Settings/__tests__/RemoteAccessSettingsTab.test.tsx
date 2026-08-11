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

  it("opens a time-limited QR pairing window only through the enabled gateway", async () => {
    const listening = {
      ...baseSnapshot,
      config: { ...baseSnapshot.config, enabled: true },
      status: { state: "listening" as const, bindAddress: "127.0.0.1", port: 45_123 },
      endpoint: "wss://127.0.0.1:45123",
    };
    const api = installApi(listening);
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
    await waitFor(() => expect(api.openPairingWindow).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("123456")).toBeTruthy();
  });
});
