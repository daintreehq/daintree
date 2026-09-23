// @vitest-environment jsdom
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PrivacyDataTab } from "../PrivacyDataTab";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ANALYTICS_EVENTS } from "@shared/config/telemetry";

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div role="group" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </div>
  ),
}));

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

vi.mock("../SettingsSubtabBar", () => ({
  SettingsSubtabBar: () => null,
  subtabPanelProps: (group: string, activeId: string) => ({
    role: "tabpanel",
    id: `settings-subtabpanel-${group}-${activeId}`,
    "aria-labelledby": `settings-subtab-${group}-${activeId}`,
    tabIndex: -1,
  }),
}));

function createPrivacyApi(overrides: Partial<typeof window.electron.privacy> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({
      telemetryLevel: "off" as const,
      logRetentionDays: 30 as const,
      dataFolderPath: "/tmp/daintree",
    }),
    setTelemetryLevel: vi.fn().mockResolvedValue(undefined),
    setLogRetention: vi.fn().mockResolvedValue(undefined),
    openDataFolder: vi.fn(),
    clearCache: vi.fn().mockResolvedValue({ cleared: 5, failed: 0 }),
    resetAllData: vi.fn(),
    ...overrides,
  };
}

function createAgentSessionHistoryApi(
  overrides: Partial<typeof window.electron.agentSessionHistory> = {}
) {
  return {
    list: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    getRetentionDays: vi.fn().mockResolvedValue(30),
    setRetentionDays: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("PrivacyDataTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electron = {
      privacy: createPrivacyApi(),
      agentSessionHistory: createAgentSessionHistoryApi(),
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
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    await waitFor(() => {
      expect(radio("Errors only").checked).toBe(true);
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
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    await waitFor(() => {
      expect(radio("Off").checked).toBe(true);
    });

    fireEvent.click(radio("Errors only"));

    await waitFor(() => {
      // Should revert back to "Off" being selected
      expect(radio("Off").checked).toBe(true);
      expect(radio("Errors only").checked).toBe(false);
    });

    expect(window.electron.privacy.setTelemetryLevel).toHaveBeenCalledWith("errors");
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't save setting" })
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
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    await waitFor(() => {
      expect(radio("Off").checked).toBe(true);
    });

    // First change: off → errors (succeeds)
    fireEvent.click(radio("Errors only"));
    await waitFor(() => {
      expect(radio("Errors only").checked).toBe(true);
    });

    // Second change: errors → full (fails)
    fireEvent.click(radio("Full usage"));
    await waitFor(() => {
      // Should revert to "errors" (the last successful value), NOT "off"
      expect(radio("Errors only").checked).toBe(true);
      expect(radio("Full usage").checked).toBe(false);
    });
  });

  it("renders telemetry disclosure listing all allowlisted analytics events", async () => {
    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const disclosure = await waitFor(() =>
      screen.getByRole("group", { name: /What's collected at each level/i })
    );

    for (const name of ANALYTICS_EVENTS) {
      expect(within(disclosure).getByText(name)).toBeTruthy();
    }
  });

  it("does not claim telemetry is sampled in the disclosure", async () => {
    // Sentry deliberately runs without `sampleRate` (#5259), so every captured
    // error is eligible for transmission. Consent copy must not suggest otherwise.
    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const disclosure = await waitFor(() =>
      screen.getByRole("group", { name: /What's collected at each level/i })
    );

    // Scoped to the per-level summaries: field lists may legitimately carry
    // percentages (CPU, memory) that aren't sampling claims.
    const summaries = Array.from(disclosure.querySelectorAll("dd > p"), (p) => p.textContent ?? "");
    expect(summaries).toHaveLength(3);
    for (const summary of summaries) {
      expect(summary).not.toMatch(/sampl/i);
      expect(summary).not.toMatch(/\d+\s*%/);
    }
  });

  it("does not render telemetry disclosure on the storage subtab", async () => {
    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    await waitFor(() => {
      // Two retention pickers now live on this subtab (log retention + session
      // history), so the "30 days" label is intentionally non-unique.
      expect(screen.getAllByText("30 days").length).toBeGreaterThan(0);
    });

    expect(screen.queryByText(/What's collected at each level/i)).toBeNull();
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
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const logRetentionOption = (label: string) =>
      within(screen.getByRole("radiogroup", { name: "Log retention" })).getByRole("radio", {
        name: label,
      });

    await waitFor(() => {
      expect(logRetentionOption("30 days").getAttribute("aria-checked")).toBe("true");
    });

    fireEvent.click(logRetentionOption("90 days"));

    await waitFor(() => {
      // Should revert back to 30 days
      expect(logRetentionOption("30 days").getAttribute("aria-checked")).toBe("true");
      expect(logRetentionOption("90 days").getAttribute("aria-checked")).toBe("false");
    });

    expect(window.electron.privacy.setLogRetention).toHaveBeenCalledWith(90);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't save setting" })
    );
  });

  it("disables session retention with an inline error and Retry when it fails to load", async () => {
    const getRetentionDays = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC fail"))
      .mockResolvedValueOnce(90);
    Reflect.set(window, "electron", {
      privacy: createPrivacyApi(),
      agentSessionHistory: createAgentSessionHistoryApi({ getRetentionDays }),
    });

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const sessionOption = (label: string) =>
      within(screen.getByRole("radiogroup", { name: "Keep session history for" })).getByRole(
        "radio",
        { name: label }
      ) as HTMLButtonElement;

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Session history retention didn't load")).toBeTruthy();
    // The 30-day fallback is not presented as the user's value, nor as editable.
    expect(sessionOption("30 days").getAttribute("aria-checked")).toBe("false");
    expect(sessionOption("30 days").disabled).toBe(true);

    fireEvent.click(retry);

    await waitFor(() => {
      expect(sessionOption("90 days").getAttribute("aria-checked")).toBe("true");
    });
    expect(sessionOption("90 days").disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(getRetentionDays).toHaveBeenCalledTimes(2);
  });

  it("disables telemetry and log retention with an inline Retry when privacy settings fail to load", async () => {
    const getSettings = vi.fn().mockRejectedValueOnce(new Error("IPC fail")).mockResolvedValueOnce({
      telemetryLevel: "errors",
      logRetentionDays: 7,
      dataFolderPath: "/tmp",
    });
    Reflect.set(window, "electron", {
      privacy: createPrivacyApi({ getSettings }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    });

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(radio("Off").disabled).toBe(true);
    expect(radio("Off").checked).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();

    fireEvent.click(retry);

    await waitFor(() => {
      expect(radio("Errors only").checked).toBe(true);
    });
    expect(radio("Errors only").disabled).toBe(false);
  });

  describe("clear cache", () => {
    const clearCacheButton = () =>
      screen.getByRole("button", {
        name: /^Clear cache$|^Clearing|^Cache cleared$/,
      }) as HTMLButtonElement;

    type ClearCache = typeof window.electron.privacy.clearCache;

    function renderWithClearCache(clearCache: ClearCache) {
      window.electron.privacy.clearCache = clearCache;
      render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
        wrapper: TooltipProvider,
      });
    }

    it("shows the cleared label only when every cache cleared", async () => {
      const clearCache = vi.fn<ClearCache>().mockResolvedValue({ cleared: 5, failed: 0 });
      renderWithClearCache(clearCache);

      fireEvent.click(clearCacheButton());

      await waitFor(() => {
        expect(screen.queryByText("Cache cleared")).not.toBeNull();
      });
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("reports a partial failure instead of claiming success", async () => {
      const clearCache = vi.fn<ClearCache>().mockResolvedValue({ cleared: 4, failed: 1 });
      renderWithClearCache(clearCache);

      fireEvent.click(clearCacheButton());

      await waitFor(() => {
        expect(mockNotify).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            priority: "high",
            title: "Couldn't clear all caches",
            context: { eventKind: "uiFeedback" },
          })
        );
      });
      expect(screen.queryByText("Cache cleared")).toBeNull();
      expect(clearCacheButton().disabled).toBe(false);
    });

    it("reports a rejected clear and retries from the toast action", async () => {
      const retryLabels: string[] = [];
      let retry: (() => void) | undefined;
      mockNotify.mockImplementationOnce(
        (payload: { actions?: Array<{ label: string; onClick: () => void }> }) => {
          retryLabels.push(...(payload.actions ?? []).map((action) => action.label));
          retry = payload.actions?.[0]?.onClick;
        }
      );
      const clearCache = vi
        .fn<ClearCache>()
        .mockRejectedValueOnce(new Error("IPC fail"))
        .mockResolvedValueOnce({ cleared: 5, failed: 0 });
      renderWithClearCache(clearCache);

      fireEvent.click(clearCacheButton());

      await waitFor(() => {
        expect(mockNotify).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            priority: "high",
            title: "Couldn't clear cache",
          })
        );
      });
      expect(screen.queryByText("Cache cleared")).toBeNull();

      expect(retryLabels).toEqual(["Try again"]);
      act(() => {
        retry?.();
      });

      await waitFor(() => {
        expect(screen.queryByText("Cache cleared")).not.toBeNull();
      });
      expect(clearCache).toHaveBeenCalledTimes(2);
    });
  });
});
