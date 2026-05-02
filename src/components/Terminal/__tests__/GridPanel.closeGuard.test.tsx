// @vitest-environment jsdom
/**
 * GridPanel — header-X close guard for working-agent groups (#6330, #6513).
 *
 * The per-tab guard in GridTabGroup only intercepts the per-tab X buttons.
 * The panel-header X button calls handleClose(false) → trashPanelGroup,
 * which silently kills the entire group — including single-tab groups whose
 * only close affordance IS that header button. This test pins the parallel
 * guard at the GridPanel layer. The guard fires only for "working" tabs;
 * "waiting"/"directing" close immediately (#6513).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";
import type { TerminalInstance } from "@/store";
import type { TabInfo } from "@/components/Panel/TabButton";

const trashPanelGroupMock = vi.fn();
const removePanelMock = vi.fn();
const setFocusedMock = vi.fn();
const updateTitleMock = vi.fn();
const toggleMaximizeMock = vi.fn();
const moveTerminalToDockMock = vi.fn();
const getPanelGroupMock = vi.fn(() => null);

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      trashPanelGroup: trashPanelGroupMock,
      removePanel: removePanelMock,
      setFocused: setFocusedMock,
      updateTitle: updateTitleMock,
      toggleMaximize: toggleMaximizeMock,
      getPanelGroup: getPanelGroupMock,
      moveTerminalToDock: moveTerminalToDockMock,
    }),
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

vi.mock("@/utils/terminalChrome", () => ({
  terminalChromeDescriptorsEqual: () => false,
}));

// Render a stub panel kind that exposes the resolved onClose so the test can
// drive the same code path the real PanelHeader X button uses.
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

import { GridPanel } from "../GridPanel";

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t-1",
    title: "Terminal",
    location: "grid",
    kind: "terminal",
    ...overrides,
  } as TerminalInstance;
}

function makeTab(id: string, agentState?: AgentState): TabInfo {
  return {
    id,
    title: id,
    chrome: { color: "#abc", isAgent: false } as TabInfo["chrome"],
    kind: "terminal",
    agentState,
    isActive: false,
  } as TabInfo;
}

describe("GridPanel header-close guard (#6330)", () => {
  beforeEach(() => {
    trashPanelGroupMock.mockClear();
    removePanelMock.mockClear();
  });

  it("closes immediately when single-tab group has an idle terminal", () => {
    const { getByTestId, queryByTestId } = render(
      <GridPanel
        terminal={makeTerminal({ agentState: "idle" })}
        isFocused={false}
        tabs={[makeTab("t-1", "idle")]}
      />
    );

    fireEvent.click(getByTestId("header-close"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    // trashPanelGroup is scheduled via setTimeout(0); flush it.
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(trashPanelGroupMock).toHaveBeenCalledWith("t-1");
        resolve();
      }, 0)
    );
  });

  it("shows the confirm dialog when single-tab group has a working terminal", () => {
    const { getByTestId } = render(
      <GridPanel
        terminal={makeTerminal({ agentState: "working" })}
        isFocused={false}
        tabs={[makeTab("t-1", "working")]}
      />
    );

    fireEvent.click(getByTestId("header-close"));

    expect(getByTestId("confirm-dialog")).toBeTruthy();
    expect(getByTestId("dialog-title").textContent).toBe("Stop this agent?");
    expect(trashPanelGroupMock).not.toHaveBeenCalled();
  });

  it.each(["waiting", "directing"] as const)(
    "closes immediately when single-tab group has a %s terminal (#6513)",
    (state) => {
      const { getByTestId, queryByTestId } = render(
        <GridPanel
          terminal={makeTerminal({ agentState: state as AgentState })}
          isFocused={false}
          tabs={[makeTab("t-1", state as AgentState)]}
        />
      );

      fireEvent.click(getByTestId("header-close"));

      expect(queryByTestId("confirm-dialog")).toBeNull();
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          expect(trashPanelGroupMock).toHaveBeenCalledWith("t-1");
          resolve();
        }, 0)
      );
    }
  );

  it("shows dialog when ANY tab in a multi-tab group has an active agent", () => {
    const { getByTestId } = render(
      <GridPanel
        terminal={makeTerminal({ id: "t-1", agentState: "idle" })}
        isFocused={false}
        tabs={[makeTab("t-1", "idle"), makeTab("t-2", "working")]}
      />
    );

    fireEvent.click(getByTestId("header-close"));

    expect(getByTestId("confirm-dialog")).toBeTruthy();
    expect(trashPanelGroupMock).not.toHaveBeenCalled();
  });

  it("does NOT show the dialog when force=true (Alt+Click bypass)", () => {
    const { getByTestId, queryByTestId } = render(
      <GridPanel
        terminal={makeTerminal({ agentState: "working" })}
        isFocused={false}
        tabs={[makeTab("t-1", "working")]}
      />
    );

    fireEvent.click(getByTestId("header-force-close"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(removePanelMock).toHaveBeenCalledWith("t-1");
  });

  it("trashes the group when the user confirms", () => {
    const { getByTestId } = render(
      <GridPanel
        terminal={makeTerminal({ agentState: "working" })}
        isFocused={false}
        tabs={[makeTab("t-1", "working")]}
      />
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

  it("does not trash when the user cancels", () => {
    const { getByTestId, queryByTestId } = render(
      <GridPanel
        terminal={makeTerminal({ agentState: "working" })}
        isFocused={false}
        tabs={[makeTab("t-1", "working")]}
      />
    );

    fireEvent.click(getByTestId("header-close"));
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(trashPanelGroupMock).not.toHaveBeenCalled();
  });
});
