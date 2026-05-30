// @vitest-environment jsdom
/**
 * DockedTerminalItem — focus-driven dismissal guard (#6602).
 *
 * Radix's DismissableLayer fires a focus-outside dismissal while a just-opened
 * dock popover's terminal is still migrating into the portal (focus transiently
 * leaves the layer). The fix blocks that path at PopoverContent's onFocusOutside
 * (preventDefault), so genuine pointer-outside / Escape closes still reach
 * onOpenChange and are honored. Focus is moved into the terminal once it has
 * migrated into the portal (observed child insertion), not on a fixed timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";

const openDockTerminalMock = vi.fn();
const closeDockTerminalMock = vi.fn();
const moveTerminalToGridMock = vi.fn();

let mockActiveDockTerminalId: string | null = null;
let capturedOnOpenChange: ((open: boolean) => void) | null = null;
let capturedOnOpenAutoFocus: ((event: { preventDefault: () => void }) => void) | null = null;
let capturedOnFocusOutside: ((event: { preventDefault: () => void }) => void) | null = null;

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

vi.mock("../dockPanelPortalContext", () => ({
  useDockPanelPortal: () => vi.fn(),
}));

vi.mock("../useDockBlockedState", () => ({
  useDockBlockedState: () => null,
  getDockDisplayAgentState: () => undefined,
}));

vi.mock("../dockPopoverGuard", () => ({
  handleDockInteractOutside: vi.fn(),
  handleDockEscapeKeyDown: vi.fn(),
  handleDockFocusOutside: vi.fn(),
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

// Popover mock: captures the Radix callbacks (onOpenChange, onOpenAutoFocus,
// onFocusOutside) so tests can invoke them directly. Focus-driven dismissal is
// blocked at onFocusOutside, so the mock does not simulate a mount-time
// onOpenChange(false) — a close through onOpenChange now models a genuine
// pointer-outside / Escape dismissal.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    capturedOnOpenChange = onOpenChange ?? null;
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    onOpenAutoFocus,
    onFocusOutside,
  }: {
    children: React.ReactNode;
    onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
    onFocusOutside?: (event: { preventDefault: () => void }) => void;
  }) => {
    capturedOnOpenAutoFocus = onOpenAutoFocus ?? null;
    capturedOnFocusOutside = onFocusOutside ?? null;
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
import { handleDockFocusOutside } from "../dockPopoverGuard";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";

function makeTerminal(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "t-1",
    title: "Terminal",
    location: "dock",
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...overrides,
  } as PtyPanelData;
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
    capturedOnFocusOutside = null;
    vi.mocked(terminalInstanceService.focus).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wires onFocusOutside to the focus-dismissal guard and never closes on mount", () => {
    mockActiveDockTerminalId = "t-1";

    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    // Focus-driven dismissal is blocked at the PopoverContent boundary, not by a
    // timer/ref in handleOpenChange — so the just-opened popover never closes.
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
    expect(capturedOnFocusOutside).toBe(handleDockFocusOutside);
  });

  it("honors a genuine onOpenChange(false) close immediately", () => {
    mockActiveDockTerminalId = "t-1";

    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(capturedOnOpenChange).not.toBeNull();

    // A pointer-outside / Escape close reaches onOpenChange (focus closes are
    // intercepted upstream) and is honored with no delay or swallow window.
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

  it("suppresses Radix auto-focus and focuses the terminal once it migrates into the portal", async () => {
    mockActiveDockTerminalId = "t-1";
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(capturedOnOpenAutoFocus).not.toBeNull();

    // Radix's own auto-focus is blocked; nothing is focused until migration.
    const preventDefault = vi.fn();
    act(() => {
      capturedOnOpenAutoFocus?.({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(terminalInstanceService.focus).not.toHaveBeenCalled();

    // Simulate the terminal host being portaled into the popover target — the
    // MutationObserver detects the child insertion and focus follows.
    const portal = document.querySelector('[data-dock-portal-target="t-1"]');
    expect(portal).not.toBeNull();
    await act(async () => {
      const child = document.createElement("div");
      child.setAttribute("data-dock-panel-id", "t-1");
      portal!.appendChild(child);
      await Promise.resolve();
    });

    expect(terminalInstanceService.focus).toHaveBeenCalledWith("t-1");
  });

  it("does not focus an MCP-created dock terminal even after it migrates", async () => {
    mockActiveDockTerminalId = "t-1";
    render(
      <DockedTerminalItem
        terminal={makeTerminal({ id: "t-1", spawnedBy: "mcp", focusPolicy: "preserve" })}
      />
    );
    expect(capturedOnOpenAutoFocus).not.toBeNull();

    const preventDefault = vi.fn();
    act(() => {
      capturedOnOpenAutoFocus?.({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();

    const portal = document.querySelector('[data-dock-portal-target="t-1"]');
    await act(async () => {
      const child = document.createElement("div");
      child.setAttribute("data-dock-panel-id", "t-1");
      portal!.appendChild(child);
      await Promise.resolve();
    });

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
