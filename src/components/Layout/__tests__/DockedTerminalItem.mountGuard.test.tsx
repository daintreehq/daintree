// @vitest-environment jsdom
/**
 * DockedTerminalItem — mount-time spurious-close guard (#6602).
 *
 * Radix's DismissableLayer fires onOpenChange(false) synchronously during the
 * mount commit when PopoverContent mounts with open=true. That happens before
 * the useEffect that arms wasJustOpenedRef can run. The fix initializes
 * useRef(isOpen) so the guard is armed at first render and the spurious close
 * is ignored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import type { TerminalInstance } from "@/store";

const openDockTerminalMock = vi.fn();
const closeDockTerminalMock = vi.fn();
const moveTerminalToGridMock = vi.fn();

let mockActiveDockTerminalId: string | null = null;
let capturedOnOpenChange: ((open: boolean) => void) | null = null;
let capturedOnOpenAutoFocus: ((event: { preventDefault: () => void }) => void) | null = null;

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeDockTerminalId: mockActiveDockTerminalId,
      openDockTerminal: openDockTerminalMock,
      closeDockTerminal: closeDockTerminalMock,
      moveTerminalToGrid: moveTerminalToGridMock,
      backendStatus: "connected",
      showDockAgentHighlights: false,
    }),
  useTerminalInputStore: (
    selector: (s: { hybridInputEnabled: boolean; hybridInputAutoFocus: boolean }) => unknown
  ) => selector({ hybridInputEnabled: false, hybridInputAutoFocus: false }),
  usePortalStore: (selector: (s: { isOpen: boolean; width: number }) => unknown) =>
    selector({ isOpen: false, width: 0 }),
  useFocusStore: (
    selector: (s: { isFocusMode: boolean; gestureSidebarHidden: boolean }) => unknown
  ) => selector({ isFocusMode: false, gestureSidebarHidden: false }),
  usePreferencesStore: (selector: (s: { showDockAgentHighlights: boolean }) => unknown) =>
    selector({ showDockAgentHighlights: false }),
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: { settings: null }) => unknown) =>
    selector({ settings: null }),
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: (selector: (s: { ccrPresetsByAgent: Record<string, unknown> }) => unknown) =>
    selector({ ccrPresetsByAgent: {} }),
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: (selector: (s: { presetsByAgent: Record<string, unknown> }) => unknown) =>
    selector({ presetsByAgent: {} }),
}));

vi.mock("@/config/agents", () => ({
  getMergedPresets: () => [],
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fit: () => ({ cols: 80, rows: 24 }),
    applyRendererPolicy: vi.fn(),
    focus: vi.fn(),
  },
}));

vi.mock("../DockPanelOffscreenContainer", () => ({
  useDockPanelPortal: () => vi.fn(),
}));

vi.mock("../useDockBlockedState", () => ({
  useDockBlockedState: () => null,
  getDockDisplayAgentState: () => undefined,
}));

vi.mock("../dockPopoverGuard", () => ({
  handleDockInteractOutside: vi.fn(),
  handleDockEscapeKeyDown: vi.fn(),
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({ isAgent: false, color: "#abc" }),
}));

vi.mock("@/components/Worktree/terminalStateConfig", () => ({
  getEffectiveStateIcon: () => null,
  getEffectiveStateColor: () => "",
}));

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-testid="terminal-icon" />,
}));

vi.mock("@/components/Terminal/terminalFocus", () => ({
  getTerminalFocusTarget: () => "terminal",
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "",
}));

vi.mock("@/lib/tooltipShortcut", () => ({
  createTooltipContent: () => null,
}));

// Active Popover mock: simulates Radix DismissableLayer firing onOpenChange(false)
// synchronously after mount when open=true. A useEffect runs after commit/paint, which
// matches the timing of native focusin events arriving from the same commit. The
// callback is also captured so tests can invoke it manually after the guard window.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    capturedOnOpenChange = onOpenChange ?? null;
    useEffect(() => {
      if (open && onOpenChange) {
        onOpenChange(false);
      }
      // Only simulate the spurious mount close once.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    onOpenAutoFocus,
  }: {
    children: React.ReactNode;
    onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
  }) => {
    capturedOnOpenAutoFocus = onOpenAutoFocus ?? null;
    return <div>{children}</div>;
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@dnd-kit/core", () => ({
  useDndMonitor: vi.fn(),
}));

import { DockedTerminalItem } from "../DockedTerminalItem";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t-1",
    title: "Terminal",
    location: "dock",
    kind: "terminal",
    ...overrides,
  } as TerminalInstance;
}

describe("DockedTerminalItem mount-time close guard (#6602)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openDockTerminalMock.mockClear();
    closeDockTerminalMock.mockClear();
    moveTerminalToGridMock.mockClear();
    mockActiveDockTerminalId = null;
    capturedOnOpenChange = null;
    capturedOnOpenAutoFocus = null;
    vi.mocked(terminalInstanceService.focus).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores spurious onOpenChange(false) when mounted already-open", () => {
    mockActiveDockTerminalId = "t-1";

    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    expect(closeDockTerminalMock).not.toHaveBeenCalled();
  });

  it("allows close once the guard window drains", () => {
    mockActiveDockTerminalId = "t-1";

    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
    expect(capturedOnOpenChange).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(150);
    });

    act(() => {
      capturedOnOpenChange?.(false);
    });

    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when mounted closed (no spurious close to ignore)", () => {
    mockActiveDockTerminalId = null;

    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    expect(closeDockTerminalMock).not.toHaveBeenCalled();
    expect(openDockTerminalMock).not.toHaveBeenCalled();
  });

  it("still honors a real onOpenChange(false) when mounted closed", () => {
    // Regression guard against accidentally arming the ref unconditionally.
    mockActiveDockTerminalId = null;

    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(capturedOnOpenChange).not.toBeNull();

    act(() => {
      capturedOnOpenChange?.(false);
    });

    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("focuses a normally opened dock terminal after Radix open autofocus", () => {
    mockActiveDockTerminalId = "t-1";
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(capturedOnOpenAutoFocus).not.toBeNull();

    const preventDefault = vi.fn();
    act(() => {
      capturedOnOpenAutoFocus?.({ preventDefault });
      vi.advanceTimersByTime(50);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(terminalInstanceService.focus).toHaveBeenCalledWith("t-1");
  });

  it("does not focus an MCP-created dock terminal from Radix open autofocus", () => {
    mockActiveDockTerminalId = "t-1";
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1", spawnedBy: "mcp" })} />);
    expect(capturedOnOpenAutoFocus).not.toBeNull();

    const preventDefault = vi.fn();
    act(() => {
      capturedOnOpenAutoFocus?.({ preventDefault });
      vi.advanceTimersByTime(50);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(terminalInstanceService.focus).not.toHaveBeenCalled();
  });
});

describe("DockedTerminalItem lifecycle and pop-out (#8160)", () => {
  let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback; cancelled: boolean }> = [];
  let nextRafId = 1;

  function flushRaf() {
    const pending = rafCallbacks.filter((e) => !e.cancelled);
    rafCallbacks = [];
    for (const entry of pending) entry.cb(performance.now());
  }

  beforeEach(() => {
    vi.useFakeTimers();
    rafCallbacks = [];
    nextRafId = 1;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextRafId++;
      rafCallbacks.push({ id, cb, cancelled: false });
      return id;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      const entry = rafCallbacks.find((e) => e.id === id);
      if (entry) entry.cancelled = true;
    });
    openDockTerminalMock.mockClear();
    closeDockTerminalMock.mockClear();
    moveTerminalToGridMock.mockClear();
    mockActiveDockTerminalId = null;
    vi.mocked(terminalInstanceService.applyRendererPolicy).mockClear();
    vi.mocked(terminalInstanceService.focus).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("schedules a single RAF on open and applies VISIBLE policy when it fires", () => {
    mockActiveDockTerminalId = "t-1";

    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    expect(rafCallbacks.length).toBe(1);
    expect(terminalInstanceService.applyRendererPolicy).not.toHaveBeenCalled();

    act(() => {
      flushRaf();
    });

    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t-1",
      TerminalRefreshTier.VISIBLE
    );
  });

  it("applies BACKGROUND policy synchronously when mounted closed", () => {
    mockActiveDockTerminalId = null;

    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t-1",
      TerminalRefreshTier.BACKGROUND
    );
    expect(rafCallbacks.length).toBe(0);
  });

  it("cancels the pending RAF and never applies VISIBLE when closed before it fires", () => {
    mockActiveDockTerminalId = "t-1";

    const { rerender } = render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(rafCallbacks.length).toBe(1);
    expect(rafCallbacks[0]?.cancelled).toBe(false);

    mockActiveDockTerminalId = null;
    rerender(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    expect(rafCallbacks[0]?.cancelled).toBe(true);

    act(() => {
      flushRaf();
    });

    const calls = vi.mocked(terminalInstanceService.applyRendererPolicy).mock.calls;
    expect(calls.some((c) => c[1] === TerminalRefreshTier.VISIBLE)).toBe(false);
    expect(calls.some((c) => c[1] === TerminalRefreshTier.BACKGROUND)).toBe(true);
  });

  // The "Open in grid" affordance moved out of DockedTerminalItem's overlay and
  // into PanelHeader's control slot (#8359). Button rendering + onRestore wiring
  // is covered by PanelHeader.test.tsx; the conditional dock-close lives in
  // DockedPanel.handleRestore.
});
