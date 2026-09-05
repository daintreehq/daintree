// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const suppressMock = vi.hoisted(() => vi.fn());
const getPanelStateMock = vi.hoisted(() => vi.fn());
const getWorktreeSelectionStateMock = vi.hoisted(() => vi.fn());
const getHelpPanelStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: {
    suppressResizesDuringLayoutTransition: suppressMock,
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: getPanelStateMock },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: getWorktreeSelectionStateMock },
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: { getState: getHelpPanelStateMock },
  selectActiveSlot: (s: { terminalId: string | null }) => s,
  selectSlotTerminalIds: (s: { terminalId: string | null }) =>
    s.terminalId ? [s.terminalId] : [],
}));

import {
  signalDiagnosticsDockLayoutChange,
  subscribeDiagnosticsDockLayoutChange,
  __resetDiagnosticsDockLayoutForTests,
} from "../diagnosticsDockLayout";
import { DIAGNOSTICS_DOCK_TRANSITION_MS } from "../terminalLayout";

describe("diagnostics dock layout signal (issue #12264)", () => {
  beforeEach(() => {
    __resetDiagnosticsDockLayoutForTests();
    suppressMock.mockClear();
    getWorktreeSelectionStateMock.mockReturnValue({ activeWorktreeId: "wt-active" });
    getHelpPanelStateMock.mockReturnValue({ terminalId: null });
    getPanelStateMock.mockReturnValue({
      panelIds: ["grid-a", "grid-b", "grid-other", "docked"],
      panelsById: {
        "grid-a": { id: "grid-a", location: "grid", worktreeId: "wt-active" },
        "grid-b": { id: "grid-b", location: "grid", worktreeId: "wt-active" },
        "grid-other": { id: "grid-other", location: "grid", worktreeId: "wt-background" },
        docked: { id: "docked", location: "dock", worktreeId: "wt-active" },
        // The assistant is only picked up once its panel is registered.
        "assistant-1": { id: "assistant-1", location: "dock", worktreeId: "wt-active" },
      },
    });
  });

  afterEach(() => {
    __resetDiagnosticsDockLayoutForTests();
  });

  it("notifies every subscriber when the dock geometry commits", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeDiagnosticsDockLayoutChange(first);
    subscribeDiagnosticsDockLayoutChange(second);

    signalDiagnosticsDockLayoutChange();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops notifying once a subscriber disposes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDiagnosticsDockLayoutChange(listener);

    signalDiagnosticsDockLayoutChange();
    unsubscribe();
    signalDiagnosticsDockLayoutChange();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("suppresses PTY resizes for the dock transition window on the affected panes", () => {
    // The corrective refit for the reflow is this lock's unlock pass — a resize
    // dropped while it is armed is skipped, not deferred, so the pass is the
    // only thing that gives every terminal its settled post-dock size.
    getHelpPanelStateMock.mockReturnValue({ terminalId: "assistant-1" });

    signalDiagnosticsDockLayoutChange();

    expect(suppressMock).toHaveBeenCalledTimes(1);
    const [ids, durationMs] = suppressMock.mock.calls[0]!;
    // Grid panes on the active worktree plus the assistant — the same set a
    // sidebar transition covers, because the same `<main>` row reflows.
    expect(ids).toEqual(["grid-a", "grid-b", "assistant-1"]);
    expect(durationMs).toBe(DIAGNOSTICS_DOCK_TRANSITION_MS);
  });

  it("keeps the transition window pegged to the dock's CSS height transition", () => {
    // index.css `.diagnostics-dock { transition: height 200ms }` — a corrective
    // pass shorter than the animation would measure a mid-transition box.
    expect(DIAGNOSTICS_DOCK_TRANSITION_MS).toBe(200);
  });

  it("isolates subscribers from each other's failures", () => {
    const failing = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const healthy = vi.fn();
    subscribeDiagnosticsDockLayoutChange(failing);
    subscribeDiagnosticsDockLayoutChange(healthy);

    expect(() => signalDiagnosticsDockLayoutChange()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("tolerates a subscriber unsubscribing during the notification pass", () => {
    const later = vi.fn();
    let disposeLater: (() => void) | undefined;
    subscribeDiagnosticsDockLayoutChange(() => disposeLater?.());
    disposeLater = subscribeDiagnosticsDockLayoutChange(later);

    expect(() => signalDiagnosticsDockLayoutChange()).not.toThrow();
    // The snapshot means the already-queued listener still runs this pass, but
    // it must be gone from the next one.
    later.mockClear();
    signalDiagnosticsDockLayoutChange();
    expect(later).not.toHaveBeenCalled();
  });
});
