// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, screen, act, waitFor } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import { FleetComposer } from "../FleetComposer";
import { useFleetComposerStore } from "@/store/fleetComposerStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useNotificationStore } from "@/store/notificationStore";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";
import { FLEET_BROADCAST_HISTORY_KEY } from "../fleetBroadcast";
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
  useFleetComposerStore.setState({ draft: "" });
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

  it("drops silently-exited targets at submit time and toasts the actual count", async () => {
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
    await waitFor(() => {
      const last = useNotificationStore.getState().notifications.at(-1)?.message ?? "";
      expect(last).toBe("Sent to 1 agent");
    });
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

  it("partial failure surfaces the correct toast count", async () => {
    submitMock.mockReset();
    submitMock.mockImplementationOnce(() => Promise.resolve());
    submitMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "x" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const last = useNotificationStore.getState().notifications.at(-1)?.message ?? "";
      expect(last).toBe("Sent to 1 agent (1 failed)");
    });
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

  it("all submits reject — toasts 0 success / N failed, draft retained, history not recorded", async () => {
    submitMock.mockReset();
    submitMock.mockRejectedValue(new Error("boom"));
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "fail it" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const last = useNotificationStore.getState().notifications.at(-1)?.message ?? "";
      expect(last).toBe("Sent to 0 agents (2 failed)");
    });
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
});
