// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import { CrashRecoveryDialog } from "../CrashRecoveryDialog";
import type { PendingCrash, CrashRecoveryConfig } from "@shared/types/ipc";

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
    kind: "agent",
    title: "Claude",
    cwd: "/project",
    location: "dock" as const,
    isSuspect: true,
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
    expect(screen.getByText("Canopy Crashed")).toBeTruthy();
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
      expect(screen.getByTestId("suspect-warning")).toBeTruthy();
    });

    it("all panels are selected by default", () => {
      setup();
      const checkbox1 = screen.getByTestId("panel-checkbox-t1") as HTMLInputElement;
      const checkbox2 = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      expect(checkbox1.checked).toBe(true);
      expect(checkbox2.checked).toBe(true);
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
      const call = (onResolve as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.panelIds).not.toContain("t2");
    });

    it("calls onResolve with fresh when Start Fresh is clicked", async () => {
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

  it("shows privacy warning on first report click, copies on second click", async () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    expect(screen.getByTestId("privacy-warning")).toBeTruthy();

    fireEvent.click(screen.getByTestId("report-button"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(window.electron.system.openExternal).toHaveBeenCalledWith(
      "https://github.com/canopyide/canopy/issues/new"
    );
  });

  it("calls onUpdateConfig when auto-restore checkbox is changed", async () => {
    const { onUpdateConfig } = setup();
    fireEvent.click(screen.getByTestId("auto-restore-checkbox"));
    await waitFor(() => expect(onUpdateConfig).toHaveBeenCalledWith({ autoRestoreOnCrash: true }));
  });

  it("shows 'no backup' message when hasBackup is false in legacy mode", () => {
    setup({ crash: { hasBackup: false, backupTimestamp: undefined, panels: undefined } });
    expect(screen.getByText(/No backup available/)).toBeTruthy();
  });
});
