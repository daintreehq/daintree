// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

// The design rules pinned here are the ones a future restyle could plausibly
// break without any behaviour test noticing: the two ribbon shells staying one
// shell, the centre row living in its own slot, one keycap and one icon-button
// treatment, the progress readout carrying real semantics, and the drafting
// preview describing what will actually be sent. Each asserts the rule, never
// the token — restyling every class in the surface should leave them green.

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useReducedMotion: () => false,
  };
});

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => null,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="fleet-selection-menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    destructive,
    textValue: _textValue,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    disabled?: boolean;
    destructive?: boolean;
    textValue?: string;
  } & React.HTMLAttributes<HTMLDivElement>) => (
    <div
      role="menuitem"
      {...rest}
      data-disabled={disabled ? "true" : undefined}
      data-destructive={destructive ? "true" : undefined}
      onClick={(e) => {
        if (disabled) return;
        onSelect?.(e.nativeEvent);
      }}
    >
      {children}
    </div>
  ),
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

import { FleetArmingRibbon } from "../FleetArmingRibbon";
import { FleetDraftingPill } from "../FleetDraftingPill";
import { SavedFleetRow } from "../SavedFleetRow";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetRunStore } from "@/store/fleetRunStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useFleetTargetOverridesStore } from "@/store/fleetTargetOverridesStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { _resetForTests as resetEscapeStack } from "@/lib/escapeStack";
import type { PtyPanelData } from "@shared/types/panel";

function makeAgent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...overrides,
  } as PtyPanelData;
}

function seed(panels: PtyPanelData[]): void {
  const panelsById: Record<string, PtyPanelData> = {};
  for (const p of panels) panelsById[p.id] = p;
  usePanelStore.setState({ panelsById, panelIds: panels.map((p) => p.id), focusedId: null });
}

function resetStores(): void {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    previewArmedIds: new Set<string>(),
  });
  useFleetPendingActionStore.setState({ pending: null });
  useFleetBroadcastProgressStore.setState({
    completed: 0,
    total: 0,
    failed: 0,
    isActive: false,
    cancelled: false,
  });
  useFleetRunStore.getState()._reset();
  useFleetResolutionPreviewStore.getState().clear();
  useFleetTargetOverridesStore.getState().clear();
  usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", isFleetScopeActive: false });
  resetEscapeStack();
}

const tokens = (el: Element): string[] => el.className.split(/\s+/).filter(Boolean);

describe("Fleet ribbon design invariants", () => {
  beforeEach(() => {
    resetStores();
    seed([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
  });

  it("the confirm-pending ribbon renders in the same shell as the armed ribbon", () => {
    const { unmount } = render(<FleetArmingRibbon />);
    const armed = tokens(screen.getByTestId("fleet-arming-ribbon"));
    unmount();

    useFleetPendingActionStore
      .getState()
      .request({ kind: "kill", targetCount: 3, sessionLossCount: 0 });
    render(<FleetArmingRibbon />);
    const confirm = tokens(screen.getByTestId("fleet-arming-ribbon"));

    // The two shells are the same shell. The armed branch may add only the
    // clipping and focus-suppression it needs for the slide-in; nothing else
    // may differ in either direction, or the heights drift apart again.
    const armedOnly = armed.filter((cls) => !confirm.includes(cls));
    const confirmOnly = confirm.filter((cls) => !armed.includes(cls));
    expect(confirmOnly).toEqual([]);
    expect(armedOnly.sort()).toEqual(["outline-hidden", "overflow-hidden"]);
    // And the shell is not trivially empty.
    expect(confirm.length).toBeGreaterThan(5);
  });

  it("transient centre content lives in its own slot between the membership anchor and the trailing controls", () => {
    useFleetBroadcastProgressStore.getState().init(8);
    useFleetBroadcastProgressStore.getState().advance(3, 0);
    useFleetRunStore.setState({
      run: {
        runId: "r",
        status: "watching",
        isRetry: false,
        draftPreview: "x",
        startedAt: 0,
        targets: [],
      },
    });
    vi.useFakeTimers();
    try {
      render(<FleetArmingRibbon />);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const ribbon = screen.getByTestId("fleet-arming-ribbon");
      const chip = screen.getByTestId("fleet-armed-count-chip");
      const progress = screen.getByTestId("fleet-broadcast-progress");
      const exit = screen.getByTestId("fleet-exit");
      const menu = screen.getByTestId("fleet-selection-menu-trigger");

      const areas = Array.from(ribbon.children).filter((c) => c.tagName === "DIV");
      const areaOf = (el: Element) => areas.find((a) => a.contains(el));

      expect(areaOf(chip)).toBeTruthy();
      expect(areaOf(progress)).toBeTruthy();
      expect(areaOf(exit)).toBeTruthy();
      // Three distinct areas, in DOM order: anchor, status, trailing.
      expect(areaOf(chip)).not.toBe(areaOf(progress));
      expect(areaOf(progress)).not.toBe(areaOf(exit));
      expect(areas.indexOf(areaOf(chip)!)).toBeLessThan(areas.indexOf(areaOf(progress)!));
      expect(areas.indexOf(areaOf(progress)!)).toBeLessThan(areas.indexOf(areaOf(exit)!));
      // The overflow menu is anchored with Exit, not with the status content.
      expect(areaOf(menu)).toBe(areaOf(exit));
      // The status slot is the flexible one; the anchors must not grow.
      expect(tokens(areaOf(progress)!)).toContain("flex-1");
      expect(tokens(areaOf(chip)!)).not.toContain("flex-1");
      expect(tokens(areaOf(exit)!)).not.toContain("flex-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the broadcast progress readout carries determinate progressbar semantics", () => {
    useFleetBroadcastProgressStore.getState().init(8);
    useFleetBroadcastProgressStore.getState().advance(3, 1);
    vi.useFakeTimers();
    try {
      render(<FleetArmingRibbon />);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const bar = screen.getByRole("progressbar");
      expect(bar.getAttribute("aria-valuenow")).toBe("3");
      expect(bar.getAttribute("aria-valuemax")).toBe("8");
      // `valuenow` counts attempts; the words count sends, so a failed attempt
      // is never announced as sent.
      expect(bar.getAttribute("aria-valuetext")).toMatch(/2 of 8 sent/);
      expect(bar.getAttribute("aria-valuetext")).toMatch(/1 failed/);
      act(() => {
        useFleetBroadcastProgressStore.getState().advance(2, 0);
      });
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("every keycap in the ribbon shares one treatment across both shells", () => {
    const { unmount } = render(<FleetArmingRibbon />);
    const armedKbd = Array.from(document.querySelectorAll("kbd")).map((k) => k.className);
    unmount();
    useFleetPendingActionStore
      .getState()
      .request({ kind: "restart", targetCount: 3, sessionLossCount: 1 });
    render(<FleetArmingRibbon />);
    const confirmKbd = Array.from(document.querySelectorAll("kbd")).map((k) => k.className);

    expect(armedKbd.length).toBeGreaterThan(0);
    expect(confirmKbd.length).toBeGreaterThan(1);
    const all = new Set([...armedKbd, ...confirmKbd]);
    expect(all.size).toBe(1);
  });

  it("glyph-only controls on the ribbon share one hit-area treatment", () => {
    useFleetRunStore.setState({
      run: {
        runId: "r",
        status: "completed",
        isRetry: false,
        draftPreview: "x",
        startedAt: 0,
        endedAt: 1,
        targets: [],
      },
    });
    render(<FleetArmingRibbon />);
    const buttons = [
      screen.getByTestId("fleet-leading-exit"),
      screen.getByTestId("fleet-run-dismiss"),
      screen.getByTestId("fleet-selection-menu-trigger"),
    ].map((b) => b.className);
    expect(new Set(buttons).size).toBe(1);
    // Fixed geometry, not padding around the glyph: a hit area has to be the
    // same size whichever icon sits inside it. `h-6` or `size-6`, never a
    // `min-h-*` that a taller icon could still stretch.
    expect(buttons[0]).toMatch(/(^|\s)(h-\d+|size-\d+)(\s|$)/);
    expect(buttons[0]).toMatch(/(^|\s)(w-\d+|size-\d+)(\s|$)/);
  });

  it("send failures in the status line are the only segments carrying an error tone", () => {
    useFleetRunStore.setState({
      run: {
        runId: "r",
        status: "watching",
        isRetry: false,
        draftPreview: "x",
        startedAt: 0,
        targets: [
          {
            terminalId: "a",
            title: "a",
            worktreeId: "wt-1",
            submission: "sent",
            agentState: "working",
            settled: false,
            gone: false,
          },
          {
            terminalId: "b",
            title: "b",
            worktreeId: "wt-1",
            submission: "failed",
            failureKind: "transient",
            agentState: null,
            settled: true,
            gone: false,
          },
        ],
      },
    });
    render(<FleetArmingRibbon />);
    const status = screen.getByTestId("fleet-run-status");
    // The segments are the children of the single text span; the icon and the
    // dismiss button sit beside it.
    const line = Array.from(status.children).find((c) => c.tagName === "SPAN")!;
    const segments = Array.from(line.children);
    const failed = segments.filter((s) => /failed/.test(s.textContent ?? ""));
    const rest = segments.filter((s) => !/failed/.test(s.textContent ?? ""));
    expect(failed.length).toBe(1);
    expect(rest.length).toBeGreaterThan(0);
    // Every neutral segment looks like every other neutral segment, and the
    // failed one looks like none of them.
    expect(new Set(rest.map((seg) => seg.className)).size).toBe(1);
    for (const seg of rest) expect(seg.className).not.toBe(failed[0]!.className);
    // The tone is carried by a glyph inside the failed segment, not only by a
    // colour on the words.
    expect(failed[0]!.querySelector("svg")).not.toBeNull();
    for (const seg of rest) expect(seg.querySelector("svg")).toBeNull();
  });

  it("a status line with no failures shows no error glyph", () => {
    useFleetRunStore.setState({
      run: {
        runId: "r",
        status: "watching",
        isRetry: false,
        draftPreview: "x",
        startedAt: 0,
        targets: [
          {
            terminalId: "a",
            title: "a",
            worktreeId: "wt-1",
            submission: "sent",
            agentState: "working",
            settled: false,
            gone: false,
          },
        ],
      },
    });
    render(<FleetArmingRibbon />);
    expect(screen.getByTestId("fleet-run-status").querySelector("svg")).toBeNull();
  });

  it("clearing the selection is not styled as destructive", () => {
    render(<FleetArmingRibbon />);
    const items = screen.getAllByRole("menuitem");
    const clear = items.find((i) => /Clear selection/.test(i.textContent ?? ""));
    expect(clear).toBeTruthy();
    expect(clear!.getAttribute("data-destructive")).toBeNull();
  });
});

describe("Fleet drafting preview invariants", () => {
  beforeEach(() => {
    resetStores();
  });

  it("the pill counts the peers a broadcast can reach, not fleet membership", () => {
    seed([
      makeAgent("p"),
      makeAgent("live"),
      makeAgent("dead", { hasPty: false, runtimeStatus: "exited" }),
    ]);
    usePanelStore.setState({ focusedId: "p" });
    useFleetArmingStore.getState().armIds(["p", "live", "dead"]);
    render(<FleetDraftingPill />);
    expect(screen.getByText(/Mirroring to 1 peer\b/)).toBeTruthy();
    expect(screen.queryByText(/Mirroring to 2 peers/)).toBeNull();
  });

  it("with focus outside the fleet every armed peer still counts", () => {
    // The pill only mounts on an armed, focused pane, so this is the harness
    // and preview shape — nothing is subtracted for an absent primary,
    // because no counted pane is the sender.
    seed([makeAgent("outsider"), makeAgent("q"), makeAgent("r")]);
    usePanelStore.setState({ focusedId: "outsider" });
    useFleetArmingStore.getState().armIds(["q", "r"]);
    render(<FleetDraftingPill />);
    expect(screen.getByText(/Mirroring to 2 peers/)).toBeTruthy();
  });

  it("the pill's reach excludes a peer the user has skipped, and stays mounted while the preview is open", () => {
    seed([makeAgent("p"), makeAgent("q"), makeAgent("r")]);
    usePanelStore.setState({ focusedId: "p" });
    useFleetArmingStore.getState().armIds(["p", "q", "r"]);
    useFleetResolutionPreviewStore.getState().setDraft("fix {{issue_number}}");
    render(<FleetDraftingPill />);
    const trigger = () => screen.getByTestId("fleet-drafting-pill-trigger");
    expect(trigger().textContent).toMatch(/Mirroring to 2 peers/);
    // The accessible name says the same thing the pixels do.
    expect(trigger().getAttribute("aria-label")).toMatch(/2 peers/);
    act(() => {
      useFleetTargetOverridesStore.getState().setSkipped("q", true);
    });
    expect(trigger().textContent).toMatch(/Mirroring to 1 peer\b/);
    act(() => {
      useFleetTargetOverridesStore.getState().setSkipped("r", true);
    });
    // Zero reach with the preview open: the pill must not vanish under the user.
    expect(trigger().textContent).toMatch(/Mirroring to 0 peers/);
  });

  it("an override that drops a variable also drops its unresolved warning", () => {
    seed([makeAgent("p"), makeAgent("q")]);
    useFleetArmingStore.getState().armIds(["p", "q"]);
    useFleetResolutionPreviewStore.getState().setDraft("fix {{issue_number}}");
    render(<FleetDraftingPill />);
    const rows = screen.getAllByTestId("fleet-resolution-row");
    expect(rows.length).toBe(2);
    const warnings = () =>
      rows.map((r) =>
        Array.from(r.querySelectorAll("span")).some((s) => /unresolved/.test(s.textContent ?? ""))
      );
    expect(warnings()).toEqual([true, true]);
    act(() => {
      useFleetTargetOverridesStore.getState().setPayloadOverride("q", "fix it by hand");
    });
    expect(warnings()).toEqual([true, false]);
    act(() => {
      useFleetTargetOverridesStore.getState().setPayloadOverride("q", "fix {{issue_number}} later");
    });
    expect(warnings()).toEqual([true, true]);
  });

  it("a skipped row keeps its include control fully actionable while its content recedes", () => {
    seed([makeAgent("p"), makeAgent("q")]);
    useFleetArmingStore.getState().armIds(["p", "q"]);
    useFleetResolutionPreviewStore.getState().setDraft("fix {{issue_number}}");
    render(<FleetDraftingPill />);
    act(() => {
      useFleetTargetOverridesStore.getState().setSkipped("q", true);
    });
    const row = screen.getAllByTestId("fleet-resolution-row")[1]!;
    const include = screen.getAllByTestId("fleet-resolution-row-include")[1]!;
    expect(row.getAttribute("data-skipped")).toBe("true");
    // Nothing between the row and the control dims it. Only an unconditional
    // opacity counts — the control's own `disabled:` variant is inert here.
    const dimmed = /(^|\s)opacity-/;
    let el: HTMLElement | null = include;
    while (el && el !== row) {
      expect(el.className).not.toMatch(dimmed);
      el = el.parentElement;
    }
    expect(row.className).not.toMatch(dimmed);
    expect(include.hasAttribute("disabled")).toBe(false);
  });
});

describe("Saved fleet row invariants", () => {
  it("a stale snapshot fades its recall content but never its delete control", () => {
    const scope = {
      kind: "snapshot" as const,
      id: "s",
      name: "old",
      terminalIds: ["gone"],
      createdAt: 0,
    };
    const { unmount } = render(
      <SavedFleetRow scope={scope} onRequestDelete={() => {}} count={0} isStale />
    );
    const staleRow = screen.getByTestId("fleet-saved-row");
    const staleDelete = screen.getByTestId("fleet-saved-row-delete");
    // Stale means "cannot recall", never "menu item disabled" — Radix would dim
    // and block every descendant, Delete included.
    expect(staleRow.getAttribute("data-disabled")).toBeNull();
    expect(staleRow.className).not.toMatch(/opacity-/);
    expect(staleDelete.className).not.toMatch(/opacity-/);
    const fadedText = Array.from(staleRow.querySelectorAll("span")).filter((s) =>
      /opacity-/.test(s.className)
    );
    expect(fadedText.length).toBeGreaterThan(0);
    unmount();

    render(<SavedFleetRow scope={scope} onRequestDelete={() => {}} count={2} isStale={false} />);
    expect(screen.getByTestId("fleet-saved-row-delete").className).toBe(staleDelete.className);
    const delegate = vi.fn();
    render(<SavedFleetRow scope={scope} onRequestDelete={delegate} count={0} isStale />);
    fireEvent.click(screen.getAllByTestId("fleet-saved-row-delete")[1]!);
    expect(delegate).toHaveBeenCalledWith("s");
  });
});
