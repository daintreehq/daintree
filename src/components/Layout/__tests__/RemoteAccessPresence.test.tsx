// @vitest-environment jsdom
import type React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAccessSnapshot } from "@shared/types/remote";
import { actionService } from "@/services/ActionService";
import { RemoteAccessPresence } from "../RemoteAccessPresence";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

const snapshot: RemoteAccessSnapshot = {
  config: { enabled: false, bindAddress: "127.0.0.1", port: 45_123, discoveryEnabled: true },
  status: { state: "disabled" },
  protocolVersion: 1,
  secureStorage: "protected",
  host: null,
  endpoint: null,
  interfaces: [],
  devices: [],
  pendingApprovals: [],
  activeSessions: 0,
  activeDevices: 0,
  activeSubscriptions: 0,
  recentActivity: [],
};

function installSnapshot(next: RemoteAccessSnapshot) {
  window.electron = {
    remoteAccess: { getState: vi.fn().mockResolvedValue(next) },
  } as unknown as typeof window.electron;
}

describe("RemoteAccessPresence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reserves no toolbar space while remote access is disabled", async () => {
    installSnapshot(snapshot);
    const { container } = render(<RemoteAccessPresence />);
    await waitFor(() => expect(window.electron.remoteAccess.getState).toHaveBeenCalledTimes(1));
    expect(container.childElementCount).toBe(0);
  });

  it("uses neutral T1 presence for an observing Portal device", async () => {
    installSnapshot({
      ...snapshot,
      config: { ...snapshot.config, enabled: true },
      status: { state: "listening", bindAddress: "127.0.0.1", port: 45_123 },
      devices: [
        {
          id: "device-1",
          hostId: "host-1",
          displayName: "Phone",
          platform: "ios",
          publicKey: "p".repeat(32),
          capabilities: ["observe-projects"],
          createdAt: 1,
          lastSeenAt: 2,
          revokedAt: null,
          revocationReason: null,
          activeSessions: 1,
          activeSubscriptions: 1,
        },
      ],
      activeSessions: 1,
      activeDevices: 1,
      activeSubscriptions: 1,
    });
    render(<RemoteAccessPresence />);

    const button = await screen.findByRole("button", {
      name: "Phone observing an agent. Manage remote access",
    });
    expect(button.querySelector(".bg-text-secondary")).toBeTruthy();
    button.click();
    expect(actionService.dispatch).toHaveBeenCalledWith("app.remoteAccess.manage", undefined, {
      source: "user",
    });
  });

  it("routes gateway failure recovery to the management tab without a toast", async () => {
    installSnapshot({
      ...snapshot,
      config: { ...snapshot.config, enabled: true },
      status: { state: "error", message: "Interface unavailable" },
    });
    render(<RemoteAccessPresence />);

    expect(
      await screen.findByRole("button", {
        name: "Remote access needs attention — open settings to retry. Manage remote access",
      })
    ).toBeTruthy();
    expect(screen.getByText("Remote access needs attention — open settings to retry")).toBeTruthy();
  });
});
