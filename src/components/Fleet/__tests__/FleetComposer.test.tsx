// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, screen, act, waitFor } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import { FleetComposer } from "../FleetComposer";
import { useFleetComposerStore } from "@/store/fleetComposerStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetIdleStore } from "@/store/fleetIdleStore";
import { usePanelStore } from "@/store/panelStore";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useNotificationStore } from "@/store/notificationStore";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";
import { FLEET_BROADCAST_HISTORY_KEY } from "../fleetBroadcast";
import {
  FLEET_IDLE_GRACE_MS,
  FLEET_IDLE_RESCHEDULE_MS,
  FLEET_IDLE_TIMEOUT_MS,
} from "@/hooks/useFleetIdleTimer";
import type { TerminalInstance, WorktreeSnapshot } from "@shared/types";

const submitMock = vi.fn<(id: string, text: string) => Promise<void>>();

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      submit: (id: string, text: string) => submitMock(id, text),
    },
  };
});

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    type: "terminal",
    kind: "agent",
    agentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as TerminalInstance;
}

function makeWorktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    branch: `feature/${id}`,
    isCurrent: true,
    issueNumber: 42,
    prNumber: undefined,
    ...(overrides as object),
  } as WorktreeSnapshot;
}

function installViewStore(worktrees: Map<string, WorktreeSnapshot>) {
  const store = createStore<WorktreeViewState & WorktreeViewActions>(() => ({
    worktrees,
    version: 0,
    isLoading: false,
    error: null,
    isInitialized: true,
    isReconnecting: false,
    nextVersion: () => 0,
    applySnapshot: () => {},
    applyUpdate: () => {},
    applyRemove: () => {},
    setLoading: () => {},
    setError: () => {},
    setFatalError: () => {},
    setReconnecting: () => {},
  }));
  setCurrentViewStore(store);
}

function resetAll(worktreeId = "wt-1") {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  useFleetComposerStore.setState({
    draft: "",
    alwaysPreview: false,
    isCanaryPending: false,
    canarySentId: null,
    canaryPendingIds: [],
    canaryPrompt: null,
  });
  useFleetIdleStore.setState({ phase: "idle", warningStartedAt: null });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useCommandHistoryStore.setState({ history: {} });
  useNotificationStore.setState({ notifications: [] });

  const worktrees = new Map<string, WorktreeSnapshot>();
  worktrees.set(
    worktreeId,
    makeWorktree(worktreeId, { path: "/repo/wt-1", branch: "feature/x", issueNumber: 42 })
  );
  installViewStore(worktrees);
}

function armTwo() {
  usePanelStore.setState({
    panelsById: {
      t1: makeAgent("t1"),
      t2: makeAgent("t2"),
    },
    panelIds: ["t1", "t2"],
  });
  useFleetArmingStore.getState().armIds(["t1", "t2"]);
}

function armN(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `t${i + 1}`);
  const panelsById: Record<string, TerminalInstance> = {};
  for (const id of ids) panelsById[id] = makeAgent(id);
  usePanelStore.setState({ panelsById, panelIds: ids });
  useFleetArmingStore.getState().armIds(ids);
}

describe("FleetComposer", () => {
  beforeEach(() => {
    submitMock.mockReset();
    submitMock.mockResolvedValue(undefined);
    resetAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when no agents are armed", () => {
    const { container } = render(<FleetComposer />);
    expect(container.firstChild).toBeNull();
  });

  it("does not auto-focus the textarea on mount", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea");
    expect(document.activeElement).not.toBe(textarea);
  });

  it("submits on plain Enter to all armed targets", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "run tests" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    expect(submitMock.mock.calls.map(([id]) => id).sort()).toEqual(["t1", "t2"]);
    expect(submitMock.mock.calls[0]![1]).toBe("run tests");
  });

  it("does not submit while IME is composing", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "中文" } });
    // React synthetic event exposes nativeEvent.isComposing.
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

    expect(submitMock).not.toHaveBeenCalled();
  });

  it("Shift+Enter does not submit and does not prevent default (newline passes through)", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "line 1" } });
    const e = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(submitMock).not.toHaveBeenCalled();
    expect(e).toBe(true); // default not prevented
  });

  it("opens confirmation strip for multi-line text and does not send", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "one\ntwo" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(submitMock).not.toHaveBeenCalled();
    const strip = screen.getByTestId("fleet-composer-confirm");
    expect(strip).toBeTruthy();
    expect(strip.getAttribute("role")).toBe("status");
    expect(strip.getAttribute("aria-live")).toBe("polite");
    expect(strip.getAttribute("aria-atomic")).toBe("true");
  });

  it("opens confirmation strip for destructive command", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "rm -rf node_modules" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(submitMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("fleet-composer-confirm")).toBeTruthy();
  });

  it("Cmd+Enter bypasses confirmation and force-sends", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "rm -rf node_modules" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    expect(submitMock.mock.calls[0]![1]).toBe("rm -rf node_modules");
  });

  it("Ctrl+Enter also force-sends (Windows/Linux parity)", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "rm -rf node_modules" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
  });

  it("Cancel in confirmation strip returns focus to textarea and does not send", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "line1\nline2" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const cancel = screen.getByTestId("fleet-composer-confirm-cancel");
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(cancel);
    expect(screen.queryByTestId("fleet-composer-confirm")).toBeNull();
    expect(submitMock).not.toHaveBeenCalled();
    expect(useFleetComposerStore.getState().draft).toBe("line1\nline2");
    expect(document.activeElement).toBe(textarea);
  });

  it("Send anyway in confirmation strip submits to all armed targets", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "line1\nline2" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    fireEvent.click(screen.getByTestId("fleet-composer-confirm-send"));
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
  });

  it("Escape with non-empty draft clears draft and stops propagation", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "typing" } });
    const result = fireEvent.keyDown(textarea, { key: "Escape" });

    expect(useFleetComposerStore.getState().draft).toBe("");
    expect(result).toBe(false); // preventDefault was called
  });

  it("Escape with empty draft does NOT stop propagation (bubbles to arming)", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    const result = fireEvent.keyDown(textarea, { key: "Escape" });
    expect(result).toBe(true); // default not prevented — bubbles through
  });

  it("ArrowUp at caret 0 walks history backward", () => {
    armTwo();
    useCommandHistoryStore.setState({
      history: {
        [FLEET_BROADCAST_HISTORY_KEY]: [
          { id: "1", prompt: "newer", agentId: null, addedAt: 2 },
          { id: "2", prompt: "older", agentId: null, addedAt: 1 },
        ],
      },
    });
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 0);

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(useFleetComposerStore.getState().draft).toBe("newer");

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(useFleetComposerStore.getState().draft).toBe("older");
  });

  it("ArrowDown restores the unsent snapshot when walking past the newest entry", () => {
    armTwo();
    useCommandHistoryStore.setState({
      history: {
        [FLEET_BROADCAST_HISTORY_KEY]: [{ id: "1", prompt: "earlier", agentId: null, addedAt: 1 }],
      },
    });
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "unsent draft" } });
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(useFleetComposerStore.getState().draft).toBe("earlier");

    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(useFleetComposerStore.getState().draft).toBe("unsent draft");
  });

  it("records history and clears draft after successful send", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "run tests" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useFleetComposerStore.getState().draft).toBe(""));

    const history = useCommandHistoryStore
      .getState()
      .getProjectHistory(FLEET_BROADCAST_HISTORY_KEY);
    expect(history.map((h) => h.prompt)).toContain("run tests");
  });

  it("resolves {{branch_name}} variable per-terminal before submit", async () => {
    usePanelStore.setState({
      panelsById: {
        a: makeAgent("a", { worktreeId: "wt-1" }),
        b: makeAgent("b", { worktreeId: "wt-2" }),
      },
      panelIds: ["a", "b"],
    });
    const worktrees = new Map<string, WorktreeSnapshot>();
    worktrees.set("wt-1", makeWorktree("wt-1", { branch: "feature/x", path: "/w/1" }));
    worktrees.set("wt-2", makeWorktree("wt-2", { branch: "feature/y", path: "/w/2" }));
    installViewStore(worktrees);
    useFleetArmingStore.getState().armIds(["a", "b"]);

    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "checkout {{branch_name}}" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    const byId = Object.fromEntries(submitMock.mock.calls.map(([id, text]) => [id, text]));
    expect(byId.a).toBe("checkout feature/x");
    expect(byId.b).toBe("checkout feature/y");
  });

  it("drops silently-exited targets at submit time without emitting a notification", async () => {
    usePanelStore.setState({
      panelsById: {
        a: makeAgent("a"),
        dead: makeAgent("dead", { location: "trash" }),
      },
      panelIds: ["a", "dead"],
    });
    useFleetArmingStore.getState().armIds(["a", "dead"]);

    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0]![0]).toBe("a");
    await act(async () => {
      await Promise.resolve();
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(useFleetComposerStore.getState().lastFailedIds).toEqual([]);
  });

  it("does NOT clear draft when no live targets remain at submit", async () => {
    usePanelStore.setState({
      panelsById: { dead: makeAgent("dead", { location: "trash" }) },
      panelIds: ["dead"],
    });
    useFleetArmingStore.getState().armIds(["dead"]);

    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "please keep" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // allow microtasks to flush
    await act(async () => {
      await Promise.resolve();
    });
    expect(submitMock).not.toHaveBeenCalled();
    expect(useFleetComposerStore.getState().draft).toBe("please keep");
  });

  it("partial failure populates lastFailedIds without emitting a notification", async () => {
    submitMock.mockReset();
    submitMock.mockImplementationOnce(() => Promise.resolve());
    submitMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "x" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(useFleetComposerStore.getState().lastFailedIds).toEqual(["t2"]);
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("auto-clears draft when armedCount returns to zero", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "typing" } });
    expect(useFleetComposerStore.getState().draft).toBe("typing");

    act(() => {
      useFleetArmingStore.getState().clear();
    });
    expect(useFleetComposerStore.getState().draft).toBe("");
  });

  it("disables send button when draft is blank", () => {
    armTwo();
    render(<FleetComposer />);
    const send = screen.getByTestId("fleet-composer-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(send.disabled).toBe(false);
  });

  it("all submits reject — lastFailedIds populated, draft retained, history not recorded", async () => {
    submitMock.mockReset();
    submitMock.mockRejectedValue(new Error("boom"));
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "fail it" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(useFleetComposerStore.getState().lastFailedIds).toEqual(["t1", "t2"]);
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(useFleetComposerStore.getState().draft).toBe("fail it");
    const history = useCommandHistoryStore
      .getState()
      .getProjectHistory(FLEET_BROADCAST_HISTORY_KEY);
    expect(history.map((h) => h.prompt)).not.toContain("fail it");

    // Send button is usable again after failure.
    const send = screen.getByTestId("fleet-composer-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it("double-click 'Send anyway' only enqueues one batch (re-entrancy guard)", async () => {
    const resolvers: Array<() => void> = [];
    submitMock.mockReset();
    submitMock.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolvers.push(r);
        })
    );
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "multi\nline" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const confirmSend = await screen.findByTestId("fleet-composer-confirm-send");
    fireEvent.click(confirmSend);
    fireEvent.click(confirmSend);
    fireEvent.click(confirmSend);

    // Exactly 2 submit calls — one per armed terminal — not 6.
    expect(submitMock).toHaveBeenCalledTimes(2);
    resolvers.forEach((r) => r());
    await waitFor(() => expect(useFleetComposerStore.getState().draft).toBe(""));
  });

  it("delivers even when worktree context cannot be resolved (empty-ctx fallback)", async () => {
    // Panel references a worktree that is not in the view store.
    usePanelStore.setState({
      panelsById: { lonely: makeAgent("lonely", { worktreeId: "wt-ghost" }) },
      panelIds: ["lonely"],
    });
    installViewStore(new Map());
    useFleetArmingStore.getState().armIds(["lonely"]);

    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "still send me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0]![1]).toBe("still send me");
  });

  it("leaves unresolved variables empty when worktree context is missing", async () => {
    usePanelStore.setState({
      panelsById: { lonely: makeAgent("lonely", { worktreeId: "wt-ghost" }) },
      panelIds: ["lonely"],
    });
    installViewStore(new Map());
    useFleetArmingStore.getState().armIds(["lonely"]);

    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "branch is {{branch_name}}" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0]![1]).toBe("branch is ");
  });

  it("Escape inside the confirm strip closes it and keeps fleet armed", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "rm -rf x" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    const strip = await screen.findByTestId("fleet-composer-confirm");
    // The strip receives focus on Cancel by default — press Escape on it.
    fireEvent.keyDown(strip, { key: "Escape" });

    expect(screen.queryByTestId("fleet-composer-confirm")).toBeNull();
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
  });

  it("preserves in-flight new typing — does not clear a replacement draft", async () => {
    const resolvers: Array<() => void> = [];
    submitMock.mockReset();
    submitMock.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolvers.push(r);
        })
    );
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));

    // User starts typing a new draft while the first batch is still in flight.
    useFleetComposerStore.getState().setDraft("second");

    resolvers.forEach((r) => r());
    await waitFor(() =>
      expect(
        useCommandHistoryStore.getState().getProjectHistory(FLEET_BROADCAST_HISTORY_KEY).length
      ).toBe(1)
    );
    expect(useFleetComposerStore.getState().draft).toBe("second");
  });

  describe("canary staged broadcast", () => {
    it("below canary threshold (7 targets): quorum strip appears, no canary", () => {
      armN(7);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "do a thing" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(submitMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("fleet-composer-confirm")).toBeTruthy();
      expect(screen.queryByTestId("fleet-composer-canary")).toBeNull();
      expect(useFleetComposerStore.getState().isCanaryPending).toBe(false);
    });

    it("at canary threshold (8 targets): sends to one canary, renders staged strip", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "check tests" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      // First in armOrder is the canary target.
      expect(submitMock.mock.calls[0]![0]).toBe("t1");
      expect(submitMock.mock.calls[0]![1]).toBe("check tests");

      const strip = await screen.findByTestId("fleet-composer-canary");
      expect(strip.textContent).toContain("7 remaining");
      expect(useFleetComposerStore.getState().isCanaryPending).toBe(true);
      expect(useFleetComposerStore.getState().canarySentId).toBe("t1");
      expect(useFleetComposerStore.getState().canaryPendingIds).toEqual([
        "t2",
        "t3",
        "t4",
        "t5",
        "t6",
        "t7",
        "t8",
      ]);
      // Main send button is disabled to prevent double-sends.
      const send = screen.getByTestId("fleet-composer-send") as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      // Draft is retained so the user can see what they sent.
      expect(useFleetComposerStore.getState().draft).toBe("check tests");
    });

    it("Apply to remaining dispatches to the frozen 7 and clears canary state", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "apply me" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      const promote = await screen.findByTestId("fleet-composer-canary-promote");
      fireEvent.click(promote);

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(8));
      const laterCalls = submitMock.mock.calls.slice(1).map(([id, text]) => ({ id, text }));
      expect(laterCalls.map((c) => c.id).sort()).toEqual([
        "t2",
        "t3",
        "t4",
        "t5",
        "t6",
        "t7",
        "t8",
      ]);
      expect(laterCalls.every((c) => c.text === "apply me")).toBe(true);
      expect(useFleetComposerStore.getState().isCanaryPending).toBe(false);
      expect(screen.queryByTestId("fleet-composer-canary")).toBeNull();
    });

    it("promote uses frozen snapshot — mid-review disarm doesn't shrink the promoted set", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "frozen" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      // User disarms one of the staged targets during review.
      act(() => {
        useFleetArmingStore.getState().disarmId("t5");
      });
      // Snapshot is unchanged even though live armedIds dropped.
      expect(useFleetComposerStore.getState().canaryPendingIds).toContain("t5");
      expect(useFleetArmingStore.getState().armedIds.has("t5")).toBe(false);

      fireEvent.click(screen.getByTestId("fleet-composer-canary-promote"));
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(8));
      const promotedIds = submitMock.mock.calls.slice(1).map(([id]) => id);
      expect(promotedIds).toContain("t5");
    });

    it("promote uses frozen prompt — edits to draft during review don't corrupt the promotion", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "original" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      // User edits the draft after sending the canary.
      act(() => {
        useFleetComposerStore.getState().setDraft("edited after canary");
      });

      fireEvent.click(screen.getByTestId("fleet-composer-canary-promote"));
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(8));
      // Every remainder submission should use the frozen prompt, not the edit.
      const payloads = submitMock.mock.calls.slice(1).map(([, text]) => text);
      expect(payloads.every((p) => p === "original")).toBe(true);
      // The user's in-flight edit is preserved.
      expect(useFleetComposerStore.getState().draft).toBe("edited after canary");
    });

    it("Stop clears canary state and fires no remainder submissions", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "nope" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      fireEvent.click(screen.getByTestId("fleet-composer-canary-stop"));
      expect(screen.queryByTestId("fleet-composer-canary")).toBeNull();
      expect(useFleetComposerStore.getState().isCanaryPending).toBe(false);
      // No further submissions after the initial canary.
      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it("Cmd+Enter during canary pending force-sends to remainder (frozen), not all targets", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "go" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(8));
      // Canary target (t1) is not re-sent; the 7 remainder targets receive.
      const forcedIds = submitMock.mock.calls.slice(1).map(([id]) => id);
      expect(forcedIds.sort()).toEqual(["t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
      expect(useFleetComposerStore.getState().isCanaryPending).toBe(false);
    });

    it("Cmd+Enter force-send bypasses canary gate entirely on the initial submit", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "force everything" } });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(8));
      expect(useFleetComposerStore.getState().isCanaryPending).toBe(false);
      expect(screen.queryByTestId("fleet-composer-canary")).toBeNull();
    });

    it("destructive content at 8 targets: content gate wins, no canary", () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "rm -rf build" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(submitMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("fleet-composer-confirm")).toBeTruthy();
      expect(screen.queryByTestId("fleet-composer-canary")).toBeNull();
    });

    it("plain Enter while canary pending is a no-op (strip is the only path forward)", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "initial" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      // Plain Enter should not trigger another send or re-open confirmation.
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submitMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("fleet-composer-confirm")).toBeNull();
      // Strip remains visible.
      expect(screen.getByTestId("fleet-composer-canary")).toBeTruthy();
    });

    it("full disarm during canary pending clears staged state", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "bye" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      act(() => {
        useFleetArmingStore.getState().clear();
      });
      expect(useFleetComposerStore.getState().isCanaryPending).toBe(false);
      expect(useFleetComposerStore.getState().draft).toBe("");
    });

    it("alwaysPreview is suppressed during canary pending (strip is sole forward path)", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "initial" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      // Turn on alwaysPreview AFTER canary has staged.
      act(() => {
        useFleetComposerStore.setState({ alwaysPreview: true });
      });

      // Plain Enter should still be a no-op — not open the dry-run dialog.
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(submitMock).toHaveBeenCalledTimes(1);
      // Strip remains visible.
      expect(screen.getByTestId("fleet-composer-canary")).toBeTruthy();
    });

    it("canary send failure does NOT stage remainder", async () => {
      submitMock.mockReset();
      submitMock.mockRejectedValueOnce(new Error("canary failed"));
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "broken" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await waitFor(() => {
        const last = useNotificationStore.getState().notifications.at(-1)?.message ?? "";
        expect(last).toBe("Canary send failed — remainder not staged");
      });
      expect(useFleetComposerStore.getState().isCanaryPending).toBe(false);
      expect(useFleetComposerStore.getState().canaryPendingIds).toEqual([]);
      expect(useFleetComposerStore.getState().canaryPrompt).toBeNull();
      expect(screen.queryByTestId("fleet-composer-canary")).toBeNull();
      // The canary target is recorded as a failure for retry.
      expect(useFleetComposerStore.getState().lastFailedIds).toEqual(["t1"]);
    });

    it("Cmd+Enter during canary pending uses live draft (documented design)", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "original" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      // User edits draft, then force-sends. Force-send is an explicit
      // override, so it uses the live draft — Promote is what uses the
      // frozen prompt. This test pins that distinction.
      act(() => {
        useFleetComposerStore.getState().setDraft("edited override");
      });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(8));
      const forcedPayloads = submitMock.mock.calls.slice(1).map(([, text]) => text);
      expect(forcedPayloads.every((p) => p === "edited override")).toBe(true);
      // canary target (t1) was NOT re-sent.
      const forcedIds = submitMock.mock.calls.slice(1).map(([id]) => id);
      expect(forcedIds).not.toContain("t1");
    });

    it("full disarm clears all four canary fields", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "staged" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      act(() => {
        useFleetArmingStore.getState().clear();
      });

      const s = useFleetComposerStore.getState();
      expect(s.isCanaryPending).toBe(false);
      expect(s.canarySentId).toBeNull();
      expect(s.canaryPendingIds).toEqual([]);
      expect(s.canaryPrompt).toBeNull();
    });

    it("promote history records the frozen canary cohort, not the live armed set", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "historic" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("fleet-composer-canary");

      // User disarms t5 mid-review — but the promotion still sends to all 8
      // frozen targets, and history should record that cohort.
      act(() => {
        useFleetArmingStore.getState().disarmId("t5");
      });

      fireEvent.click(screen.getByTestId("fleet-composer-canary-promote"));
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(8));

      const history = useCommandHistoryStore
        .getState()
        .getProjectHistory(FLEET_BROADCAST_HISTORY_KEY);
      const entry = history.find((h) => h.prompt === "historic");
      expect(entry).toBeDefined();
      expect(entry!.armedIds).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    });

    it("double-click Promote only enqueues one batch (reentrancy guard)", async () => {
      armN(8);
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "once" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));

      const resolvers: Array<() => void> = [];
      submitMock.mockReset();
      submitMock.mockImplementation(
        () =>
          new Promise<void>((r) => {
            resolvers.push(r);
          })
      );

      const promote = await screen.findByTestId("fleet-composer-canary-promote");
      fireEvent.click(promote);
      fireEvent.click(promote);
      fireEvent.click(promote);

      // Exactly 7 submissions (one per remainder target), not 21.
      expect(submitMock).toHaveBeenCalledTimes(7);
      resolvers.forEach((r) => r());
      await waitFor(() => expect(useFleetComposerStore.getState().isCanaryPending).toBe(false));
    });
  });

  describe("idle timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    it("does not show the warning strip before the idle timeout fires", () => {
      armTwo();
      render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS - 1000);
      });
      expect(screen.queryByTestId("fleet-idle-warning")).toBeNull();
      expect(useFleetIdleStore.getState().phase).toBe("idle");
    });

    it("shows the warning strip after the idle timeout fires", () => {
      armTwo();
      render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      expect(screen.getByTestId("fleet-idle-warning")).toBeTruthy();
      expect(useFleetIdleStore.getState().phase).toBe("warning");
    });

    it("auto-exits broadcast mode when the grace period elapses without response", () => {
      armTwo();
      render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);

      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_GRACE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
      expect(useFleetIdleStore.getState().phase).toBe("idle");
    });

    it("'Stay armed' dismisses the warning and restarts the idle timer", () => {
      armTwo();
      render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      fireEvent.click(screen.getByTestId("fleet-idle-stay"));
      expect(useFleetIdleStore.getState().phase).toBe("idle");
      expect(screen.queryByTestId("fleet-idle-warning")).toBeNull();
      // Grace timer must be cleared — advancing past its original window must not auto-exit.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_GRACE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
    });

    it("'Stay armed' schedules a full fresh idle cycle", () => {
      armTwo();
      render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      fireEvent.click(screen.getByTestId("fleet-idle-stay"));

      // Just before the new idle deadline — still idle.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS - 1000);
      });
      expect(useFleetIdleStore.getState().phase).toBe("idle");

      // Cross the deadline — warning reappears.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(useFleetIdleStore.getState().phase).toBe("warning");

      // Grace elapses without response — auto-exit.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_GRACE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    });

    it("'Exit' button clears the armed set immediately", () => {
      armTwo();
      render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      fireEvent.click(screen.getByTestId("fleet-idle-exit"));
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
      expect(useFleetIdleStore.getState().phase).toBe("idle");
    });

    it("typing in the textarea resets the idle timer", () => {
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS - 1000);
      });
      fireEvent.change(textarea, { target: { value: "typing" } });
      // Advance past the original timeout — warning should NOT fire because
      // the timer was reset by the change event.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(useFleetIdleStore.getState().phase).toBe("idle");
      expect(screen.queryByTestId("fleet-idle-warning")).toBeNull();
    });

    it("focusing the textarea resets the idle timer", () => {
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS - 1000);
      });
      fireEvent.focus(textarea);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(useFleetIdleStore.getState().phase).toBe("idle");
    });

    it("arm-set change while still armed resets the idle timer", () => {
      armTwo();
      render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS - 1000);
      });
      act(() => {
        // New arming action — timer should reset.
        useFleetArmingStore.getState().armIds(["t1"]);
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(useFleetIdleStore.getState().phase).toBe("idle");
      expect(screen.queryByTestId("fleet-idle-warning")).toBeNull();
    });

    it("armedCount → 0 clears timers and resets the phase", () => {
      armTwo();
      render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      expect(useFleetIdleStore.getState().phase).toBe("warning");

      act(() => {
        useFleetArmingStore.getState().clear();
      });
      expect(useFleetIdleStore.getState().phase).toBe("idle");

      // No auto-exit callback should fire after clear — armed set stays empty.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_GRACE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    });

    it("confirming state defers auto-exit but exits after the retry cap", () => {
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

      // Open the confirmation strip — triggers a submit attempt that calls
      // resetIdleTimer(), so advance past the new idle window afterwards.
      fireEvent.change(textarea, { target: { value: "rm -rf node_modules" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(screen.getByTestId("fleet-composer-confirm")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      // Warning appears; grace timer starts.
      expect(useFleetIdleStore.getState().phase).toBe("warning");

      // Grace fires but confirming is true → first reschedule.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_GRACE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);

      // Second reschedule.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_RESCHEDULE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);

      // Third fire — retry cap reached, exit regardless.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_RESCHEDULE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    });

    it("dry-run dialog open defers auto-exit but force-exits after the retry cap", () => {
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

      // Open the dry-run dialog via Cmd+Shift+Enter.
      fireEvent.change(textarea, { target: { value: "preview me" } });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, shiftKey: true });

      // The submit-attempt branch calls resetIdleTimer(); advance past it.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      expect(useFleetIdleStore.getState().phase).toBe("warning");

      // Grace fires but dry-run is open → first reschedule.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_GRACE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);

      // Second reschedule.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_RESCHEDULE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);

      // Third fire — retry cap reached, exit regardless.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_RESCHEDULE_MS);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    });

    it("unmount during warning phase cancels the pending auto-exit", () => {
      armTwo();
      const { unmount } = render(<FleetComposer />);
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_TIMEOUT_MS);
      });
      unmount();

      // After unmount, advancing timers must not clear the armed set.
      act(() => {
        vi.advanceTimersByTime(FLEET_IDLE_GRACE_MS * 2);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
      expect(useFleetIdleStore.getState().phase).toBe("idle");
    });
  });
});
