// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { addErrorMock, removeErrorMock, isAvailableMock, cancelMock, onProgressMock, injectMock } =
  vi.hoisted(() => ({
    addErrorMock: vi.fn(),
    removeErrorMock: vi.fn(),
    isAvailableMock: vi.fn<() => Promise<boolean>>(() => new Promise<boolean>(() => {})),
    cancelMock: vi.fn(() => undefined),
    onProgressMock: vi.fn(() => () => {}),
    injectMock: vi.fn<
      (
        terminalId: string,
        worktreeId: string,
        options: unknown,
        injectionUuid?: string
      ) => Promise<{
        error?: string;
        fileCount?: number;
        stats?: Record<string, unknown> | null;
      }>
    >(),
  }));

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

type PanelListener = (state: unknown, prevState: unknown) => void;

const { terminalState, usePanelStoreMock, panelListeners } = vi.hoisted(() => {
  const terminalState = {
    focusedId: "term-1",
    panelsById: {
      "term-1": {
        id: "term-1",
        worktreeId: "wt-1",
        agentId: undefined,
        agentState: "idle",
      },
    } as Record<string, Record<string, unknown>>,
    panelIds: ["term-1"],
  };

  const storeFn = vi.fn((selector: (state: typeof terminalState) => unknown) =>
    selector(terminalState)
  );
  const panelListeners = new Set<PanelListener>();
  const usePanelStoreMock = Object.assign(storeFn, {
    subscribe: vi.fn((listener: PanelListener) => {
      panelListeners.add(listener);
      return () => panelListeners.delete(listener);
    }),
    getState: () => terminalState,
  });

  return { terminalState, usePanelStoreMock, panelListeners };
});

/** Change one panel the way the store would, telling every subscriber. */
function updatePanel(id: string, patch: Record<string, unknown>): void {
  const prevState = { ...terminalState, panelsById: { ...terminalState.panelsById } };
  terminalState.panelsById = {
    ...terminalState.panelsById,
    [id]: { ...terminalState.panelsById[id], ...patch },
  };
  for (const listener of [...panelListeners]) listener(terminalState, prevState);
}

vi.mock("@/store/panelStore", () => ({
  usePanelStore: usePanelStoreMock,
}));

vi.mock("@/store/errorStore", () => ({
  useErrorStore: (
    selector: (state: {
      addError: typeof addErrorMock;
      removeError: typeof removeErrorMock;
    }) => unknown
  ) => selector({ addError: addErrorMock, removeError: removeErrorMock }),
}));

vi.mock("@/clients", () => ({
  copyTreeClient: {
    onProgress: onProgressMock,
    isAvailable: isAvailableMock,
    injectToTerminal: injectMock,
    cancel: cancelMock,
  },
  // usePanelStore (pulled in transitively) constructs panelPersistence with
  // projectClient at module load.
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(null),
  },
}));

import { useContextInjection, cancelContextInjection } from "../useContextInjection";

describe("useContextInjection", () => {
  beforeEach(() => {
    // Reset the module-level singleton between tests via its public API
    cancelContextInjection();
    vi.clearAllMocks();
    panelListeners.clear();
    isAvailableMock.mockImplementation(() => new Promise<boolean>(() => {}));
    terminalState.focusedId = "term-1";
    terminalState.panelsById = {
      "term-1": {
        id: "term-1",
        worktreeId: "wt-1",
        agentId: undefined,
        agentState: "idle",
      },
    };
    terminalState.panelIds = ["term-1"];
  });

  // Issue #11735 — a completed injection played a sound and dispatched a DOM
  // event but showed nothing. The pane's inline progress banner disappears on
  // completion, so nothing said how much context the agent actually received.
  describe("completion toast", () => {
    async function runInjection(
      resolved: { error?: string; fileCount?: number; stats?: Record<string, unknown> | null },
      selectedPaths?: string[]
    ): Promise<void> {
      isAvailableMock.mockResolvedValue(true);
      injectMock.mockResolvedValue(resolved);

      const { result } = renderHook(() => useContextInjection("term-1"));

      // Awaited inside act so the success branch and the state updates that
      // follow it flush together — a bare waitFor would leave them outside act.
      await act(async () => {
        await result.current.inject("wt-1", "term-1", selectedPaths);
      });
    }

    it("announces the injection in terminal wording, never clipboard wording", async () => {
      await runInjection({ fileCount: 7, stats: { totalSize: 2048 } });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const payload = notifyMock.mock.calls[0]?.[0] as { type: string; message: string };
      expect(payload.type).toBe("success");
      expect(payload.message).toContain("Injected 7 files");
      expect(payload.message).toContain("into terminal");
      expect(payload.message).not.toContain("clipboard");
    });

    it("keeps its own rate-limit bucket and addresses the target terminal", async () => {
      // The `copyTree.injectToTerminal` action is an independent route to the
      // same client method; a shared bucket would let one suppress the other.
      await runInjection({ fileCount: 7, stats: { totalSize: 2048 } });

      const payload = notifyMock.mock.calls[0]?.[0] as {
        rateLimitKey?: string;
        type: string;
        context: Record<string, unknown>;
      };
      expect(payload.rateLimitKey).toBeTruthy();
      expect(payload.rateLimitKey).not.toBe(payload.type);
      expect(payload.rateLimitKey).not.toBe("copyTree.injectToTerminal");
      expect(payload.context).toEqual({
        eventKind: "agent",
        panelId: "term-1",
        worktreeId: "wt-1",
      });
    });

    it.each([
      ["a selected-path injection", ["node_modules"]],
      ["a whole-context injection", undefined],
    ])("reports an empty %s as a plain count, never as a folder", async (_label, selected) => {
      // `selectedPaths` are file-browser selections that may be individual
      // files, so the folder-shaped explanation the context menu uses would be
      // the wrong words here. A count stays true whatever was selected.
      await runInjection(
        { fileCount: 0, stats: { excluded: { total: 3, byReason: { gitignore: 3 } } } },
        selected
      );

      const payload = notifyMock.mock.calls[0]?.[0] as { type: string; message: string };
      expect(payload.type).toBe("success");
      expect(payload.message).toContain("0 files");
      expect(payload.message).not.toContain("folder");
    });

    it("never announces an injection that failed", async () => {
      await runInjection({ error: "Terminal closed during injection" });
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("surfaces a refused shell target as an error instead of announcing it", async () => {
      // A shell skips the agent-readiness wait and goes straight to main, which
      // refuses it there (#15629); the refusal has to reach the user.
      const refusal = "Context can only be injected into a running agent, not a shell";
      isAvailableMock.mockResolvedValue(true);
      injectMock.mockResolvedValue({ error: refusal });
      const { result } = renderHook(() => useContextInjection("term-1"));

      await act(async () => {
        await result.current.inject("wt-1", "term-1");
      });

      expect(injectMock).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBe(refusal);
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("never announces a cancelled injection", async () => {
      // Cancellation returns before the success branch; announcing would claim
      // the agent got context the user deliberately stopped.
      await runInjection({ error: "Injection cancelled" });
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("never announces a cancel that races a successful write", async () => {
      // The other half of the cancel race: the user cancels while the write is
      // in flight and the client still resolves successfully. Resolving with an
      // error only covers the branch that reads the message — this covers the
      // one that has to recheck the cancelled set after the await.
      isAvailableMock.mockResolvedValue(true);
      let resolveInject!: (value: { fileCount?: number; stats?: Record<string, unknown> }) => void;
      injectMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInject = resolve;
          })
      );

      const { result } = renderHook(() => useContextInjection("term-1"));

      let injectPromise!: Promise<void>;
      act(() => {
        injectPromise = result.current.inject("wt-1", "term-1");
      });
      await vi.waitFor(() => expect(injectMock).toHaveBeenCalled());

      act(() => {
        result.current.cancel();
      });

      await act(async () => {
        resolveInject({ fileCount: 7, stats: { totalSize: 2048 } });
        await injectPromise;
      });

      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  it("cancelling an active injection does not record an error", async () => {
    isAvailableMock.mockResolvedValue(true);
    let resolveInject!: (value: { error?: string }) => void;
    injectMock.mockImplementation(
      () =>
        new Promise<{ error?: string }>((resolve) => {
          resolveInject = resolve;
        })
    );

    const { result } = renderHook(() => useContextInjection("term-1"));

    let injectPromise!: Promise<void>;
    act(() => {
      injectPromise = result.current.inject("wt-1", "term-1");
    });
    await vi.waitFor(() => expect(injectMock).toHaveBeenCalled());
    expect(result.current.isInjecting).toBe(true);
    expect(result.current.injectionStatus).toBe("injecting");

    const injectionUuid = injectMock.mock.calls[0]?.[3];
    expect(injectionUuid).toBeTruthy();
    act(() => {
      result.current.cancel();
    });
    expect(cancelMock).toHaveBeenCalledWith(injectionUuid);

    await act(async () => {
      resolveInject({ error: "Injection cancelled" });
      await injectPromise;
    });

    expect(addErrorMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.isInjecting).toBe(false);
    expect(result.current.injectionStatus).toBe("idle");
  });

  it("cancelling a pending injection clears the waiting state without recording an error", async () => {
    terminalState.panelsById = {
      "term-agent": {
        id: "term-agent",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "working",
      },
    };
    terminalState.focusedId = "term-agent";
    terminalState.panelIds = ["term-agent"];

    const { result } = renderHook(() => useContextInjection("term-agent"));

    let injectPromise!: Promise<void>;
    act(() => {
      injectPromise = result.current.inject("wt-1", "term-agent");
    });
    await vi.waitFor(() => expect(result.current.isPendingInjection).toBe(true));
    expect(result.current.injectionStatus).toBe("waiting");

    await act(async () => {
      result.current.cancel();
      await injectPromise;
    });

    expect(result.current.isPendingInjection).toBe(false);
    expect(result.current.injectionStatus).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(addErrorMock).not.toHaveBeenCalled();
    // No active backend operation while waiting — nothing to cancel over IPC
    expect(injectMock).not.toHaveBeenCalled();
  });

  it("cancelling during the availability check aborts before any context is written", async () => {
    let resolveAvailable!: (value: boolean) => void;
    isAvailableMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAvailable = resolve;
        })
    );

    const { result } = renderHook(() => useContextInjection("term-1"));

    let injectPromise!: Promise<void>;
    act(() => {
      injectPromise = result.current.inject("wt-1", "term-1");
    });
    await vi.waitFor(() => expect(result.current.isInjecting).toBe(true));

    act(() => {
      result.current.cancel();
    });

    await act(async () => {
      resolveAvailable(true);
      await injectPromise;
    });

    expect(injectMock).not.toHaveBeenCalled();
    expect(addErrorMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.isInjecting).toBe(false);
    expect(result.current.injectionStatus).toBe("idle");
  });

  it("still records a real injection failure as an error", async () => {
    isAvailableMock.mockResolvedValue(true);
    injectMock.mockResolvedValue({ error: "copytree exploded" });
    addErrorMock.mockReturnValue("error-1");

    const { result } = renderHook(() => useContextInjection("term-1"));

    let injectPromise!: Promise<void>;
    act(() => {
      injectPromise = result.current.inject("wt-1", "term-1");
    });
    await act(async () => {
      await injectPromise;
    });

    expect(addErrorMock).toHaveBeenCalledTimes(1);
    expect(addErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Context injection failed: copytree exploded",
        source: "ContextInjection",
      })
    );
    expect(result.current.error).toBe("copytree exploded");
  });

  it("cancelContextInjection cancels the active injection from outside the hook", async () => {
    isAvailableMock.mockResolvedValue(true);
    let resolveInject!: (value: { error?: string }) => void;
    injectMock.mockImplementation(
      () =>
        new Promise<{ error?: string }>((resolve) => {
          resolveInject = resolve;
        })
    );

    const { result } = renderHook(() => useContextInjection("term-1"));

    let injectPromise!: Promise<void>;
    act(() => {
      injectPromise = result.current.inject("wt-1", "term-1");
    });
    await vi.waitFor(() => expect(injectMock).toHaveBeenCalled());

    const injectionUuid = injectMock.mock.calls[0]?.[3];
    expect(injectionUuid).toBeTruthy();
    act(() => {
      cancelContextInjection();
    });
    expect(cancelMock).toHaveBeenCalledWith(injectionUuid);

    await act(async () => {
      resolveInject({ error: "Injection cancelled" });
      await injectPromise;
    });

    expect(addErrorMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.isInjecting).toBe(false);
  });
  // #15644 — injection is the largest single write into a terminal, and it
  // ignored the pane's input lock.
  describe("input lock", () => {
    const LOCK_REFUSAL = "Context can't be injected while the terminal's input is locked";

    it("refuses a locked focused pane before generating anything, where every caller sees it", async () => {
      terminalState.panelsById["term-1"]!.isInputLocked = true;
      // App's own instance: the keybinding and the actions reach the hook through it.
      const { result } = renderHook(() => useContextInjection());

      await act(async () => {
        await result.current.inject("wt-1");
      });

      expect(isAvailableMock).not.toHaveBeenCalled();
      expect(injectMock).not.toHaveBeenCalled();
      expect(addErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `Context injection failed: ${LOCK_REFUSAL}`,
          context: { worktreeId: "wt-1", terminalId: "term-1" },
          retryability: "user-gated",
        })
      );
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("gives up waiting for a busy agent once its pane is locked", async () => {
      terminalState.panelsById = {
        "term-agent": {
          id: "term-agent",
          worktreeId: "wt-1",
          detectedAgentId: "claude",
          agentState: "working",
        },
      };
      const { result } = renderHook(() => useContextInjection("term-agent"));

      let injectPromise!: Promise<void>;
      act(() => {
        injectPromise = result.current.inject("wt-1", "term-agent");
      });
      await vi.waitFor(() => expect(result.current.isPendingInjection).toBe(true));

      await act(async () => {
        updatePanel("term-agent", { isInputLocked: true });
        await injectPromise;
      });

      expect(result.current.isPendingInjection).toBe(false);
      expect(injectMock).not.toHaveBeenCalled();
      expect(addErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: `Context injection failed: ${LOCK_REFUSAL}` })
      );
    });

    it("stops a run locked mid-flight and reports the stop rather than hiding it as a cancel", async () => {
      isAvailableMock.mockResolvedValue(true);
      let resolveInject!: (value: { error?: string; fileCount?: number }) => void;
      injectMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInject = resolve;
          })
      );
      const { result } = renderHook(() => useContextInjection("term-1"));

      let injectPromise!: Promise<void>;
      act(() => {
        injectPromise = result.current.inject("wt-1", "term-1");
      });
      await vi.waitFor(() => expect(injectMock).toHaveBeenCalled());
      const injectionUuid = injectMock.mock.calls[0]?.[3];

      act(() => {
        updatePanel("term-1", { isInputLocked: true });
      });
      expect(cancelMock).toHaveBeenCalledWith(injectionUuid, "input-locked");

      const stopped = "Injection stopped: the terminal's input was locked";
      await act(async () => {
        resolveInject({ error: stopped, fileCount: 0 });
        await injectPromise;
      });

      expect(result.current.error).toBe(stopped);
      expect(addErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: `Context injection failed: ${stopped}` })
      );
      expect(notifyMock).not.toHaveBeenCalled();
    });
  });
});
