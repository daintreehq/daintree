// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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
  AppDialog.Body = ({ children }: SectionProps) => <div>{children}</div>;

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

  it("calls onResolve with 'restore' when Restore is clicked", async () => {
    const { onResolve } = setup();
    fireEvent.click(screen.getByTestId("restore-button"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("restore"));
  });

  it("calls onResolve with 'fresh' when Start Fresh is clicked", async () => {
    const { onResolve } = setup();
    fireEvent.click(screen.getByTestId("fresh-button"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("fresh"));
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

  it("shows backup timestamp when backup exists", () => {
    setup();
    expect(screen.getByText(/Restore session from/)).toBeTruthy();
  });

  it("shows 'no backup' message when hasBackup is false", () => {
    setup({ crash: { hasBackup: false, backupTimestamp: undefined } });
    expect(screen.getByText(/No backup available/)).toBeTruthy();
  });

  it("disables action buttons while resolving", async () => {
    let resolveCallback!: () => void;
    const slowResolve = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCallback = resolve;
        })
    );
    setup({ onResolve: slowResolve });

    fireEvent.click(screen.getByTestId("restore-button"));
    await waitFor(() => {
      const btn = screen.getByTestId("restore-button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
    const freshBtn = screen.getByTestId("fresh-button") as HTMLButtonElement;
    expect(freshBtn.disabled).toBe(true);

    await act(async () => {
      resolveCallback();
    });
  });
});
