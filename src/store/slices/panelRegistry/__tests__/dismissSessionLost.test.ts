/**
 * Durable dismissal of the "Session no longer reachable" banner (#11589).
 *
 * The banner is driven by `sessionLostOnRestore` on the panel. Dismissal used
 * to live in `TerminalPane` component state, which a worktree switch destroys
 * (the grid renders only the active worktree's panels), so the banner came
 * back. Dismissal now consumes the signal in the store instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { saveNormalized } = await import("../persistence");

function ptyPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    ...overrides,
  } as PtyPanelData;
}

/**
 * A non-PTY panel. `sessionLostOnRestore` isn't part of the browser shape, so
 * the overrides are intentionally untyped — the point of these fixtures is to
 * prove the actions narrow on `isPtyPanel` rather than on the field's presence.
 */
function browserPanel(id: string, overrides: Record<string, unknown> = {}): PanelInstance {
  return {
    id,
    kind: "browser",
    title: id,
    location: "grid",
    ...overrides,
  } as PanelInstance;
}

function seed(panels: PanelInstance[], panelIds?: string[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panelIds ?? panels.map((p) => p.id),
  });
}

function signalOf(id: string): boolean | undefined {
  return (usePanelStore.getState().panelsById[id] as PtyPanelData | undefined)
    ?.sessionLostOnRestore;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("dismissSessionLost", () => {
  it("consumes the signal so a remount can't resurface the banner", () => {
    seed([ptyPanel("t-1", { sessionLostOnRestore: true })]);

    usePanelStore.getState().dismissSessionLost("t-1");

    expect(signalOf("t-1")).toBeUndefined();
  });

  it("leaves other flagged panels alone", () => {
    seed([
      ptyPanel("t-1", { sessionLostOnRestore: true }),
      ptyPanel("t-2", { sessionLostOnRestore: true }),
    ]);

    usePanelStore.getState().dismissSessionLost("t-1");

    expect(signalOf("t-1")).toBeUndefined();
    expect(signalOf("t-2")).toBe(true);
  });

  // Whole-object equality, not a sampled field list: an implementation that
  // rebuilt the panel and dropped unrelated fields would pass a spot check.
  it("changes nothing on the panel but the consumed signal", () => {
    const before = ptyPanel("t-1", {
      sessionLostOnRestore: true,
      agentState: "working",
      exitCode: 3,
      isRestarting: true,
      worktreeId: "wt-a",
      agentSessionId: "sess-9",
    });
    seed([before]);

    usePanelStore.getState().dismissSessionLost("t-1");

    const after = usePanelStore.getState().panelsById["t-1"] as PtyPanelData;
    const { sessionLostOnRestore: _dropped, ...expected } = before as PtyPanelData;
    expect(after).toEqual({ ...expected, sessionLostOnRestore: undefined });
  });

  // Zustand 5 only notifies subscribers when the returned root fails Object.is
  // against the previous state, so an in-place mutation would leave every value
  // assertion above green while the banner stayed on screen.
  it("writes immutably so subscribers are notified", () => {
    const before = ptyPanel("t-1", { sessionLostOnRestore: true });
    seed([before]);
    const carrierBefore = usePanelStore.getState().panelsById;

    const notified = vi.fn();
    const unsubscribe = usePanelStore.subscribe(notified);
    usePanelStore.getState().dismissSessionLost("t-1");
    unsubscribe();

    expect(notified).toHaveBeenCalledTimes(1);
    expect(usePanelStore.getState().panelsById).not.toBe(carrierBefore);
    expect(usePanelStore.getState().panelsById["t-1"]).not.toBe(before);
    expect(before.sessionLostOnRestore).toBe(true);
  });

  it("is a no-op for an unknown id", () => {
    seed([ptyPanel("t-1", { sessionLostOnRestore: true })]);
    const before = usePanelStore.getState().panelsById;

    usePanelStore.getState().dismissSessionLost("nope");

    expect(usePanelStore.getState().panelsById).toBe(before);
  });

  it("keeps the same carrier identity when the panel was never flagged", () => {
    seed([ptyPanel("t-1")]);
    const before = usePanelStore.getState().panelsById;

    usePanelStore.getState().dismissSessionLost("t-1");

    expect(usePanelStore.getState().panelsById).toBe(before);
  });

  it("keeps the same carrier identity on a repeat dismissal", () => {
    seed([ptyPanel("t-1", { sessionLostOnRestore: true })]);
    usePanelStore.getState().dismissSessionLost("t-1");
    const afterFirst = usePanelStore.getState().panelsById;

    usePanelStore.getState().dismissSessionLost("t-1");

    expect(usePanelStore.getState().panelsById).toBe(afterFirst);
  });

  it("ignores a non-PTY panel", () => {
    seed([browserPanel("b-1", { sessionLostOnRestore: true })]);
    const before = usePanelStore.getState().panelsById;

    usePanelStore.getState().dismissSessionLost("b-1");

    expect(usePanelStore.getState().panelsById).toBe(before);
  });

  // The signal is deliberately excluded from the persisted snapshot, so
  // consuming it must not schedule a write.
  it("does not persist", () => {
    seed([ptyPanel("t-1", { sessionLostOnRestore: true })]);

    usePanelStore.getState().dismissSessionLost("t-1");

    expect(saveNormalized).not.toHaveBeenCalled();
  });
});

describe("dismissAllSessionLost", () => {
  it("clears every flagged panel regardless of worktree, keeping them all", () => {
    seed([
      ptyPanel("t-1", { sessionLostOnRestore: true, worktreeId: "wt-a" }),
      ptyPanel("t-2", { sessionLostOnRestore: true, worktreeId: "wt-b" }),
      ptyPanel("t-3", { sessionLostOnRestore: true, worktreeId: undefined }),
    ]);

    usePanelStore.getState().dismissAllSessionLost();

    expect(signalOf("t-1")).toBeUndefined();
    expect(signalOf("t-2")).toBeUndefined();
    expect(signalOf("t-3")).toBeUndefined();
    // Consuming the signal must not consume the panels: deleting them outright
    // would satisfy the assertions above.
    expect(Object.keys(usePanelStore.getState().panelsById).sort()).toEqual(["t-1", "t-2", "t-3"]);
  });

  // One notification for the whole sweep, and every flagged panel replaced
  // rather than edited: a single notification alone would still be emitted by
  // an implementation that mutated each panel in place and then handed back a
  // fresh carrier, which React memo boundaries reading a panel would miss.
  it("notifies once and replaces each flagged panel object", () => {
    const before = [
      ptyPanel("t-1", { sessionLostOnRestore: true }),
      ptyPanel("t-2", { sessionLostOnRestore: true }),
      ptyPanel("t-3", { sessionLostOnRestore: true }),
    ];
    seed(before);

    const notified = vi.fn();
    const unsubscribe = usePanelStore.subscribe(notified);
    usePanelStore.getState().dismissAllSessionLost();
    unsubscribe();

    expect(notified).toHaveBeenCalledTimes(1);
    for (const panel of before) {
      expect(usePanelStore.getState().panelsById[panel.id]).not.toBe(panel);
      expect(panel.sessionLostOnRestore).toBe(true);
    }
  });

  // A hydration/spawn batch publishes `panelsById` before appending ids
  // (#9655), and a post-restart burst is exactly when this action gets used —
  // so it must scan the carrier, not the ordered id list.
  it("clears a panel that is not in panelIds yet", () => {
    seed(
      [
        ptyPanel("t-1", { sessionLostOnRestore: true }),
        ptyPanel("t-batched", { sessionLostOnRestore: true }),
      ],
      ["t-1"]
    );

    usePanelStore.getState().dismissAllSessionLost();

    expect(signalOf("t-batched")).toBeUndefined();
  });

  it("clears panels parked outside the grid", () => {
    seed([
      ptyPanel("t-dock", { sessionLostOnRestore: true, location: "dock" }),
      ptyPanel("t-trash", { sessionLostOnRestore: true, location: "trash" }),
    ]);

    usePanelStore.getState().dismissAllSessionLost();

    expect(signalOf("t-dock")).toBeUndefined();
    expect(signalOf("t-trash")).toBeUndefined();
  });

  it("leaves unflagged panels untouched by identity", () => {
    const untouched = ptyPanel("t-2");
    seed([ptyPanel("t-1", { sessionLostOnRestore: true }), untouched]);

    usePanelStore.getState().dismissAllSessionLost();

    expect(usePanelStore.getState().panelsById["t-2"]).toBe(untouched);
  });

  it("wakes no subscriber when nothing is flagged", () => {
    seed([ptyPanel("t-1"), ptyPanel("t-2")]);
    const before = usePanelStore.getState().panelsById;

    const notified = vi.fn();
    const unsubscribe = usePanelStore.subscribe(notified);
    usePanelStore.getState().dismissAllSessionLost();
    unsubscribe();

    expect(notified).not.toHaveBeenCalled();
    expect(usePanelStore.getState().panelsById).toBe(before);
  });

  it("is idempotent", () => {
    seed([
      ptyPanel("t-1", { sessionLostOnRestore: true }),
      ptyPanel("t-2", { sessionLostOnRestore: true }),
    ]);
    usePanelStore.getState().dismissAllSessionLost();
    const afterFirst = usePanelStore.getState().panelsById;

    usePanelStore.getState().dismissAllSessionLost();

    expect(usePanelStore.getState().panelsById).toBe(afterFirst);
  });

  it("skips non-PTY panels", () => {
    const browser = browserPanel("b-1", { sessionLostOnRestore: true });
    seed([ptyPanel("t-1", { sessionLostOnRestore: true }), browser]);

    usePanelStore.getState().dismissAllSessionLost();

    expect(signalOf("t-1")).toBeUndefined();
    expect(usePanelStore.getState().panelsById["b-1"]).toBe(browser);
  });

  it("does not persist", () => {
    seed([ptyPanel("t-1", { sessionLostOnRestore: true })]);

    usePanelStore.getState().dismissAllSessionLost();

    expect(saveNormalized).not.toHaveBeenCalled();
  });
});
