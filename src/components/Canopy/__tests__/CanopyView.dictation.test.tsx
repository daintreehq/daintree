// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { VoiceRecordingTarget } from "@/store/voiceRecordingStore";

// A dictation into a reply belongs to its row, not to whatever Canopy shows
// (#14778): closing Canopy or moving on leaves it writing there, and the
// indicator's way back reopens Canopy on that row with the keyboard in its reply.

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

type ComposerProps = { terminalId: string; voiceTarget?: VoiceRecordingTarget };
const { composers, dictationFocus } = vi.hoisted(() => ({
  composers: new Map<string, ComposerProps>(),
  dictationFocus: vi.fn((_runId: string) => {}),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true })) },
}));
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: ({ runId }: { runId: string }) => (
    <div data-canopy-terminal="" data-run={runId}>
      <textarea aria-label="Terminal input" />
    </div>
  ),
}));
// The reply's editor is a lazy chunk; here only who it is and where the keyboard is sent matter.
vi.mock("@/components/Terminal/HybridInputBar", async () => {
  const { useEffect, useImperativeHandle } = await import("react");
  return {
    HybridInputBar: (
      props: ComposerProps & {
        ref?: React.Ref<{ focus: () => void; focusForDictation: () => void }>;
      }
    ) => {
      useEffect(() => {
        composers.set(props.terminalId, props);
        return () => {
          composers.delete(props.terminalId);
        };
      });
      useImperativeHandle(props.ref, () => ({
        focus: () => {},
        focusForDictation: () => dictationFocus(props.terminalId),
      }));
      return <div data-testid="composer" data-run={props.terminalId} />;
    },
  };
});
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { CanopyView } from "../CanopyView";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";

const NOW = Date.now();

function run(runId: string, overrides: Partial<FleetSnapshot["runs"][number]> = {}) {
  return {
    runId,
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo",
    agentId: "claude" as const,
    ...overrides,
  };
}

const RUNS = [
  run("waiting", { agentState: "waiting", waitingReason: "approval", since: NOW - 60_000 }),
  run("asking", { agentState: "waiting", waitingReason: "question", since: NOW - 40_000 }),
  run("working", { agentState: "working", since: NOW - 30_000 }),
];

const canopySnapshot: CanopySnapshot = {
  mode: "on",
  activated: true,
  dispositions: [],
  seen: [],
  reads: [],
  scope: null,
  active: true,
  busy: false,
  refreshedAt: NOW,
  cards: [],
  lastError: null,
  failedRuns: [],
  glances: [],
};

function installElectron(
  snapshot: CanopySnapshot = canopySnapshot,
  branchOf: (runId: string) => Promise<string | null> = async (runId) => `feature/${runId}`
) {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    trash: vi.fn(async (): Promise<number | null> => null),
    untrash: vi.fn(async () => {}),
    reread: vi.fn(async () => {}),
    setShown: vi.fn(async () => {}),
    archive: vi.fn(
      async (
        runId: string,
        target: { spawnedAt: number },
        _expectTurn?: number
      ): Promise<unknown> => ({
        runId,
        spawnedAt: target.spawnedAt,
        turn: 0,
        readTurn: 0,
        markedUnreadAt: null,
        version: 1,
      })
    ),
    unarchive: vi.fn(async () => {}),
    setScope: vi.fn(async () => {}),
    markSeen: vi.fn(async (_runId: string, _looking?: boolean, _place?: string) => {}),
    // Each read change answers with the mark it left, as main does.
    setRead: vi.fn(
      async (runId: string, target: { spawnedAt: number }, read: boolean, turn?: number) => ({
        runId,
        spawnedAt: target.spawnedAt,
        turn: turn ?? 0,
        readTurn: read ? (turn ?? 0) : 0,
        markedUnreadAt: read ? null : NOW,
        version: 2,
      })
    ),
    markAllRead: vi.fn(async (targets: Array<{ runId: string; spawnedAt: number; turn: number }>) =>
      targets.map((target) => ({
        ...target,
        readTurn: target.turn,
        markedUnreadAt: null,
        version: 2,
      }))
    ),
    restoreReads: vi.fn(async (_restores: unknown[]) => {}),
    runBranch: vi.fn((runId: string, _target: { spawnedAt: number }) => branchOf(runId)),
    searchScreens: vi.fn(
      async (_targets: Array<{ runId: string; spawnedAt: number; terms: string[] }>) =>
        [] as string[]
    ),
    // No assistants: a full, empty directory of this machine.
    readAgentDirectory: vi.fn(async () => ({
      coverage: "ok" as const,
      observedAt: 1,
      complete: true,
      omitted: 0,
      entries: [],
    })),
    rename: vi.fn(async (_runId: string, _target: { spawnedAt: number }, _title: string) => {}),
    setMode: vi.fn(async (mode: CanopySnapshot["mode"], _expectRevision?: number) => ({
      ...snapshot,
      mode,
      modeRevision: 5,
      activated: mode === "on",
    })),
  };
  const fleetApi = {
    parkRun: vi.fn(async () => {}),
    unparkRun: vi.fn(async () => {}),
    snoozeRun: vi.fn(async () => {}),
    unsnoozeRun: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "electron", {
    value: {
      canopy,
      fleet: fleetApi,
      terminal: { restore: vi.fn() },
      system: { openExternal: vi.fn() },
    },
    configurable: true,
    writable: true,
  });
  return canopy;
}

beforeEach(() => {
  composers.clear();
  dictationFocus.mockClear();
  __resetCanopySeenForTests();
  __resetCanopyPlaceForTests();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useProjectStore.setState({
    projects: [{ id: "p1", path: "/repo", name: "app", emoji: "🌳", lastOpened: NOW }],
  });
  useFleetSnapshotStore.setState({
    snapshot: { runs: RUNS, changedAt: NOW, degraded: false, lastSuccessfulAt: NOW },
  });
  useCanopyStore.setState({ isOpen: true, snapshot: canopySnapshot, mode: "on" });
  useTypingLocatorStore.setState({ message: null });
  installElectron();
});

afterEach(() => {
  useCanopyStore.setState({
    isOpen: false,
    snapshot: null,
    mode: "unset",
    scope: "all",
    orders: {},
    unreadOnly: false,
    replyReveal: null,
    hostId: null,
  });
  useVoiceRecordingStore.setState({ status: "idle", activeTarget: null, pendingTarget: null });
  window.localStorage.removeItem("daintree-canopy-order");
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function frames(count = 2) {
  for (let i = 0; i < count; i++) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }
}

/** Longer than the dialog's exit, after which what it held unmounts. */
const DIALOG_EXIT_SETTLE_MS = 400;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DIALOG_EXIT_SETTLE_MS));
  });
}

function row(runId: string) {
  return document.getElementById(`canopy-card-${runId}`)!;
}

function selectedRun() {
  return document
    .querySelector('[data-canopy-card][aria-selected="true"]')
    ?.id.replace(/^canopy-card-/, "");
}

async function select(runId: string) {
  await act(async () => {
    fireEvent.click(row(runId));
  });
  await frames();
}

/** The reply's own target, as its composer was handed it. */
async function replyTarget(runId: string): Promise<VoiceRecordingTarget> {
  await vi.waitFor(() => expect(composers.get(runId)?.voiceTarget).toBeDefined());
  return composers.get(runId)!.voiceTarget!;
}

function startDictation(target: VoiceRecordingTarget) {
  act(() => {
    useVoiceRecordingStore.setState({ status: "recording", activeTarget: target });
  });
}

/** What the recording indicator does for a reply off screen. */
async function goBackTo(target: VoiceRecordingTarget) {
  await act(async () => {
    expect(useCanopyStore.getState().revealReply(target.canopyRow!)).toBe(true);
  });
  await frames(3);
}

describe("CanopyView — a reply's dictation outlives its screen (#14778)", () => {
  it("keeps writing the reply's draft with Canopy closed, and reopens on its row from the indicator", async () => {
    render(<CanopyView />);
    await frames();
    await select("asking");
    const target = await replyTarget("asking");
    expect(target.canopyRow).toEqual({ runId: "asking", hostScope: null });
    startDictation(target);
    useTerminalInputStore.getState().setDraftInput(target.panelId, "Fix the login");

    act(() => useCanopyStore.getState().close());
    await settle();
    expect(composers.has("asking")).toBe(false);
    // The words keep going into the reply's own draft while nothing shows it.
    useTerminalInputStore.getState().setDraftInput(target.panelId, "Fix the login bug first");
    expect(useVoiceRecordingStore.getState()).toMatchObject({
      status: "recording",
      activeTarget: target,
    });

    await goBackTo(target);

    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(selectedRun()).toBe("asking");
    const reopened = await replyTarget("asking");
    expect(reopened.panelId).toBe(target.panelId);
    expect(useTerminalInputStore.getState().getDraftInput(reopened.panelId)).toBe(
      "Fix the login bug first"
    );
    await vi.waitFor(() => expect(dictationFocus).toHaveBeenCalledWith("asking"));
    expect(useCanopyStore.getState().replyReveal).toBeNull();
  });

  it("goes back to the reply's row over the agent the main view has focused", async () => {
    render(<CanopyView />);
    await frames();
    await select("asking");
    const target = await replyTarget("asking");
    startDictation(target);
    act(() => useCanopyStore.getState().close());
    await settle();
    usePanelStore.setState({
      panelsById: {
        working: { id: "working", kind: "terminal", location: "grid", detectedAgentId: "claude" },
      } as never,
      focusedId: "working",
    });
    try {
      const scrolled = vi.mocked(Element.prototype.scrollIntoView);
      scrolled.mockClear();
      await goBackTo(target);
      expect(selectedRun()).toBe("asking");
      // The opening waited on the reply: it never went to the focused agent first.
      expect(scrolled.mock.contexts).toContain(row("asking"));
      expect(scrolled.mock.contexts).not.toContain(row("working"));
      await vi.waitFor(() => expect(dictationFocus).toHaveBeenCalledWith("asking"));
    } finally {
      usePanelStore.setState({ panelsById: {} as never, focusedId: null });
    }
  });

  it("hands the keyboard back to the row the panel opens on by itself", async () => {
    render(<CanopyView />);
    await frames();
    const first = selectedRun()!;
    const target = await replyTarget(first);
    startDictation(target);
    act(() => useCanopyStore.getState().close());
    await settle();

    await goBackTo(target);

    // Opened on the same row its landing would have picked: the pane is the one
    // already showing, and it still takes the request.
    expect(selectedRun()).toBe(first);
    await vi.waitFor(() => expect(dictationFocus).toHaveBeenCalledWith(first));
    expect(useCanopyStore.getState().replyReveal).toBeNull();
  });

  it("leaves the session with its row when another is selected, marks that row, and goes back to it", async () => {
    render(<CanopyView />);
    await frames();
    await select("asking");
    const target = await replyTarget("asking");
    startDictation(target);
    expect(row("asking").querySelector("[data-canopy-dictating]")).not.toBeNull();

    await select("working");
    expect(selectedRun()).toBe("working");
    expect(composers.has("asking")).toBe(false);
    expect((await replyTarget("working")).panelId).not.toBe(target.panelId);
    expect(useVoiceRecordingStore.getState().activeTarget).toBe(target);
    expect(row("asking").querySelector("[data-canopy-dictating]")).not.toBeNull();
    expect(row("working").querySelector("[data-canopy-dictating]")).toBeNull();
    const description = row("asking")
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("dictating a reply");

    await goBackTo(target);
    expect(selectedRun()).toBe("asking");
    await vi.waitFor(() => expect(dictationFocus).toHaveBeenCalledWith("asking"));

    // Stopped, the mark goes with the session.
    act(() => {
      useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });
    });
    expect(row("asking").querySelector("[data-canopy-dictating]")).toBeNull();
  });

  it("says so when the row has gone, and opens as it would have", async () => {
    render(<CanopyView />);
    await frames();
    await select("asking");
    const target = await replyTarget("asking");
    startDictation(target);
    act(() => useCanopyStore.getState().close());
    await settle();

    // The run ends while Canopy is closed: its row isn't there to go back to.
    act(() => {
      useFleetSnapshotStore.setState({
        snapshot: {
          runs: RUNS.filter((entry) => entry.runId !== "asking"),
          changedAt: NOW + 1,
          degraded: false,
          lastSuccessfulAt: NOW,
        },
      });
    });
    const announce = vi.spyOn(useAnnouncerStore.getState(), "announce");
    await goBackTo(target);

    expect(useTypingLocatorStore.getState().message).toMatchObject({
      kind: "draft-refused",
      lead: expect.stringContaining("isn't in Canopy"),
    });
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("isn't in Canopy"), "polite");
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(useCanopyStore.getState().replyReveal).toBeNull();
    // The opening lands as it would have: the list's top row, keyboard in the search.
    await frames();
    expect(selectedRun()).toBe("waiting");
    expect(document.activeElement).toBe(
      document.querySelector("[data-testid=canopy-dialog] input[role=combobox]")
    );
    expect(dictationFocus).not.toHaveBeenCalled();
    // The dictation itself is untouched: its words stay in its draft.
    expect(useVoiceRecordingStore.getState().activeTarget).toBe(target);
  });

  it("keeps Canopy's search, and says it hides the row, rather than clearing it", async () => {
    render(<CanopyView />);
    await frames();
    await select("asking");
    const target = await replyTarget("asking");
    startDictation(target);
    await select("working");
    const search = document.querySelector<HTMLInputElement>(
      "[data-testid=canopy-dialog] input[role=combobox]"
    )!;
    await act(async () => {
      fireEvent.change(search, { target: { value: "working" } });
    });
    await frames();
    expect(document.getElementById("canopy-card-asking")).toBeNull();

    await goBackTo(target);

    expect(search.value).toBe("working");
    expect(useTypingLocatorStore.getState().message?.lead).toContain("hidden by Canopy's filters");
    expect(dictationFocus).not.toHaveBeenCalled();
    expect(useCanopyStore.getState().replyReveal).toBeNull();
  });
});
