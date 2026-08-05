// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TOOLBAR_CUSTOMIZE_LABEL, TOOLBAR_UNPIN_LABEL } from "../toolbarMenuStrings";

const dispatchMock = vi.fn();
const toggleButtonVisibilityMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => {
      dispatchMock(...args);
      return Promise.resolve({ ok: true });
    },
  },
}));

vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (
    selector: (s: { toggleButtonVisibility: typeof toggleButtonVisibilityMock }) => unknown
  ) => selector({ toggleButtonVisibility: toggleButtonVisibilityMock }),
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuActionItem: ({
    actionId,
    args,
    children,
    onSelect,
  }: {
    actionId: string;
    args?: unknown;
    children: React.ReactNode;
    onSelect?: (e: { defaultPrevented: boolean; preventDefault: () => void }) => void;
  }) => (
    <button
      data-testid="context-menu-action-item"
      data-action-id={actionId}
      data-args={JSON.stringify(args)}
      onClick={() => {
        const fakeEvent = {
          defaultPrevented: false,
          preventDefault: () => {
            (fakeEvent as { defaultPrevented: boolean }).defaultPrevented = true;
          },
        };
        onSelect?.(fakeEvent);
        if (!fakeEvent.defaultPrevented) {
          void dispatchMock(actionId, args, { source: "user" });
        }
      }}
    >
      {children}
    </button>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
  }) => (
    <button data-testid="context-menu-item" onClick={(e) => onSelect?.(e as unknown as Event)}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr data-testid="context-menu-separator" />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuActionItem: ({
    actionId,
    args,
    children,
    onSelect,
  }: {
    actionId: string;
    args?: unknown;
    children: React.ReactNode;
    onSelect?: (e: { defaultPrevented: boolean; preventDefault: () => void }) => void;
  }) => (
    <button
      data-testid="dropdown-menu-action-item"
      data-action-id={actionId}
      data-args={JSON.stringify(args)}
      onClick={() => {
        const fakeEvent = {
          defaultPrevented: false,
          preventDefault: () => {
            (fakeEvent as { defaultPrevented: boolean }).defaultPrevented = true;
          },
        };
        onSelect?.(fakeEvent);
        if (!fakeEvent.defaultPrevented) {
          void dispatchMock(actionId, args, { source: "user" });
        }
      }}
    >
      {children}
    </button>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
  }) => (
    <button data-testid="dropdown-menu-item" onClick={(e) => onSelect?.(e as unknown as Event)}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr data-testid="dropdown-menu-separator" />,
}));

import { ToolbarContextMenuItems } from "../ToolbarContextMenuItems";

beforeEach(() => {
  dispatchMock.mockClear();
  toggleButtonVisibilityMock.mockClear();
});

describe("ToolbarContextMenuItems", () => {
  it("uses the U+2026 ellipsis on Customize (not ASCII '...') — issue #9825", () => {
    // Drift guard: the ellipsis on Customize matches the confirm-tier
    // pattern in `src/components/ActionPalette/ActionPaletteItem.tsx:126`
    // and signals "opens a dialog" — the only allowed ellipsis use per
    // CLAUDE.md microcopy rules. A future rename to ASCII '...' would
    // silently break the affordance.
    expect(TOOLBAR_CUSTOMIZE_LABEL).toBe("Customize toolbar…");
    expect(TOOLBAR_CUSTOMIZE_LABEL).not.toContain("...");
  });

  it("uses sentence case for the unpin label", () => {
    expect(TOOLBAR_UNPIN_LABEL).toBe("Unpin from toolbar");
  });

  it("renders the customize and unpin labels in the context variant", () => {
    const { getByText } = render(<ToolbarContextMenuItems buttonId="terminal" side="left" />);
    expect(getByText(TOOLBAR_CUSTOMIZE_LABEL)).toBeTruthy();
    expect(getByText(TOOLBAR_UNPIN_LABEL)).toBeTruthy();
  });

  it("uses ContextMenu primitives for the default variant", () => {
    const { queryAllByTestId, queryByTestId } = render(
      <ToolbarContextMenuItems buttonId="terminal" side="left" />
    );
    expect(queryAllByTestId("context-menu-action-item").length).toBe(1);
    expect(queryAllByTestId("context-menu-item").length).toBe(1);
    expect(queryByTestId("dropdown-menu-action-item")).toBeNull();
    expect(queryByTestId("dropdown-menu-item")).toBeNull();
  });

  it("uses DropdownMenu primitives for the dropdown variant", () => {
    const { queryAllByTestId, queryByTestId } = render(
      <ToolbarContextMenuItems buttonId="launcher" side="left" variant="dropdown" />
    );
    expect(queryAllByTestId("dropdown-menu-action-item").length).toBe(1);
    expect(queryAllByTestId("dropdown-menu-item").length).toBe(1);
    expect(queryByTestId("context-menu-action-item")).toBeNull();
    expect(queryByTestId("context-menu-item")).toBeNull();
  });

  it("dispatches app.settings.openTab with the toolbar tab when the customize entry is clicked (context variant)", () => {
    const { getByTestId } = render(<ToolbarContextMenuItems buttonId="dev-server" side="left" />);
    const customize = getByTestId("context-menu-action-item");
    fireEvent.click(customize);
    // The ContextMenuActionItem wrapper passes the dispatchOptions to
    // `actionService.dispatch`; in the test mock the source is the default
    // "user" because there's no wrapping Radix context. We only assert the
    // action id and args here — source assertion is exercised in
    // LauncherMenuButton.test.tsx.
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "toolbar" },
      expect.objectContaining({})
    );
  });

  it("calls toggleButtonVisibility(buttonId, side) when the unpin entry is clicked (context variant)", () => {
    const { getByTestId } = render(<ToolbarContextMenuItems buttonId="copy-tree" side="right" />);
    const unpin = getByTestId("context-menu-item");
    fireEvent.click(unpin);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("copy-tree", "right");
  });

  it("propagates buttonId and side to the dropdown variant's unpin handler", () => {
    const { getByTestId } = render(
      <ToolbarContextMenuItems buttonId="launcher" side="left" variant="dropdown" />
    );
    const unpin = getByTestId("dropdown-menu-item");
    fireEvent.click(unpin);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("launcher", "left");
  });

  it("uses the onUnpin override when provided (agent IDs route to setAgentPinned)", () => {
    // Regression guard for issue #9825 Critical 1: per-agent toolbar
    // buttons read pin state from agentSettingsStore (tri-state — see
    // isAgentToolbarVisible / #7673), so the wrapper's default
    // toggleButtonVisibility writes to the wrong store. AgentButton
    // passes `onUnpin` to redirect to setAgentPinned.
    const onUnpinMock = vi.fn();
    const { getByTestId } = render(
      <ToolbarContextMenuItems buttonId="claude" side="left" onUnpin={onUnpinMock} />
    );
    const unpin = getByTestId("context-menu-item");
    fireEvent.click(unpin);
    expect(onUnpinMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });
});
