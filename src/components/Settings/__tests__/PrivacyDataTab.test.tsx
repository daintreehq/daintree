// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PrivacyDataTab } from "../PrivacyDataTab";

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../SettingsSubtabBar", () => ({
  SettingsSubtabBar: () => null,
}));

function createPrivacyApi(overrides: Partial<typeof window.electron.privacy> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({
      telemetryLevel: "off" as const,
      logRetentionDays: 30 as const,
      dataFolderPath: "/tmp/canopy",
    }),
    setTelemetryLevel: vi.fn().mockResolvedValue(undefined),
    setLogRetention: vi.fn().mockResolvedValue(undefined),
    openDataFolder: vi.fn(),
    clearCache: vi.fn().mockResolvedValue(undefined),
    resetAllData: vi.fn(),
    ...overrides,
  };
}

describe("PrivacyDataTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electron = {
      privacy: createPrivacyApi(),
    } as unknown as typeof window.electron;
  });

  it("hydrates telemetry level from getSettings", async () => {
    window.electron = {
      privacy: createPrivacyApi({
        getSettings: vi.fn().mockResolvedValue({
          telemetryLevel: "errors",
          logRetentionDays: 90,
          dataFolderPath: "/tmp",
        }),
      }),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      const errorsButton = screen.getByText("Errors Only").closest("button")!;
      expect(errorsButton.className).toContain("border-canopy-accent/40");
    });
  });

  it("reverts telemetry level and shows error toast on IPC failure", async () => {
    window.electron = {
      privacy: createPrivacyApi({
        getSettings: vi.fn().mockResolvedValue({
          telemetryLevel: "off",
          logRetentionDays: 30,
          dataFolderPath: "/tmp",
        }),
        setTelemetryLevel: vi.fn().mockRejectedValue(new Error("IPC fail")),
      }),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Off").closest("button")!.className).toContain(
        "border-canopy-accent/40"
      );
    });

    fireEvent.click(screen.getByText("Errors Only").closest("button")!);

    await waitFor(() => {
      // Should revert back to "Off" being selected
      expect(screen.getByText("Off").closest("button")!.className).toContain(
        "border-canopy-accent/40"
      );
      expect(screen.getByText("Errors Only").closest("button")!.className).not.toContain(
        "border-canopy-accent/40"
      );
    });

    expect(window.electron.privacy.setTelemetryLevel).toHaveBeenCalledWith("errors");
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Failed to save setting" })
    );
  });

  it("reverts to latest successful value (stale closure proof)", async () => {
    const setTelemetry = vi
      .fn()
      .mockResolvedValueOnce(undefined) // first call succeeds
      .mockRejectedValueOnce(new Error("IPC fail")); // second call fails

    window.electron = {
      privacy: createPrivacyApi({
        getSettings: vi.fn().mockResolvedValue({
          telemetryLevel: "off",
          logRetentionDays: 30,
          dataFolderPath: "/tmp",
        }),
        setTelemetryLevel: setTelemetry,
      }),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Off").closest("button")!.className).toContain(
        "border-canopy-accent/40"
      );
    });

    // First change: off → errors (succeeds)
    fireEvent.click(screen.getByText("Errors Only").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("Errors Only").closest("button")!.className).toContain(
        "border-canopy-accent/40"
      );
    });

    // Second change: errors → full (fails)
    fireEvent.click(screen.getByText("Full Usage").closest("button")!);
    await waitFor(() => {
      // Should revert to "errors" (the last successful value), NOT "off"
      expect(screen.getByText("Errors Only").closest("button")!.className).toContain(
        "border-canopy-accent/40"
      );
      expect(screen.getByText("Full Usage").closest("button")!.className).not.toContain(
        "border-canopy-accent/40"
      );
    });
  });

  it("reverts log retention and shows error toast on IPC failure", async () => {
    window.electron = {
      privacy: createPrivacyApi({
        getSettings: vi.fn().mockResolvedValue({
          telemetryLevel: "off",
          logRetentionDays: 30,
          dataFolderPath: "/tmp",
        }),
        setLogRetention: vi.fn().mockRejectedValue(new Error("IPC fail")),
      }),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("30 days").closest("button")!.className).toContain(
        "bg-canopy-accent/10"
      );
    });

    fireEvent.click(screen.getByText("90 days").closest("button")!);

    await waitFor(() => {
      // Should revert back to 30 days
      expect(screen.getByText("30 days").closest("button")!.className).toContain(
        "bg-canopy-accent/10"
      );
      expect(screen.getByText("90 days").closest("button")!.className).not.toContain(
        "bg-canopy-accent/10"
      );
    });

    expect(window.electron.privacy.setLogRetention).toHaveBeenCalledWith(90);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Failed to save setting" })
    );
  });
});
