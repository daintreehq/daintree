// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";

/**
 * The menu-to-picker handoff through the real overlays: `PanelHeader.test.tsx`
 * stubs the menu, the tooltip and portals, so it can pin the ordering but not
 * where focus actually ends up.
 */

const { dispatchMock, storeState, worktrees } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  worktrees: [
    { id: "w-main", name: "daintree", branch: "main", isMainWorktree: true },
    { id: "w-a", name: "feature-a", branch: "feature/a", isMainWorktree: false },
    { id: "w-b", name: "feature-b", branch: "feature/b", isMainWorktree: false },
  ].map((overrides): WorktreeState => ({
    worktreeId: overrides.id,
    path: `/repo/${overrides.name}`,
    isCurrent: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  })),
  storeState: {
    current: {
      watchedPanels: new Set<string>(),
      watchPanel: () => {},
      unwatchPanel: () => {},
      panelsById: { "test-panel": { id: "test-panel", worktreeId: "w-a" } } as Record<
        string,
        unknown
      >,
      panelIds: ["test-panel"],
    },
  },
}));

vi.mock("framer-motion", () => {
  const passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => {
      const {
        layoutId: _layoutId,
        layout: _layout,
        transition: _transition,
        ...rest
      } = props as Record<string, unknown>;
      return (
        <div ref={ref} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
          {children}
        </div>
      );
    }
  );
  return {
    AnimatePresence: passthrough,
    LayoutGroup: passthrough,
    LazyMotion: passthrough,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv, span: MotionDiv },
    motion: { div: MotionDiv, span: MotionDiv },
  };
});

vi.mock("@/hooks", () => ({
  useBackgroundPanelStats: () => ({ activeCount: 0, workingCount: 0 }),
  useTabOverflow: () => new Set(),
  useKeybindingDisplay: () => "",
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
}));

vi.mock("@/components/DragDrop/DragHandleContext", () => ({
  useDragHandle: () => null,
}));

vi.mock("@/store/panelStore", () => {
  const usePanelStore = (selector: (s: Record<string, unknown>) => unknown) =>
    selector(storeState.current);
  usePanelStore.getState = () => storeState.current;
  return { usePanelStore };
});

vi.mock("@shared/config/panelKindRegistry", async (importOriginal) => ({
  // The real module underneath: `isBuiltInPanelKind` reads its kind list.
  ...(await importOriginal<typeof import("@shared/config/panelKindRegistry")>()),
  panelKindCanRestart: () => false,
  panelKindHasPty: () => false,
  panelKindIsDockable: () => true,
  getPanelKindConfig: () => ({
    id: "terminal",
    name: "Terminal",
    iconId: "terminal",
    color: "#9ca3af",
  }),
  getPanelKindColor: () => "#9ca3af",
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("@/lib/watchNotification", () => ({
  fireWatchNotification: vi.fn(),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: <T,>(selector: (state: { worktrees: Map<string, unknown> }) => T) =>
    selector({ worktrees: new Map(worktrees.map((worktree) => [worktree.id, worktree])) }),
}));

vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({
  useSidebarWorktreeOrder: () => worktrees,
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => null,
}));

vi.mock("@/store/worktreeFilterStore", () => ({
  useWorktreeFilterStore: (selector: (state: unknown) => unknown) =>
    selector({ orderBy: "alpha", pinnedWorktrees: [], manualOrder: [] }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { PanelHeader } from "../PanelHeader";

function renderHeader() {
  return render(
    <TooltipProvider>
      <PanelHeader
        id="test-panel"
        title="Test Panel"
        kind="terminal"
        chrome={deriveTerminalChrome({ kind: "terminal" })}
        isFocused={true}
        isEditingTitle={false}
        editingValue=""
        titleInputRef={{ current: null }}
        onEditingValueChange={vi.fn()}
        onTitleDoubleClick={vi.fn()}
        onTitleKeyDown={vi.fn()}
        onTitleInputKeyDown={vi.fn()}
        onTitleSave={vi.fn()}
        onClose={vi.fn()}
        onFocus={vi.fn()}
      />
    </TooltipProvider>
  );
}

const RADIX_FOCUS_RETURN_TICK_MS = 20;

function searchField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search worktrees"]');
}

async function openPickerByKeyboard() {
  const trigger = screen.getByLabelText("More panel actions");
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: "Enter" });
  const item = await screen.findByRole("menuitem", { name: "Move to worktree…" });
  fireEvent.keyDown(item, { key: "Enter" });
  await waitFor(() => expect(searchField()).not.toBeNull());
  return trigger;
}

beforeEach(() => {
  dispatchMock.mockReset();
  _resetTooltipFocusSuppressionForTests();
});

describe("PanelHeader Move to worktree, through the real overlays", () => {
  it("lands the caret in the search field, not on the menu button", async () => {
    renderHeader();

    const trigger = await openPickerByKeyboard();

    await waitFor(() => expect(document.activeElement).toBe(searchField()));
    expect(document.activeElement).not.toBe(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("returns an Escape to the menu button without raising its tooltip", async () => {
    renderHeader();
    const trigger = await openPickerByKeyboard();
    await waitFor(() => expect(document.activeElement).toBe(searchField()));

    fireEvent.keyDown(searchField()!, { key: "Escape" });

    await waitFor(() => expect(searchField()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("moves the panel from the keyboard and leaves focus off the button", async () => {
    renderHeader();
    const trigger = await openPickerByKeyboard();
    await waitFor(() => expect(document.activeElement).toBe(searchField()));

    // Main, then the panel's own worktree skipped, then feature-b.
    fireEvent.keyDown(searchField()!, { key: "ArrowDown" });
    fireEvent.keyDown(searchField()!, { key: "Enter" });

    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.moveToWorktree",
      { terminalId: "test-panel", worktreeId: "w-b" },
      { source: "menu" }
    );
    await waitFor(() => expect(searchField()).toBeNull());
    // Radix schedules its focus return on a zero-delay timer after the
    // content unmounts; let it run before checking where focus went.
    await act(() => new Promise((resolve) => setTimeout(resolve, RADIX_FOCUS_RETURN_TICK_MS)));
    expect(document.activeElement).not.toBe(trigger);
  });
});
