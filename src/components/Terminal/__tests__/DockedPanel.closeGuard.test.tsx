// @vitest-environment jsdom
/**
 * DockedPanel — header-X close guard for working-agent terminals (#6514).
 *
 * Mirrors the GridPanel guard for the dock popover. Single-tab dock groups
 * have no per-tab X button — the panel-header X is the only close affordance.
 * Multi-tab dock groups have per-tab guards in DockedTabGroup, but the header
 * X here also needs to honor the working-agent confirmation. The popover
 * collapses when the body-portalled dialog mounts (Radix), so close it before
 * showing the dialog and reopen on cancel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";
import type { TerminalInstance } from "@/store";

const trashPanelGroupMock = vi.fn();
const removePanelMock = vi.fn();
const setFocusedMock = vi.fn();
const updateTitleMock = vi.fn();
const moveTerminalToGridMock = vi.fn();
const closeDockTerminalMock = vi.fn();
const openDockTerminalMock = vi.fn();

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      trashPanelGroup: trashPanelGroupMock,
      removePanel: removePanelMock,
      setFocused: setFocusedMock,
      updateTitle: updateTitleMock,
      moveTerminalToGrid: moveTerminalToGridMock,
      closeDockTerminal: closeDockTerminalMock,
      openDockTerminal: openDockTerminalMock,
      focusedId: null,
    }),
}));

let mockSkipWorkingCloseConfirm = false;

vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (s: { skipWorkingCloseConfirm: boolean }) => unknown) =>
    selector({ skipWorkingCloseConfirm: mockSkipWorkingCloseConfirm }),
}));

vi.mock("@/lib/animationUtils", () => ({
  getTerminalAnimationDuration: () => 0,
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Panel", () => ({
  ContentPanel: () => <div data-testid="content-panel" />,
  PluginMissingPanel: () => <div data-testid="plugin-missing" />,
  triggerPanelTransition: vi.fn(),
}));

vi.mock("@/utils/panelProps", () => ({
  buildPanelProps: ({ overrides }: { overrides: { onClose: (force?: boolean) => void } }) => {
    return overrides;
  },
}));

vi.mock("@/registry", () => ({
  getPanelKindDefinition: () => ({
    component: ({ onClose }: { onClose?: (force?: boolean) => void }) => (
      <div>
        <button data-testid="header-close" onClick={() => onClose?.(false)}>
          X
        </button>
        <button data-testid="header-force-close" onClick={() => onClose?.(true)}>
          Alt+X
        </button>
      </div>
    ),
  }),
  getPanelKindDefinitionsSnapshot: () => 0,
  subscribeToPanelKindDefinitions: () => () => {},
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    confirmLabel,
    onConfirm,
    onClose,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
    onClose?: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="confirm-dialog">
        <h2 data-testid="dialog-title">{title}</h2>
        <button data-testid="dialog-cancel" onClick={onClose}>
          cancel
        </button>
        <button data-testid="dialog-confirm" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { DockedPanel } from "../DockedPanel";

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t-1",
    title: "Terminal",
    location: "dock",
    kind: "terminal",
    ...overrides,
  } as TerminalInstance;
}

describe("DockedPanel header-close guard (#6514)", () => {
  beforeEach(() => {
    trashPanelGroupMock.mockClear();
    removePanelMock.mockClear();
    closeDockTerminalMock.mockClear();
    openDockTerminalMock.mockClear();
    mockSkipWorkingCloseConfirm = false;
  });

  it("closes immediately when terminal is idle", () => {
    const { getByTestId, queryByTestId } = render(
      <DockedPanel terminal={makeTerminal({ agentState: "idle" as AgentState })} />
    );

    fireEvent.click(getByTestId("header-close"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(trashPanelGroupMock).toHaveBeenCalledWith("t-1");
        resolve();
      }, 0)
    );
  });

  it("shows the confirm dialog and collapses the popover for a working agent", () => {
    const { getByTestId } = render(
      <DockedPanel terminal={makeTerminal({ agentState: "working" as AgentState })} />
    );

    fireEvent.click(getByTestId("header-close"));

    expect(getByTestId("confirm-dialog")).toBeTruthy();
    expect(getByTestId("dialog-title").textContent).toBe("Stop this agent?");
    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
    expect(trashPanelGroupMock).not.toHaveBeenCalled();
  });

  it("trashes when the user confirms", () => {
    const { getByTestId } = render(
      <DockedPanel terminal={makeTerminal({ agentState: "working" as AgentState })} />
    );

    fireEvent.click(getByTestId("header-close"));
    fireEvent.click(getByTestId("dialog-confirm"));

    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(trashPanelGroupMock).toHaveBeenCalledWith("t-1");
        resolve();
      }, 0)
    );
  });

  it("reopens the dock popover and does not trash on cancel", () => {
    const { getByTestId, queryByTestId } = render(
      <DockedPanel terminal={makeTerminal({ agentState: "working" as AgentState })} />
    );

    fireEvent.click(getByTestId("header-close"));
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(trashPanelGroupMock).not.toHaveBeenCalled();
    expect(openDockTerminalMock).toHaveBeenCalledWith("t-1");
  });

  it("force=true (Alt+Click) bypasses the dialog and removes the panel", () => {
    const { getByTestId, queryByTestId } = render(
      <DockedPanel terminal={makeTerminal({ agentState: "working" as AgentState })} />
    );

    fireEvent.click(getByTestId("header-force-close"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(removePanelMock).toHaveBeenCalledWith("t-1");
  });

  it("closes a working agent immediately when skipWorkingCloseConfirm is on", () => {
    mockSkipWorkingCloseConfirm = true;
    const { getByTestId, queryByTestId } = render(
      <DockedPanel terminal={makeTerminal({ agentState: "working" as AgentState })} />
    );

    fireEvent.click(getByTestId("header-close"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(trashPanelGroupMock).toHaveBeenCalledWith("t-1");
        resolve();
      }, 0)
    );
  });
});
