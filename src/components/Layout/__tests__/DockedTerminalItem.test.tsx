// @vitest-environment jsdom
/**
 * DockedTerminalItem — move-to-grid gesture.
 *
 * The single docked chip moves to the grid via double-click (the dedicated
 * reveal-on-hover button was removed; move-to-grid also remains reachable via
 * the right-click context menu). These tests drive the double-click through a
 * render harness (no source-string assertions) and verify the store wiring: the
 * dock popover only closes when moveTerminalToGrid succeeds.
 */
import { beforeAll, describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { UI_TRANSIENT_HINT_DWELL_MS } from "@/lib/animationUtils";

const openDockTerminalMock = vi.fn();
const closeDockTerminalMock = vi.fn();
const moveTerminalToGridMock = vi.fn();

let mockActiveDockTerminalId: string | null = null;
let mockDockAgentState: string | undefined = undefined;
let mockIsAgent = false;
let mockPluginActivity: { pluginId: string; shown: string; description: string } | null = null;
let mockDeprioritized = false;
let mockShowDockHighlights = false;
// What the chip's amber edge was asked to debounce: only a `needs-you` glyph.
let blockedStateArg: string | undefined = undefined;
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
  useTerminalInputStore: Object.assign(
    (selector: (s: { hybridInputEnabled: boolean; hybridInputAutoFocus: boolean }) => unknown) =>
      selector({ hybridInputEnabled: false, hybridInputAutoFocus: false }),
    { getState: () => ({ hybridInputEnabled: false, hybridInputAutoFocus: false }) }
  ),
  usePortalStore: (selector: (s: { isOpen: boolean; width: number }) => unknown) =>
    selector({ isOpen: false, width: 0 }),
  useFocusStore: (
    selector: (s: { isFocusMode: boolean; gestureSidebarHidden: boolean }) => unknown
  ) => selector({ isFocusMode: false, gestureSidebarHidden: false }),
  usePreferencesStore: (selector: (s: { showDockAgentHighlights: boolean }) => unknown) =>
    selector({ showDockAgentHighlights: mockShowDockHighlights }),
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

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    fit: () => ({ cols: 80, rows: 24 }),
    applyRendererPolicy: vi.fn(),
    focus: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});

// The badge hook reads the real panel and plugin stores; these suites stub the store layer.
vi.mock("../DockChipBadge", () => ({
  useDockChipBadge: () => null,
  DockChipBadge: () => null,
}));

// The activity hook reads the real panel, registry and plugin stores too.
vi.mock("@/components/Panel/PluginPanelActivity", () => ({
  usePluginPanelActivity: () => mockPluginActivity,
  PluginPanelActivityDockCue: ({ activity }: { activity: { shown: string } }) => (
    <span data-plugin-panel-activity={activity.shown} />
  ),
  pluginPanelActivityLabelSuffix: (activity: { description: string } | null) =>
    activity ? ` — ${activity.description}` : "",
}));

vi.mock("../dockPanelPortalContext", () => ({
  useDockPanelPortal: () => vi.fn(),
}));

vi.mock("../useDockBlockedState", () => ({
  useDockBlockedState: (state: string | undefined) => {
    blockedStateArg = state;
    return null;
  },
  getDockDisplayAgentState: () => mockDockAgentState,
  isDockAgentStateDeprioritized: () => mockDeprioritized,
}));

vi.mock("../dockPopoverGuard", () => ({
  handleDockInteractOutside: vi.fn(),
  handleDockEscapeKeyDown: vi.fn(),
  handleDockFocusOutside: vi.fn(),
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({ isAgent: mockIsAgent, color: "#abc" }),
}));

vi.mock("@/components/Worktree/terminalStateConfig", () => ({
  getEffectiveStateIcon: () => null,
  getEffectiveStateColor: () => "",
  getEffectiveStateLabel: (state: string) => state,
  SESSION_ICONS: {},
  SESSION_COLORS: {},
  SESSION_LABELS: {},
}));

// The real band read and resolver; the pane observation half reads the real
// panel store, whose import graph this suite's mocks don't cover.
vi.mock("@/hooks/useRunSessionPresentation", async () => {
  const { useRunFleetBand } = await import("@/hooks/useRunFleetBand");
  const { resolvePaneSessionPresentation } = await import("@/lib/paneSessionPresentation");
  return {
    useRunSessionPresentation: (id: string, state: Parameters<typeof resolvePaneSessionPresentation>[0]) =>
      resolvePaneSessionPresentation(state, useRunFleetBand(id)),
  };
});

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-testid="terminal-icon" />,
}));

vi.mock("@/components/Terminal/terminalFocus", () => ({
  getTerminalFocusTarget: ({ preferredTarget }: { preferredTarget?: string }) =>
    preferredTarget ?? "terminal",
}));

let mockRequestedSurface: string | null = null;
let mockHeldSurface: string | null = null;
vi.mock("@/components/Terminal/paneFocusRequest", () => ({
  requestedPaneSurface: () => mockRequestedSurface,
  paneSurfaceHoldingFocus: () => mockHeldSurface,
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
import { DragHandleProvider } from "@/components/DragDrop/DragHandleContext";
import { handleDockFocusOutside } from "../dockPopoverGuard";
import { createTerminalPaintPlane } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";

const terminalInstanceService = createTerminalPaintPlane();

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

describe("DockedTerminalItem move-to-grid gesture", () => {
  beforeEach(() => {
    openDockTerminalMock.mockReset();
    closeDockTerminalMock.mockReset();
    moveTerminalToGridMock.mockReset();
    mockActiveDockTerminalId = null;
    mockDockAgentState = undefined;
    mockIsAgent = false;
    blockedStateArg = undefined;
    useFleetSnapshotStore.setState({ snapshot: null });
  });

  // Amber is the fleet band's needs-you alone (#16057): a prompt that asks
  // nothing never edges the chip, and an unread Canopy ask does.
  it("edges the chip only for an unread Canopy ask, never a bare prompt", () => {
    mockDockAgentState = "waiting";
    mockIsAgent = true;
    const view = render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(blockedStateArg).toBeUndefined();

    act(() => {
      useFleetSnapshotStore.getState().applySnapshot({
        runs: [
          {
            runId: "t-1",
            workspaceId: "p1",
            spawnedAt: 1,
            cwd: "/repo",
            agentState: "waiting",
            canopy: { kind: "asked", quote: "Run it?", readAt: 1, seen: false },
          },
        ],
        changedAt: 2,
        degraded: false,
        lastSuccessfulAt: 2,
      });
    });
    expect(blockedStateArg).toBe("waiting");
    view.unmount();
  });

  // #10024 — the dock chip's state icon is aria-hidden, so the agent state must
  // be carried in the button's accessible name for screen-reader users.
  it("announces the agent state in the chip aria-label when an agent is active", () => {
    mockDockAgentState = "working";
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(screen.getByRole("button", { name: /— agent working/ })).not.toBeNull();
  });

  // The glyph shows an idle agent as waiting so the indicator never drops out;
  // the accessible name must still report what was observed.
  it("names an idle agent idle, not waiting", () => {
    mockDockAgentState = "idle";
    mockIsAgent = true;
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(screen.getByRole("button", { name: /— agent idle/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /waiting/ })).toBeNull();
  });

  it("omits agent state from the chip aria-label for a plain shell", () => {
    mockDockAgentState = undefined;
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(screen.queryByRole("button", { name: /agent/i })).toBeNull();
  });

  it("moves the terminal to the grid on double-click and closes the dock on success", () => {
    moveTerminalToGridMock.mockReturnValue(true);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    const chip = screen.getByRole("button", { name: /double-click to move to grid/i });
    fireEvent.doubleClick(chip);

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("does not close the dock popover when the move is rejected", () => {
    moveTerminalToGridMock.mockReturnValue(false);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    const chip = screen.getByRole("button", { name: /double-click to move to grid/i });
    fireEvent.doubleClick(chip);

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
  });
});

// #10797 — the chip showed grab-cursor styling but never consumed the drag
// listeners SortableDockItem publishes via DragHandleProvider, so it wasn't a
// functional drag source. The fix forwards the pointer/touch listeners but
// deliberately drops the KeyboardSensor's onKeyDown: the chip is its own preview
// trigger, so Space/Enter must keep opening the preview rather than being
// hijacked into a keyboard drag pickup.
describe("DockedTerminalItem drag wiring", () => {
  beforeEach(() => {
    mockActiveDockTerminalId = null;
    mockDockAgentState = undefined;
  });

  it("forwards pointer drag events from the chip to the dnd listeners", () => {
    const onMouseDown = vi.fn();
    render(
      <DragHandleProvider value={{ listeners: { onMouseDown }, setActivatorNodeRef: vi.fn() }}>
        <DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />
      </DragHandleProvider>
    );

    const chip = screen.getByRole("button", { name: /drag to reorder/i });
    fireEvent.mouseDown(chip);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
  });

  it("does not wire the keyboard-drag listener onto the chip (Space/Enter stays for preview)", () => {
    const onKeyDown = vi.fn();
    render(
      <DragHandleProvider value={{ listeners: { onKeyDown }, setActivatorNodeRef: vi.fn() }}>
        <DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />
      </DragHandleProvider>
    );

    const chip = screen.getByRole("button", { name: /drag to reorder/i });
    fireEvent.keyDown(chip, { key: "Enter" });
    fireEvent.keyDown(chip, { key: " " });
    // The KeyboardSensor's onKeyDown would call preventDefault() and start a drag
    // pickup, suppressing the native button click that opens the preview. It must
    // not be forwarded onto the chip.
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

// #11187 — plain (non-agent) terminals must show a running/finished affordance
// on their dock chip. The real useDockActivityState helper/hook run here (only
// useDockBlockedState is mocked); deriveTerminalChrome is mocked to isAgent:false
// so these terminals resolve as plain.
describe("DockedTerminalItem plain-terminal activity cue (#11187)", () => {
  beforeEach(() => {
    mockActiveDockTerminalId = null;
    mockDockAgentState = undefined;
    mockPluginActivity = null;
  });

  it("gives a PTY plugin panel's own report the cue slot and the accessible name (#13820)", () => {
    mockPluginActivity = {
      pluginId: "acme",
      shown: "waiting",
      description: "Reported by Acme: Waiting — Pick a branch",
    };
    const { container } = render(
      <DockedTerminalItem terminal={makeTerminal({ id: "t-1", activityStatus: "working" })} />
    );
    expect(container.querySelector('[data-plugin-panel-activity="waiting"]')).not.toBeNull();
    expect(container.querySelector("[data-dock-activity-state]")).toBeNull();
    expect(
      screen.getByRole("button", { name: /— Reported by Acme: Waiting — Pick a branch/ })
    ).not.toBeNull();
  });

  it("keeps a plain PTY plugin panel's chip un-dimmed while its plugin reports it waiting", () => {
    mockDeprioritized = true;
    mockShowDockHighlights = true;
    try {
      const resting = render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
      const restingChip = resting.container.querySelector("[data-dock-item]");
      expect(restingChip?.className).toContain("border-transparent");
      resting.unmount();

      mockPluginActivity = {
        pluginId: "acme",
        shown: "waiting",
        description: "Reported by Acme: Waiting",
      };
      const waiting = render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
      const chip = waiting.container.querySelector("[data-dock-item]");
      expect(chip?.className).not.toContain("border-transparent");
      expect(chip?.className).not.toBe(restingChip?.className);
    } finally {
      mockDeprioritized = false;
      mockShowDockHighlights = false;
    }
  });

  it("never lets a plugin's report displace an observed agent state", () => {
    mockDockAgentState = "working";
    mockPluginActivity = {
      pluginId: "acme",
      shown: "failed",
      description: "Reported by Acme: Failed",
    };
    const { container } = render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(container.querySelector("[data-plugin-panel-activity]")).toBeNull();
    expect(screen.getByRole("button", { name: /— agent working/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Reported by/ })).toBeNull();
  });

  it("shows a running spinner and 'command running' accessible name while a plain command runs", () => {
    const { container } = render(
      <DockedTerminalItem terminal={makeTerminal({ id: "t-1", activityStatus: "working" })} />
    );
    expect(container.querySelector('[data-dock-activity-state="working"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: /command running/ })).not.toBeNull();
  });

  it("shows no cue for an idle plain terminal that never transitioned from working", () => {
    const { container } = render(
      <DockedTerminalItem terminal={makeTerminal({ id: "t-1", activityStatus: "success" })} />
    );
    expect(container.querySelector("[data-dock-activity-state]")).toBeNull();
    expect(screen.queryByRole("button", { name: /command running/ })).toBeNull();
  });

  it("yields the indicator slot to an active agent state (no plain cue on agent chips)", () => {
    mockDockAgentState = "working";
    const { container } = render(
      <DockedTerminalItem terminal={makeTerminal({ id: "t-1", activityStatus: "working" })} />
    );
    expect(container.querySelector("[data-dock-activity-state]")).toBeNull();
  });

  it("flashes a finished cue on working→success, then clears it after the dwell", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <DockedTerminalItem terminal={makeTerminal({ id: "t-1", activityStatus: "working" })} />
      );
      expect(container.querySelector('[data-dock-activity-state="working"]')).not.toBeNull();

      rerender(
        <DockedTerminalItem terminal={makeTerminal({ id: "t-1", activityStatus: "success" })} />
      );
      const finished = container.querySelector('[data-dock-activity-state="finished"]');
      expect(finished).not.toBeNull();
      // A visible glyph, not just an empty wrapper.
      expect(finished!.querySelector("svg")).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(UI_TRANSIENT_HINT_DWELL_MS);
      });
      expect(container.querySelector('[data-dock-activity-state="finished"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * DockedTerminalItem — focus-driven dismissal guard (#6602).
 *
 * Radix's DismissableLayer fires a focus-outside dismissal while a just-opened
 * dock popover's terminal is still migrating into the portal (focus transiently
 * leaves the layer). The fix blocks that path at PopoverContent's onFocusOutside
 * (preventDefault), so genuine pointer-outside / Escape closes still reach
 * onOpenChange and are honored. Focus is moved into the terminal once the
 * popover container ref settles and its stable wrapper has been moved in — a
 * synchronous step, no MutationObserver, no fixed timer.
 */
describe("DockedTerminalItem mount-time close guard (#6602)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openDockTerminalMock.mockClear();
    closeDockTerminalMock.mockClear();
    moveTerminalToGridMock.mockClear();
    mockActiveDockTerminalId = null;
    mockDockAgentState = undefined;
    mockIsAgent = false;
    capturedOnOpenChange = null;
    capturedOnOpenAutoFocus = null;
    capturedOnFocusOutside = null;
    mockRequestedSurface = null;
    mockHeldSurface = null;
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

  it("suppresses Radix auto-focus and focuses the terminal once its wrapper is moved in", () => {
    mockActiveDockTerminalId = "t-1";
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(capturedOnOpenAutoFocus).not.toBeNull();

    // Radix's own auto-focus is blocked; we focus the terminal ourselves.
    const preventDefault = vi.fn();
    act(() => {
      capturedOnOpenAutoFocus?.({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();

    // The popover container ref settles synchronously on mount, so the stable
    // wrapper is moved in and the terminal is focused — no MutationObserver.
    expect(terminalInstanceService.focus).toHaveBeenCalledWith("t-1");
  });

  // A drop or type-anywhere that asked the pane for its hybrid input; focusing
  // the terminal here would end that ask before the bar could take it.
  it("leaves the keyboard to a hybrid input the pane was asked for", () => {
    mockActiveDockTerminalId = "t-1";
    mockRequestedSurface = "hybridInput";
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    expect(terminalInstanceService.focus).not.toHaveBeenCalled();
  });

  // What the user does inside the pane stays inside it: the focus pass re-runs
  // on chrome changes, and must not pull the keyboard out of the input bar for
  // a terminal home.
  it("leaves the keyboard on a hybrid input that holds it", () => {
    mockActiveDockTerminalId = "t-1";
    mockHeldSurface = "hybridInput";
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    expect(terminalInstanceService.focus).not.toHaveBeenCalled();
  });

  it("does not focus an MCP-created dock terminal", () => {
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

    // focusPolicy "preserve" short-circuits the focus effect even though the
    // wrapper is moved into the popover.
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
    mockDockAgentState = undefined;
    mockIsAgent = false;
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
