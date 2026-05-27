// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
  AppDialog.Description = ({ children }: SectionProps) => <p>{children}</p>;
  AppDialog.Footer = ({
    secondaryAction,
    primaryAction,
  }: {
    secondaryAction?: { label: string; onClick: () => void; disabled?: boolean };
    primaryAction?: { label: string; onClick: () => void; loading?: boolean; disabled?: boolean };
  }) => (
    <div>
      {secondaryAction && (
        <button
          type="button"
          data-confirm-role="cancel"
          onClick={secondaryAction.onClick}
          disabled={secondaryAction.disabled}
        >
          {secondaryAction.label}
        </button>
      )}
      {primaryAction && (
        <button
          type="button"
          data-confirm-role="confirm"
          onClick={primaryAction.onClick}
          disabled={primaryAction.disabled}
        >
          {primaryAction.label}
        </button>
      )}
    </div>
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

vi.mock("@/components/Terminal/InlineStatusBanner", () => ({
  InlineStatusBanner: ({
    title,
    description,
    severity,
  }: {
    title: ReactNode;
    description?: ReactNode;
    severity?: string;
  }) => (
    <div data-testid="inline-status-banner" data-severity={severity ?? "error"}>
      <span data-testid="inline-status-banner-title">{title}</span>
      {description ? (
        <span data-testid="inline-status-banner-description">{description}</span>
      ) : null}
    </div>
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
    kind: "terminal",
    title: "Claude",
    cwd: "/project",
    location: "dock" as const,
    isSuspect: true,
    suspectReason: "crash-window" as const,
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

    it("shows per-panel reason text in the suspect badge title", () => {
      setup();
      expect(screen.getByTestId("suspect-badge-t2").getAttribute("title")).toBe(
        "Created within 30 seconds of the crash"
      );
    });

    it("renders an icon-only suspect badge with no title when suspectReason is absent", () => {
      setup({
        crash: {
          panels: [
            { id: "t1", kind: "terminal", title: "Shell", location: "grid", isSuspect: true },
          ],
        },
      });
      const badge = screen.getByTestId("suspect-badge-t1");
      expect(badge).toBeTruthy();
      expect(badge.getAttribute("title")).toBeNull();
    });

    it("renders an icon-only badge with no title for an unknown suspectReason", () => {
      setup({
        crash: {
          panels: [
            {
              id: "t1",
              kind: "terminal",
              title: "Shell",
              location: "grid",
              isSuspect: true,
              suspectReason: "some-future-reason" as never,
            },
          ],
        },
      });
      const badge = screen.getByTestId("suspect-badge-t1");
      expect(badge).toBeTruthy();
      expect(badge.getAttribute("title")).toBeNull();
    });

    it("renders no suspect badge when suspectReason is set but isSuspect is false", () => {
      setup({
        crash: {
          panels: [
            {
              id: "t1",
              kind: "terminal",
              title: "Shell",
              location: "grid",
              isSuspect: false,
              suspectReason: "crash-window" as const,
            },
          ],
        },
      });
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

    it("renders the suspect warning as a warning-severity InlineStatusBanner", () => {
      setup();
      const banner = within(screen.getByTestId("suspect-warning")).getByTestId(
        "inline-status-banner"
      );
      expect(banner.getAttribute("data-severity")).toBe("warning");
    });

    it("suspect banner title uses the 'created shortly before the crash' phrasing when crashCount is undefined", () => {
      setup();
      const title = within(screen.getByTestId("suspect-warning")).getByTestId(
        "inline-status-banner-title"
      );
      expect(title.textContent).toContain("1 panel created shortly before the crash");
    });

    it("suspect banner title says 'deselected' when crashCount is at least 1", () => {
      setup({ crash: { crashCount: 1 } });
      const title = within(screen.getByTestId("suspect-warning")).getByTestId(
        "inline-status-banner-title"
      );
      expect(title.textContent).toContain("1 panel deselected");
      expect(title.textContent).toContain("created shortly before the crash");
    });

    it("suspect banner description prompts re-check when suspects were auto-deselected", () => {
      setup({ crash: { crashCount: 1 } });
      const desc = within(screen.getByTestId("suspect-warning")).getByTestId(
        "inline-status-banner-description"
      );
      expect(desc.textContent).toContain("Re-check");
    });

    it("suspect banner is omitted when there are no suspect panels", () => {
      setup({
        crash: {
          panels: [
            { id: "t1", kind: "terminal", title: "Shell", location: "grid", isSuspect: false },
          ],
        },
      });
      expect(screen.queryByTestId("suspect-warning")).toBeNull();
    });

    it("all panels are selected by default", () => {
      setup();
      const checkbox1 = screen.getByTestId("panel-checkbox-t1") as HTMLInputElement;
      const checkbox2 = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      expect(checkbox1.checked).toBe(true);
      expect(checkbox2.checked).toBe(true);
    });

    it("pre-deselects suspect panels when crashCount is at least 1", () => {
      setup({ crash: { crashCount: 1 } });
      const suspect = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      const nonSuspect1 = screen.getByTestId("panel-checkbox-t1") as HTMLInputElement;
      const nonSuspect3 = screen.getByTestId("panel-checkbox-t3") as HTMLInputElement;
      expect(suspect.checked).toBe(false);
      expect(nonSuspect1.checked).toBe(true);
      expect(nonSuspect3.checked).toBe(true);
    });

    it("pre-deselects suspect panels when crashCount is in a crash loop", () => {
      setup({ crash: { crashCount: 3 } });
      const suspect = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      expect(suspect.checked).toBe(false);
    });

    it("keeps suspect panels selected when crashCount is 0", () => {
      setup({ crash: { crashCount: 0 } });
      const suspect = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      expect(suspect.checked).toBe(true);
    });

    it("restore-selected omits pre-deselected suspect panels by default when crashCount >= 1", async () => {
      const { onResolve } = setup({ crash: { crashCount: 1 } });
      fireEvent.click(screen.getByTestId("restore-selected-button"));
      await waitFor(() =>
        expect(onResolve).toHaveBeenCalledWith({
          kind: "restore",
          panelIds: expect.arrayContaining(["t1", "t3"]),
        })
      );
      const call = (onResolve as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.panelIds).not.toContain("t2");
    });

    it("selection count reflects auto-deselection when crashCount >= 1", () => {
      setup({ crash: { crashCount: 1 } });
      expect(screen.getByText("2 of 3 selected")).toBeTruthy();
    });

    it("lets the user re-check a pre-deselected suspect and include it in restore", async () => {
      const { onResolve } = setup({ crash: { crashCount: 1 } });
      const suspect = screen.getByTestId("panel-checkbox-t2") as HTMLInputElement;
      expect(suspect.checked).toBe(false);
      fireEvent.click(suspect);
      expect((screen.getByTestId("panel-checkbox-t2") as HTMLInputElement).checked).toBe(true);
      fireEvent.click(screen.getByTestId("restore-selected-button"));
      await waitFor(() =>
        expect(onResolve).toHaveBeenCalledWith({
          kind: "restore",
          panelIds: expect.arrayContaining(["t1", "t2", "t3"]),
        })
      );
    });

    it("pre-deselects every suspect when multiple panels are flagged", () => {
      setup({
        crash: {
          crashCount: 1,
          panels: [
            { id: "t1", kind: "terminal", title: "Shell", location: "grid", isSuspect: false },
            { id: "t2", kind: "terminal", title: "Claude", location: "dock", isSuspect: true },
            { id: "t3", kind: "browser", title: "Docs", location: "grid", isSuspect: true },
          ],
        },
      });
      expect((screen.getByTestId("panel-checkbox-t1") as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId("panel-checkbox-t2") as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId("panel-checkbox-t3") as HTMLInputElement).checked).toBe(false);
      expect(screen.getByText("1 of 3 selected")).toBeTruthy();
      const title = within(screen.getByTestId("suspect-warning")).getByTestId(
        "inline-status-banner-title"
      );
      expect(title.textContent).toContain("2 panels deselected");
    });

    it("disables restore-selected when every panel is a pre-deselected suspect", () => {
      setup({
        crash: {
          crashCount: 1,
          panels: [
            { id: "t1", kind: "terminal", title: "Shell", location: "grid", isSuspect: true },
            { id: "t2", kind: "terminal", title: "Claude", location: "dock", isSuspect: true },
          ],
        },
      });
      expect((screen.getByTestId("panel-checkbox-t1") as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId("panel-checkbox-t2") as HTMLInputElement).checked).toBe(false);
      const restoreBtn = screen.getByTestId("restore-selected-button") as HTMLButtonElement;
      expect(restoreBtn.disabled).toBe(true);
      // Toggle-all should still let the user opt back in
      fireEvent.click(screen.getByTestId("toggle-all-button"));
      expect((screen.getByTestId("panel-checkbox-t1") as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId("panel-checkbox-t2") as HTMLInputElement).checked).toBe(true);
    });

    it("suspect banner description suggests deselecting when crashCount is 0", () => {
      setup({ crash: { crashCount: 0 } });
      const desc = within(screen.getByTestId("suspect-warning")).getByTestId(
        "inline-status-banner-description"
      );
      expect(desc.textContent).toContain("Consider deselecting");
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

    it("opens destructive confirm dialog when 'Continue without restoring' is clicked, does not call onResolve immediately", async () => {
      const { onResolve } = setup();
      fireEvent.click(screen.getByTestId("fresh-button"));
      expect(onResolve).not.toHaveBeenCalled();
      expect(screen.getByText("Reset to clean layout?")).toBeTruthy();
    });

    it("calls onResolve with fresh when confirm button is clicked in destructive dialog", async () => {
      const { onResolve } = setup();
      fireEvent.click(screen.getByTestId("fresh-button"));
      fireEvent.click(screen.getByText("Reset to clean layout"));
      await waitFor(() => expect(onResolve).toHaveBeenCalledWith({ kind: "fresh" }));
    });

    it("does not call onResolve when cancel is clicked in destructive confirm dialog", async () => {
      const { onResolve } = setup();
      fireEvent.click(screen.getByTestId("fresh-button"));
      fireEvent.click(screen.getByText("Cancel"));
      expect(onResolve).not.toHaveBeenCalled();
      // Fresh button should be re-enabled
      const btn = screen.getByTestId("fresh-button") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it("shows panel preview in destructive confirm dialog", () => {
      setup();
      fireEvent.click(screen.getByTestId("fresh-button"));
      const confirm = screen.getByTestId("app-dialog");
      expect(within(confirm).getByText("Shell")).toBeTruthy();
      expect(within(confirm).getByText("Claude")).toBeTruthy();
      expect(within(confirm).getByText("Docs")).toBeTruthy();
    });

    it("destructive confirm dialog does not show panel preview when panels is empty", () => {
      setup({ crash: { panels: [], hasBackup: false } });
      fireEvent.click(screen.getByTestId("fresh-button"));
      expect(screen.getByText("Your session will start with a clean layout.")).toBeTruthy();
    });

    it("destructive confirm warns about discarded backup when panels empty but backup exists", () => {
      setup({ crash: { panels: [], hasBackup: true } });
      fireEvent.click(screen.getByTestId("fresh-button"));
      expect(
        screen.getByText(
          "Your session will start with a clean layout and the existing session backup will be discarded."
        )
      ).toBeTruthy();
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

    it("restore-selected path is unaffected by destructive confirm gate", async () => {
      const { onResolve } = setup();
      fireEvent.click(screen.getByTestId("restore-selected-button"));
      await waitFor(() =>
        expect(onResolve).toHaveBeenCalledWith({
          kind: "restore",
          panelIds: expect.arrayContaining(["t1", "t2", "t3"]),
        })
      );
      // Should not show confirm dialog
      expect(screen.queryByText("Reset to clean layout?")).toBeNull();
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

    it("opens destructive confirm dialog on fresh in legacy mode and resolves on confirm", async () => {
      const { onResolve } = setup({ crash: { panels: [] } });
      fireEvent.click(screen.getByTestId("fresh-button"));
      expect(onResolve).not.toHaveBeenCalled();
      expect(screen.getByText("Reset to clean layout?")).toBeTruthy();
      fireEvent.click(screen.getByText("Reset to clean layout"));
      await waitFor(() => expect(onResolve).toHaveBeenCalledWith({ kind: "fresh" }));
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

  it("opens an editable preview on the first report click without opening the browser", () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    const textarea = screen.getByTestId("report-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toContain("Crash Report");
    expect(textarea.value).toContain("Something went wrong");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(window.electron.system.openExternal).not.toHaveBeenCalled();
  });

  it("submits the report on GitHub from the preview", async () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    fireEvent.click(screen.getByTestId("submit-report-button"));
    await waitFor(() =>
      expect(window.electron.system.openExternal).toHaveBeenCalledWith(
        expect.stringContaining("github.com/daintreehq/daintree/issues/new")
      )
    );
  });

  it("submits the edited textarea content, not the original report", async () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    const textarea = screen.getByTestId("report-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Edited crash notes from the user" } });
    fireEvent.click(screen.getByTestId("submit-report-button"));
    await waitFor(() => expect(window.electron.system.openExternal).toHaveBeenCalled());
    const url = (window.electron.system.openExternal as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    const body = decodeURIComponent(url.match(/[?&]body=([^&]*)/)![1]!);
    expect(body).toBe("Edited crash notes from the user");
  });

  it("hides the preview when Cancel is clicked", () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    expect(screen.getByTestId("report-preview")).toBeTruthy();
    fireEvent.click(screen.getByTestId("cancel-report-button"));
    expect(screen.queryByTestId("report-preview")).toBeNull();
    expect(window.electron.system.openExternal).not.toHaveBeenCalled();
  });

  it("keeps the preview open and shows an error when clipboard fallback fails", async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("denied")
    );
    setup({
      crash: { entry: { ...mockCrash.entry, errorStack: "x".repeat(10000) } },
    });
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    expect(screen.getByTestId("report-clipboard-note")).toBeTruthy();
    fireEvent.click(screen.getByTestId("submit-report-button"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("report-error")).toBeTruthy());
    expect(window.electron.system.openExternal).not.toHaveBeenCalled();
    expect(screen.getByTestId("report-preview")).toBeTruthy();
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

  it("report preview includes environment metadata and details section", () => {
    setup();
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    const reportText = (screen.getByTestId("report-textarea") as HTMLTextAreaElement).value;
    expect(reportText).toContain("Electron");
    expect(reportText).toContain("40.0.0");
    expect(reportText).toContain("Node");
    expect(reportText).toContain("22.12.0");
    expect(reportText).toContain("Memory (Free/Total)");
    expect(reportText).toContain("Panels");
    expect(reportText).toContain("<details>");
    expect(reportText).toContain("Stack trace");
    expect(reportText).toContain("Session");
  });

  it("report preview handles legacy entry without new fields gracefully", () => {
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
    const reportText = (screen.getByTestId("report-textarea") as HTMLTextAreaElement).value;
    expect(reportText).toContain("Daintree 1.0.0");
    expect(reportText).toContain("old crash");
    expect(reportText).not.toContain("Electron");
  });

  it("shows 'no backup' message when hasBackup is false in legacy mode", () => {
    setup({ crash: { hasBackup: false, backupTimestamp: undefined, panels: undefined } });
    expect(screen.getByText(/No backup available/)).toBeTruthy();
  });

  it("report preview surfaces watchdog deadlock cause when present", () => {
    setup({
      crash: {
        entry: {
          id: "wd-123",
          timestamp: 1700000000000,
          appVersion: "1.0.0",
          platform: "linux",
          osVersion: "5.15.0",
          arch: "x64",
          cause: "watchdog-deadlock",
          watchdogKilledAt: 1700000016000,
          watchdogMissedBeats: 3,
          watchdogMainPid: 4242,
        },
      },
    });
    fireEvent.click(screen.getByTestId("details-toggle"));
    fireEvent.click(screen.getByTestId("report-button"));
    const reportText = (screen.getByTestId("report-textarea") as HTMLTextAreaElement).value;
    expect(reportText).toContain("Watchdog deadlock");
    expect(reportText).toContain("3 missed heartbeats");
    expect(reportText).toContain("main PID 4242");
  });

  describe("recent actions trail", () => {
    const actions = [
      {
        id: "act-1",
        actionId: "terminal.kill",
        category: "terminal",
        source: "user" as const,
        danger: "confirm" as const,
        durationMs: 12,
        timestamp: 1699999990000,
        count: 1,
        confirmed: true,
      },
      {
        id: "act-2",
        actionId: "files.open",
        category: "files",
        source: "agent" as const,
        danger: "safe" as const,
        durationMs: 4,
        timestamp: 1699999995000,
        count: 2,
        args: { path: "/Users/alice/secret/file.ts" },
      },
    ];

    it("renders the action trail when recentActions is present", () => {
      setup({ crash: { entry: { ...mockCrash.entry, recentActions: actions } } });
      fireEvent.click(screen.getByTestId("details-toggle"));
      expect(screen.getByTestId("actions-section")).toBeTruthy();
      expect(screen.getByTestId("action-row-act-1")).toBeTruthy();
      expect(screen.getByTestId("action-row-act-2")).toBeTruthy();
      expect(screen.getByText("terminal.kill")).toBeTruthy();
      expect(screen.getByText("files.open")).toBeTruthy();
    });

    it("omits the action trail when recentActions is empty or undefined", () => {
      setup({ crash: { entry: { ...mockCrash.entry, recentActions: [] } } });
      fireEvent.click(screen.getByTestId("details-toggle"));
      expect(screen.queryByTestId("actions-section")).toBeNull();
    });

    it("scrubs user paths in rendered action args", () => {
      setup({ crash: { entry: { ...mockCrash.entry, recentActions: actions } } });
      fireEvent.click(screen.getByTestId("details-toggle"));
      const row = screen.getByTestId("action-row-act-2");
      expect(row.textContent).toContain("/Users/USER/secret/file.ts");
      expect(row.textContent).not.toContain("alice");
    });

    it("shows newest action first", () => {
      setup({ crash: { entry: { ...mockCrash.entry, recentActions: actions } } });
      fireEvent.click(screen.getByTestId("details-toggle"));
      const list = screen.getByTestId("actions-list");
      const rows = within(list).getAllByTestId(/^action-row-/);
      expect(rows[0]!.getAttribute("data-testid")).toBe("action-row-act-2");
      expect(rows[1]!.getAttribute("data-testid")).toBe("action-row-act-1");
    });
  });
});
