// @vitest-environment jsdom

import { render, cleanup, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));

vi.mock("../SettingsSection", async () => {
  const { joinBadges, useSettingsOwnerMarker } = await import("@/hooks/useSettingsOwner");
  return {
    SettingsSection: ({
      children,
      title,
      badge,
      settings,
    }: {
      children: React.ReactNode;
      title: string;
      badge?: string;
      settings?: readonly import("@/hooks/useSettingsOwner").SettingRef[];
    }) => {
      const ownerMarker = useSettingsOwnerMarker();
      return (
        <section
          data-section={title}
          data-badge={joinBadges(badge, settings ? ownerMarker(...settings) : undefined) ?? ""}
        >
          {children}
        </section>
      );
    },
  };
});

vi.mock("@/clients", () => ({
  appClient: { getState: vi.fn(() => Promise.resolve({})) },
  systemClient: { healthCheck: vi.fn(() => new Promise(() => {})) },
  logsClient: { getLevelOverrides: vi.fn(() => Promise.resolve({})) },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(() => Promise.resolve({ ok: true, result: { verbose: false } })),
  },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";

beforeEach(() => {
  _resetHostPlatformForTests();
  Object.assign(window, {
    electron: {
      gpu: {
        getStatus: vi.fn(() =>
          Promise.resolve({ hardwareAccelerationDisabled: false, angleFallbackActive: false })
        ),
        setHardwareAcceleration: vi.fn(() => Promise.resolve()),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  delete window.__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

async function sectionBadges(): Promise<Record<string, string>> {
  const { TroubleshootingTab } = await import("../TroubleshootingTab");
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<TroubleshootingTab />));
  });
  return Object.fromEntries(
    [...container.querySelectorAll("section[data-section]")].map((el) => [
      el.getAttribute("data-section"),
      el.getAttribute("data-badge"),
    ])
  );
}

describe("Troubleshooting in a window attached to another host", () => {
  beforeEach(() => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
  });

  it("names no owner on System, which holds this machine's GPU switch and the host's health check", async () => {
    const badges = await sectionBadges();
    expect(badges).toHaveProperty("System", "");
  });
});
