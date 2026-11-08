// @vitest-environment jsdom
// The pill's own suite mocks the selector and the store, so neither it nor the
// selector's suite would notice the two disagreeing. Here the real store feeds
// the real selector, and the row acts on the real panel.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PanelInstance } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktreeNames: () => new Map(),
}));

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => {
  const Pass = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return { Tooltip: Pass, TooltipContent: Pass, TooltipProvider: Pass, TooltipTrigger: Pass };
});

vi.mock("@/components/ui/popover", () => {
  const Pass = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Popover: Pass, PopoverContent: Pass, PopoverTrigger: Pass };
});

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    confirmLabel,
    onConfirm,
  }: {
    isOpen: boolean;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    isOpen ? (
      <button type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>
    ) : null,
}));

const { usePanelStore } = await import("@/store");
const { BackgroundContainer } = await import("../BackgroundContainer");

/** The kinds a menu can background, the narrowed read path's blind spots first. */
const KINDS = ["file-browser", "diff", "acme.widget", "file", "browser", "review"];

function pillIsVisible(container: HTMLElement): boolean {
  return container.querySelector(".dock-status-pill")?.getAttribute("data-visible") === "true";
}

// Through fromEntries rather than a cast: a plugin's kind is outside the built-in union.
function seedGridPanel(kind: string) {
  const panel: Pick<PanelInstance, "id" | "title" | "location"> & { kind: string } = {
    id: "p1",
    kind,
    title: "Parked",
    location: "grid",
  };
  usePanelStore.setState(
    Object.fromEntries([
      ["panelsById", { p1: panel }],
      ["panelIds", ["p1"]],
    ])
  );
}

describe.each(KINDS)("a %s panel through the Background pill", (kind) => {
  beforeEach(() => {
    vi.useFakeTimers();
    void usePanelStore.getState().reset();
    usePanelStore.setState({
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
    });
    seedGridPanel(kind);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows the pill when sent to background, and its row brings it back", () => {
    const { container } = render(<BackgroundContainer />);
    expect(pillIsVisible(container)).toBe(false);

    act(() => usePanelStore.getState().backgroundTerminal("p1"));

    expect(pillIsVisible(container)).toBe(true);
    expect(screen.getByRole("button", { name: /^Background: 1 panel/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restore Parked" }));

    expect(usePanelStore.getState().panelsById["p1"]!.location).toBe("grid");
    expect(usePanelStore.getState().focusedId).toBe("p1");
    expect(pillIsVisible(container)).toBe(false);
  });

  it("is gone for good when its row removes it", () => {
    const { container } = render(<BackgroundContainer />);
    act(() => usePanelStore.getState().backgroundTerminal("p1"));

    fireEvent.click(screen.getByRole("button", { name: "Remove Parked" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove panel" }));

    expect(usePanelStore.getState().panelsById["p1"]).toBeUndefined();
    expect(pillIsVisible(container)).toBe(false);
  });
});
