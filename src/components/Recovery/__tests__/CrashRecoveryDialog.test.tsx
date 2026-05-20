// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import { CrashRecoveryDialog } from "../CrashRecoveryDialog";
import type { PendingCrash, CrashRecoveryConfig } from "@shared/types/ipc";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (payload: unknown) => notifyMock(payload),
}));

vi.mock("@/components/ui/AppDialog", () => {
  interface MockProps {
    isOpen: boolean;
    children: ReactNode;
    onClose: () => void;
    dismissible?: boolean;
    "data-testid"?: string;
  }
  interface SectionProps {
    children: ReactNode;
    icon?: ReactNode;
    className?: string;
  }

  const AppDialog = ({ isOpen, children, "data-testid": testId }: MockProps) =>
    isOpen ? <div data-testid={testId ?? "app-dialog"}>{children}</div> : null;

  AppDialog.Header = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children, icon }: SectionProps) => (
    <h2>
      {icon}
      {children}
    </h2>
  );
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.Body = ({ children, className }: SectionProps) => (
    <div className={className}>{children}</div>
  );

  return { AppDialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

const CRASH_TIMESTAMP = 1700000000000;

const mockPanels = [
  {
    id: "t1",
    kind: "terminal",
    title: "Shell",
    cwd: "/home",
    location: "grid" as const,
    isSuspect: false,
  },
  {
    id: "t2",
    kind: "terminal",
    title: "Claude",
    cwd: "/project",
    location: "dock" as const,
    isSuspect: true,
    createdAt: CRASH_TIMESTAMP - 10_000,
    agentState: "working",
  },
  { id: "t3", kind: "browser", title: "Docs", location: "grid" as const, isSuspect: false },
];

const mockCrash: PendingCrash = {
  logPath: "/fake/userData/crashes/crash-123.json",
  entry: {
    id: "crash-123",
    timestamp: 1700000000000,
    appVersion: "2.0.0",
    platform: "darwin",
    osVersion: "22.6.0",
    arch: "arm64",
    errorMessage: "Something went wrong",
    errorStack: "Error: Something went wrong\n  at main.ts:42",
    sessionDurationMs: 90000,
    electronVersion: "40.0.0",
    nodeVersion: "22.12.0",
    chromeVersion: "130.0.0",
    v8Version: "13.0.0",
    isPackaged: true,
    totalMemory: 17179869184,
    freeMemory: 4294967296,
    heapUsed: 85983232,
    heapTotal: 134217728,
    rss: 161480704,
    panelCount: 5,
    panelKinds: { terminal: 3, agent: 2 },
    windowCount: 1,
    cpuCount: 10,
    gpuAccelerationDisabled: false,
    processUptime: 4980,
  },
  hasBackup: true,
  backupTimestamp: 1699999900000,
  panels: mockPanels,
};

const mockConfig: CrashRecoveryConfig = { autoRestoreOnCrash: false };

function setup(overrides?: {
  crash?: Partial<PendingCrash>;
  config?: Partial<CrashRecoveryConfig>;
  onResolve?: () => Promise<void>;
  onUpdateConfig?: (patch: Partial<CrashRecoveryConfig>) => Promise<void>;
}) {
  const onResolve = overrides?.onResolve ?? vi.fn(async () => {});
  const onUpdateConfig = overrides?.onUpdateConfig ?? vi.fn(async () => {});

  render(
    <CrashRecoveryDialog
      crash={{ ...mockCrash, ...(overrides?.crash ?? {}) }}
      config={{ ...mockConfig, ...(overrides?.config ?? {}) }}
      onResolve={onResolve}
      onUpdateConfig={onUpdateConfig}
    />
  );

  return { onResolve, onUpdateConfig };
}

beforeEach(() => {
  notifyMock.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      system: {
        openPath: vi.fn(async () => {}),
        openExternal: vi.fn(async () => {}),
      },
    },
  });

  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn(async () => {}),
    },
  });
});

describe("CrashRecoveryDialog", () => {
  it("renders the dialog", () => {
    setup();
    expect(screen.getByTestId("crash-recovery-dialog")).toBeTruthy();
    expect(screen.getByText("Daintree closed unexpectedly")).toBeTruthy();
  });

  describe("with panels (selective restore)", () => {
    it("renders panel list with checkboxes", () => {
      setup();
      expect(screen.getByTestId("panel-list")).toBeTruthy();
      expect(screen.getByTestId("panel-row-t1")).toBeTruthy();
      expect(screen.getByTestId("panel-row-t2")).toBeTruthy();
      expect(screen.getByTestId("panel-row-t3")).toBeTruthy();
    });

    it("shows panel titles", () => {
      setup();
      expect(screen.getByText("Shell")).toBeTruthy();
      expect(screen.getByText("Claude")).toBeTruthy();
      expect(screen.getByText("Docs")).toBeTruthy();
    });

    it("shows suspect badge on suspect panels", () => {
      setup();
      expect(screen.getByTestId("suspect-badge-t2")).toBeTruthy();
      expect(screen.queryByTestId("suspect-badge-t1")).toBeNull();
    });

    it("shows agent state for agent panels and not for non-agent panels", () => {
      setup();
      expect(screen.getByTestId("agent-state-t2")).toBeTruthy();
      expect(screen.getByTestId("agent-state-t2").textContent).toBe("working");
      expect(screen.queryByTestId("agent-state-t1")).toBeNull();
      expect(screen.queryByTestId("agent-state-t3")).toBeNull();
    });

    it("shows suspect warning message", () => {
      setup();
      expect(screen.getByText(/panel was created shortly before the crash/)).toBeTruthy();
    });

    it("all panels are selected by default", () => {
      setup();
      const checkbox1 = screen.getByTestId("panel-checkbox-t1") as HTMLInputElement;
      const checkbox2 = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      expect(checkbox1.checked).toBe(true);
      expect(checkbox2.checked).toBe(true);
    });

    it("deselects suspect panels when crashCount >= 1", () => {
      setup({ crash: { crashCount: 1 } });
      const checkbox1 = screen.getByTestId("panel-checkbox-t1") as HTMLInputElement;
      const checkbox2 = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      const checkbox3 = screen.getByTestId("panel-checkbox-t3") as HTMLInputElement;
      expect(checkbox1.checked).toBe(true);
      expect(checkbox2.checked).toBe(false);
      expect(checkbox3.checked).toBe(true);
    });

    it("deselects suspect panels when crashCount is 2", () => {
      setup({ crash: { crashCount: 2 } });
      const checkbox2 = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      expect(checkbox2.checked).toBe(false);
    });

    it("shows per-row reason text for suspect panels with createdAt", () => {
      setup({ crash: { crashCount: 1 } });
      expect(screen.getByTestId("suspect-reason-t2")).toBeTruthy();
      expect(screen.getByTestId("suspect-reason-t2").textContent).toContain("Created");
    });

    it("does not show reason text for non-suspect panels", () => {
      setup();
      expect(screen.queryByTestId("suspect-reason-t1")).toBeNull();
    });

    it("includes suspect panel IDs in restore after user reselects them", async () => {
      const { onResolve } = setup({ crash: { crashCount: 1 } });
      // Suspect panel t2 should be deselected initially
      const checkbox2 = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      expect(checkbox2.checked).toBe(false);
      // User reselects it
      fireEvent.click(checkbox2);
      expect(checkbox2.checked).toBe(true);
      // Restore
      fireEvent.click(screen.getByTestId("restore-selected-button"));
      await waitFor(() =>
        expect(onResolve).toHaveBeenCalledWith({
          kind: "restore",
          panelIds: expect.arrayContaining(["t1", "t2", "t3"]),
        })
      );
    });

    it("handle all-suspect case: zero selected when crashCount >= 1", () => {
      const allSuspectPanels = [
        {
          id: "s1",
          kind: "terminal" as const,
          title: "A",
          location: "grid" as const,
          isSuspect: true,
          createdAt: CRASH_TIMESTAMP - 5_000,
        },
        {
          id: "s2",
          kind: "terminal" as const,
          title: "B",
          location: "grid" as const,
          isSuspect: true,
          createdAt: CRASH_TIMESTAMP - 10_000,
        },
      ];
      setup({ crash: { crashCount: 1, panels: allSuspectPanels } });
      expect(screen.getByText("0 of 2 selected")).toBeTruthy();
      const btn = screen.getByTestId("restore-selected-button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it("calls onResolve with selected panel IDs when Restore Selected is clicked", async () => {
      const { onResolve } = setup();
      // Deselect t2
      fireEvent.click(screen.getByTestId("panel-checkbox-t2"));
      fireEvent.click(screen.getByTestId("restore-selected-button"));
      await waitFor(() =>
        expect(onResolve).toHaveBeenCalledWith({
          kind: "restore",
          panelIds: expect.arrayContaining(["t1", "t3"]),
        })
      );
      // Verify t2 was excluded
      const call = (onResolve as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.panelIds).not.toContain("t2");
    });

    it("calls onResolve with fresh when 'Continue without restoring' is clicked", async () => {
      const { onResolve } = setup();
      fireEvent.click(screen.getByTestId("fresh-button"));
      await waitFor(() => expect(onResolve).toHaveBeenCalledWith({ kind: "fresh" }));
    });

    it("toggle all deselects when all are selected", () => {
      setup();
      fireEvent.click(screen.getByTestId("toggle-all-button"));
      const checkbox1 = screen.getByTestId("panel-checkbox-t1") as HTMLInputElement;
      expect(checkbox1.checked).toBe(false);
    });

    it("toggle all selects when none are selected", () => {
      setup();
      // Deselect all
      fireEvent.click(screen.getByTestId("toggle-all-button"));
      // Select all
      fireEvent.click(screen.getByTestId("toggle-all-button"));
      const checkbox1 = screen.getByTestId("panel-checkbox-t1") as HTMLInputElement;
      expect(checkbox1.checked).toBe(true);
    });

    it("restore selected button is disabled when no panels selected", () => {
      setup();
      fireEvent.click(screen.getByTestId("toggle-all-button"));
      const btn = screen.getByTestId("restore-selected-button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it("shows selection count", () => {
      setup();
      expect(screen.getByText("3 of 3 selected")).toBeTruthy();
    });

    it("toggle-all button has cursor-pointer", () => {
      setup();
      expect(screen.getByTestId("toggle-all-button").className).toContain("cursor-pointer");
    });
  });

  describe("without panels (legacy fallback)", () => {
    it("shows two-button layout when panels is empty", () => {
      setup({ crash: { panels: [] } });
      expect(screen.getByTestId("restore-button")).toBeTruthy();
      expect(screen.getByTestId("fresh-button")).toBeTruthy();
      expect(screen.queryByTestId("panel-list")).toBeNull();
    });

    it("shows two-button layout when panels is undefined", () => {
      setup({ crash: { panels: undefined } });
      expect(screen.getByTestId("restore-button")).toBeTruthy();
    });

    it("restore and fresh buttons have cursor-pointer", () => {
      setup({ crash: { panels: [] } });
      expect(screen.getByTestId("restore-button").className).toContain("cursor-pointer");
      expect(screen.getByTestId("fresh-button").className).toContain("cursor-pointer");
    });

    it("calls onResolve with restore-all when Restore is clicked in legacy mode", async () => {
      const { onResolve } = setup({ crash: { panels: [] } });
      fireEvent.click(screen.getByTestId("restore-button"));
      await waitFor(() =>
        expect(onResolve).toHaveBeenCalledWith({
          kind: "restore",
          panelIds: [],
        })
      );
    });
  });

  it("details-toggle button has cursor-pointer", () => {
    setup();
    expect(screen.getByTestId("details-toggle").className).toContain("cursor-pointer");
  });

  it("shows error details when toggle is clicked", () => {
    setup();
    expect(screen.queryByTestId("details-section")).toBeNull();
    fireEvent.click(screen.getByTestId("details-toggle"));
    expect(screen.getByTestId("details-section")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
  });

  it("opens log file via system.openPath", () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("open-log-button"));
    expect(window.electron.system.openPath).toHaveBeenCalledWith(mockCrash.logPath);
  });

  it("shows error notification when openPath fails", async () => {
    (window.electron.system.openPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ENOENT")
    );
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("open-log-button"));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Couldn't open log file",
        })
      );
    });
  });

  it("copy stack button appears when errorStack is present", () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    expect(screen.getByTestId("copy-stack-button")).toBeTruthy();
    expect(screen.getByTestId("copy-stack-button").textContent).toContain("Copy stack");
  });

  it("copy stack button not rendered when errorStack is absent", () => {
    setup({ crash: { entry: { ...mockCrash.entry, errorStack: undefined } } });
    fireEvent.click(screen.getByTestId("details-toggle"));
    expect(screen.queryByTestId("copy-stack-button")).toBeNull();
  });

  it("copy stack button not rendered when errorStack is empty string", () => {
    setup({ crash: { entry: { ...mockCrash.entry, errorStack: "" } } });
    fireEvent.click(screen.getByTestId("details-toggle"));
    expect(screen.queryByTestId("copy-stack-button")).toBeNull();
  });

  it("copy stack calls clipboard.writeText with errorStack", async () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("copy-stack-button"));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockCrash.entry.errorStack);
    });
  });

  it("copy stack shows Copied feedback independently from report button", async () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("copy-stack-button"));

    await waitFor(() => {
      expect(screen.getByTestId("copy-stack-button").textContent).toContain("Copied");
    });
    // Report button still shows its default label
    expect(screen.getByTestId("report-button").textContent).toContain("Report this crash");
  });

  it("shows privacy warning on first report click, copies on second click", async () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    expect(screen.getByTestId("privacy-warning")).toBeTruthy();
    expect(screen.getByTestId("privacy-warning").textContent).toContain(
      "Opens GitHub Issues in your browser"
    );
    expect(screen.getByTestId("privacy-warning").textContent).toContain("publicly visible");
    expect(screen.getByTestId("report-button").textContent).toContain("Copy & report on GitHub");

    fireEvent.click(screen.getByTestId("report-button"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(window.electron.system.openExternal).toHaveBeenCalledWith(
      "https://github.com/daintreehq/daintree/issues/new"
    );
  });

  it("first report click does not write to clipboard or open browser", () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(window.electron.system.openExternal).not.toHaveBeenCalled();
  });

  it("does not open the browser when clipboard write fails", async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("denied")
    );
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    fireEvent.click(screen.getByTestId("report-button"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    // Allow the awaited copy promise rejection to settle.
    await Promise.resolve();
    expect(window.electron.system.openExternal).not.toHaveBeenCalled();
  });

  it("calls onUpdateConfig when auto-restore checkbox is changed", async () => {
    const { onUpdateConfig } = setup();
    fireEvent.click(screen.getByTestId("auto-restore-checkbox"));
    await waitFor(() => expect(onUpdateConfig).toHaveBeenCalledWith({ autoRestoreOnCrash: true }));
  });

  describe("crash-loop guard", () => {
    it("shows the auto-restore checkbox when crashCount is undefined", () => {
      setup();
      expect(screen.getByTestId("auto-restore-checkbox")).toBeTruthy();
      expect(screen.queryByTestId("auto-restore-paused")).toBeNull();
    });

    it("shows the auto-restore checkbox when crashCount is 1", () => {
      setup({ crash: { crashCount: 1 } });
      expect(screen.getByTestId("auto-restore-checkbox")).toBeTruthy();
      expect(screen.queryByTestId("auto-restore-paused")).toBeNull();
    });

    it("hides the checkbox at crashCount 2 with auto-restore disabled", () => {
      setup({ crash: { crashCount: 2 }, config: { autoRestoreOnCrash: false } });
      expect(screen.queryByTestId("auto-restore-checkbox")).toBeNull();
      expect(screen.queryByTestId("auto-restore-paused")).toBeNull();
    });

    it("hides the checkbox and shows paused note at crashCount 2 with auto-restore enabled", () => {
      setup({ crash: { crashCount: 2 }, config: { autoRestoreOnCrash: true } });
      expect(screen.queryByTestId("auto-restore-checkbox")).toBeNull();
      const note = screen.getByTestId("auto-restore-paused");
      expect(note.textContent).toContain("Auto-restore paused");
      expect(note.textContent).toContain("too many consecutive crashes");
    });
  });

  it("shows environment metadata in detail section", () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    expect(screen.getByText("40.0.0")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("omits metadata rows when fields are absent (legacy entry)", () => {
    setup({
      crash: {
        entry: {
          id: "old-123",
          timestamp: 1700000000000,
          appVersion: "1.0.0",
          platform: "linux",
          osVersion: "5.15.0",
          arch: "x64",
          errorMessage: "old crash",
        },
      },
    });
    fireEvent.click(screen.getByTestId("details-toggle"));
    expect(screen.queryByText("Electron")).toBeNull();
  });

  it("clipboard includes environment metadata and details section", async () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    fireEvent.click(screen.getByTestId("report-button"));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const clipText = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(clipText).toContain("Electron");
    expect(clipText).toContain("40.0.0");
    expect(clipText).toContain("Node");
    expect(clipText).toContain("22.12.0");
    expect(clipText).toContain("Memory (Free/Total)");
    expect(clipText).toContain("Panels");
    expect(clipText).toContain("<details>");
    expect(clipText).toContain("Stack trace");
    expect(clipText).toContain("Session");
  });

  it("clipboard handles legacy entry without new fields gracefully", async () => {
    setup({
      crash: {
        entry: {
          id: "old-123",
          timestamp: 1700000000000,
          appVersion: "1.0.0",
          platform: "linux",
          osVersion: "5.15.0",
          arch: "x64",
          errorMessage: "old crash",
          errorStack: "Error: old crash\n  at main.ts:1",
        },
      },
    });
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    fireEvent.click(screen.getByTestId("report-button"));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const clipText = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(clipText).toContain("Daintree 1.0.0");
    expect(clipText).toContain("old crash");
    expect(clipText).not.toContain("Electron");
  });

  it("shows 'no backup' message when hasBackup is false in legacy mode", () => {
    setup({ crash: { hasBackup: false, backupTimestamp: undefined, panels: undefined } });
    expect(screen.getByText(/No backup available/)).toBeTruthy();
  });
});
