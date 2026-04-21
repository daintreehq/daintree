// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, screen, act, waitFor } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import { FleetComposer } from "../FleetComposer";
import { useFleetComposerStore } from "@/store/fleetComposerStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { useNotificationStore } from "@/store/notificationStore";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";
import type { TerminalInstance, WorktreeSnapshot } from "@shared/types";

const writeMock = vi.fn<(id: string, data: string) => void>();
const submitMock = vi.fn<(id: string, text: string) => Promise<void>>();

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      write: (id: string, data: string) => writeMock(id, data),
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
    previewIds: new Set<string>(),
  });
  useFleetComposerStore.setState({ draft: "" });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
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

function dispatchKeyDown(
  el: HTMLElement,
  init: KeyboardEventInit & { keyCode?: number }
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (typeof init.keyCode === "number") {
    Object.defineProperty(event, "keyCode", { value: init.keyCode });
  }
  el.dispatchEvent(event);
  return event;
}

function writesByTarget(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, seq] of writeMock.mock.calls) {
    (out[id] ??= []).push(seq);
  }
  return out;
}

describe("FleetComposer (live keystroke capture)", () => {
  beforeEach(() => {
    writeMock.mockReset();
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

  it("shows a Live indicator instead of a Send button", () => {
    armTwo();
    render(<FleetComposer />);
    expect(screen.getByTestId("fleet-composer-live-indicator")).toBeTruthy();
    expect(screen.queryByTestId("fleet-composer-send")).toBeNull();
  });

  it("forwards a printable character to every armed target", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "a" });

    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writesByTarget()).toEqual({ t1: ["a"], t2: ["a"] });
    expect(useFleetComposerStore.getState().draft).toBe("a");
  });

  it("forwards Enter as \\r without opening a submit/confirm flow", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "Enter" });

    expect(writesByTarget()).toEqual({ t1: ["\r"], t2: ["\r"] });
    expect(submitMock).not.toHaveBeenCalled();
    // Newline reflected in visible draft for legibility.
    expect(useFleetComposerStore.getState().draft).toBe("\n");
  });

  it("forwards Backspace as \\x7f and pops the last visible character", () => {
    armTwo();
    useFleetComposerStore.setState({ draft: "abc" });
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "Backspace" });

    expect(writesByTarget()).toEqual({ t1: ["\x7f"], t2: ["\x7f"] });
    expect(useFleetComposerStore.getState().draft).toBe("ab");
  });

  it("forwards Tab as \\t and prevents focus movement", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    textarea.focus();

    const event = dispatchKeyDown(textarea, { key: "Tab" });

    expect(event.defaultPrevented).toBe(true);
    expect(writesByTarget()).toEqual({ t1: ["\t"], t2: ["\t"] });
  });

  it("forwards Esc as \\x1b and does NOT clear the draft", () => {
    armTwo();
    useFleetComposerStore.setState({ draft: "typing" });
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "Escape" });

    expect(writesByTarget()).toEqual({ t1: ["\x1b"], t2: ["\x1b"] });
    expect(useFleetComposerStore.getState().draft).toBe("typing");
  });

  it.each([
    ["ArrowUp", "\x1b[A"],
    ["ArrowDown", "\x1b[B"],
    ["ArrowRight", "\x1b[C"],
    ["ArrowLeft", "\x1b[D"],
    ["Home", "\x1b[H"],
    ["End", "\x1b[F"],
    ["Delete", "\x1b[3~"],
    ["PageUp", "\x1b[5~"],
    ["PageDown", "\x1b[6~"],
  ])("forwards %s as the expected CSI sequence", (key, expectedSeq) => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key });

    expect(writesByTarget()).toEqual({ t1: [expectedSeq], t2: [expectedSeq] });
  });

  it("forwards Ctrl+C as 0x03 and other control chars correctly", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "c", ctrlKey: true });
    dispatchKeyDown(textarea, { key: "d", ctrlKey: true });

    const byTarget = writesByTarget();
    expect(byTarget.t1).toEqual(["\x03", "\x04"]);
    expect(byTarget.t2).toEqual(["\x03", "\x04"]);
  });

  it("does NOT forward when IME composition is active", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "Process", keyCode: 229 });
    dispatchKeyDown(textarea, { key: "a", isComposing: true });

    expect(writeMock).not.toHaveBeenCalled();
  });

  it("forwards finalized composed text on compositionend and appends to draft", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.compositionStart(textarea);
    // Keydown during composition — must be suppressed.
    dispatchKeyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(textarea, { data: "中文" });

    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writesByTarget()).toEqual({ t1: ["中文"], t2: ["中文"] });
    expect(useFleetComposerStore.getState().draft).toBe("中文");
  });

  it("ignores Cmd-modified keys so browser shortcuts (Cmd+C/V) are untouched", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "c", metaKey: true });
    dispatchKeyDown(textarea, { key: "v", metaKey: true });

    expect(writeMock).not.toHaveBeenCalled();
  });

  it("skips modifier-only keydown presses", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "Shift" });
    dispatchKeyDown(textarea, { key: "Control" });
    dispatchKeyDown(textarea, { key: "Alt" });
    dispatchKeyDown(textarea, { key: "Meta" });

    expect(writeMock).not.toHaveBeenCalled();
  });

  it("re-resolves targets per keystroke so trashed terminals drop out silently", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    dispatchKeyDown(textarea, { key: "a" });
    // Now trash t2 mid-stream.
    usePanelStore.setState({
      panelsById: {
        t1: makeAgent("t1"),
        t2: makeAgent("t2", { location: "trash" }),
      },
    });
    dispatchKeyDown(textarea, { key: "b" });

    expect(writeMock).toHaveBeenCalledTimes(3);
    expect(writesByTarget()).toEqual({ t1: ["a", "b"], t2: ["a"] });
  });

  it("shows a passive destructive warning while streaming chars through", () => {
    armTwo();
    useFleetComposerStore.setState({ draft: "rm -rf node_modules" });
    render(<FleetComposer />);

    const strip = screen.getByTestId("fleet-composer-confirm");
    expect(strip.getAttribute("data-mode")).toBe("passive");
    expect(strip.getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("fleet-composer-confirm-send")).toBeNull();
  });

  it("backspacing through the destructive pattern hides the warning", async () => {
    armTwo();
    useFleetComposerStore.setState({ draft: "rm -rf " });
    render(<FleetComposer />);
    expect(screen.getByTestId("fleet-composer-confirm")).toBeTruthy();

    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    // Four backspaces defuse "rm -rf " down to "rm ".
    for (let i = 0; i < 4; i++) dispatchKeyDown(textarea, { key: "Backspace" });

    await waitFor(() => expect(useFleetComposerStore.getState().draft).toBe("rm "));
    await waitFor(() => expect(screen.queryByTestId("fleet-composer-confirm")).toBeNull());
  });

  it("benign paste submits atomically via bracketed-paste and appends to draft", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "hello" : ""),
      },
    });

    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(submitMock.mock.calls.map(([id]) => id).sort()).toEqual(["t1", "t2"]);
    expect(submitMock.mock.calls[0]![1]).toBe("hello");
    expect(writeMock).not.toHaveBeenCalled();
    expect(useFleetComposerStore.getState().draft).toBe("hello");
  });

  it("destructive paste opens the confirm strip and does NOT submit until confirmed", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "rm -rf dist" : ""),
      },
    });

    expect(submitMock).not.toHaveBeenCalled();
    const strip = await screen.findByTestId("fleet-composer-confirm");
    expect(strip.getAttribute("data-mode")).toBe("paste-confirm");
    expect(strip.getAttribute("role")).toBe("alertdialog");

    const confirm = screen.getByTestId("fleet-composer-confirm-send");
    fireEvent.click(confirm);

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    expect(submitMock.mock.calls[0]![1]).toBe("rm -rf dist");
    await waitFor(() => expect(useFleetComposerStore.getState().draft).toBe("rm -rf dist"));
    // After confirming, the paste strip closes but the typed-draft warning stays passive
    // because the draft now contains "rm -rf dist" — so the strip should flip to passive mode.
    await waitFor(() => {
      const strip = screen.queryByTestId("fleet-composer-confirm");
      expect(strip?.getAttribute("data-mode")).toBe("passive");
    });
  });

  it("cancelling a pending paste drops the payload and keeps the draft untouched", async () => {
    armTwo();
    useFleetComposerStore.setState({ draft: "before" });
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "rm -rf /" : ""),
      },
    });

    fireEvent.click(await screen.findByTestId("fleet-composer-confirm-cancel"));

    expect(submitMock).not.toHaveBeenCalled();
    expect(useFleetComposerStore.getState().draft).toBe("before");
    expect(screen.queryByTestId("fleet-composer-confirm")).toBeNull();
  });

  it("Escape inside a pending paste strip cancels the paste", async () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "sudo shutdown now" : ""),
      },
    });
    const strip = await screen.findByTestId("fleet-composer-confirm");
    fireEvent.keyDown(strip, { key: "Escape" });

    expect(screen.queryByTestId("fleet-composer-confirm")).toBeNull();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("partial paste failure surfaces the correct toast count", async () => {
    submitMock.mockReset();
    submitMock.mockImplementationOnce(() => Promise.resolve());
    submitMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "rm -rf x" : ""),
      },
    });
    fireEvent.click(await screen.findByTestId("fleet-composer-confirm-send"));

    await waitFor(() => {
      const last = useNotificationStore.getState().notifications.at(-1)?.message ?? "";
      expect(last).toBe("Sent to 1 agent (1 failed)");
    });
  });

  it("isComposingRef suppresses plain keydown between compositionstart and compositionend", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.compositionStart(textarea);
    // Plain keydown with NO isComposing flag and NO keyCode 229 — only the
    // isComposingRef.current guard (set by compositionstart) should block it.
    dispatchKeyDown(textarea, { key: "a" });
    expect(writeMock).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea, { data: "あ" });
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writesByTarget()).toEqual({ t1: ["あ"], t2: ["あ"] });
  });

  it("removes raw DOM listeners on unmount (no leak across remount)", () => {
    armTwo();
    const { unmount } = render(<FleetComposer />);
    const firstTextarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    unmount();

    // Fire at the detached node — should be a no-op now.
    dispatchKeyDown(firstTextarea, { key: "a" });
    expect(writeMock).not.toHaveBeenCalled();

    render(<FleetComposer />);
    const secondTextarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
    dispatchKeyDown(secondTextarea, { key: "b" });

    // Exactly one keystroke × two targets — not four (which would signal leaked listeners).
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writesByTarget()).toEqual({ t1: ["b"], t2: ["b"] });
  });

  it("shows a toast when a benign paste fails for every target", async () => {
    submitMock.mockReset();
    submitMock.mockRejectedValue(new Error("port closed"));
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "hello" : ""),
      },
    });

    await waitFor(() => {
      const last = useNotificationStore.getState().notifications.at(-1)?.message ?? "";
      expect(last).toBe("Paste failed — no agents received the payload");
    });
  });

  it("AltGr composed characters are forwarded (Ctrl+Alt+printable)", () => {
    armTwo();
    render(<FleetComposer />);
    const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

    // German layout: AltGr+Q produces "@" with ctrlKey=true AND altKey=true.
    dispatchKeyDown(textarea, { key: "@", ctrlKey: true, altKey: true });

    expect(writesByTarget()).toEqual({ t1: ["@"], t2: ["@"] });
    expect(useFleetComposerStore.getState().draft).toBe("@");
  });

  it("auto-clears draft when armedCount returns to zero", () => {
    armTwo();
    useFleetComposerStore.setState({ draft: "typing" });
    render(<FleetComposer />);
    expect(useFleetComposerStore.getState().draft).toBe("typing");

    act(() => {
      useFleetArmingStore.getState().clear();
    });
    expect(useFleetComposerStore.getState().draft).toBe("");
  });

  describe("commit flash", () => {
    function installAnimateShim(): {
      animate: ReturnType<typeof vi.fn>;
      getAnimations: ReturnType<typeof vi.fn>;
      animations: { cancel: ReturnType<typeof vi.fn> }[];
    } {
      const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
      const animate = vi.fn(() => {
        const anim = { cancel: vi.fn() };
        animations.push(anim);
        return anim;
      });
      const getAnimations = vi.fn(() => animations.slice());
      // jsdom's HTMLElement does not implement the Web Animations API.
      // Patch the prototype so every rendered element picks up our stubs.
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        writable: true,
        value: animate,
      });
      Object.defineProperty(HTMLElement.prototype, "getAnimations", {
        configurable: true,
        writable: true,
        value: getAnimations,
      });
      return { animate, getAnimations, animations };
    }

    function restoreAnimateShim(): void {
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
      delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    }

    afterEach(() => {
      restoreAnimateShim();
      document.body.removeAttribute("data-reduce-animations");
    });

    it("fires a WAAPI opacity flash on the commit-flash overlay after a keystroke broadcast", () => {
      const { animate } = installAnimateShim();
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

      dispatchKeyDown(textarea, { key: "a" });

      // Each keystroke dispatches writes + exactly one flash animation.
      expect(animate).toHaveBeenCalledTimes(1);
      const [keyframes, options] = animate.mock.calls[0]!;
      expect(keyframes).toEqual([{ opacity: 0 }, { opacity: 0.55 }, { opacity: 0 }]);
      expect(options).toMatchObject({ duration: 200, fill: "both" });
    });

    it("cancels any in-flight flash before starting a new one so rapid keystrokes don't stack", () => {
      const { animate, animations } = installAnimateShim();
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

      dispatchKeyDown(textarea, { key: "a" });
      dispatchKeyDown(textarea, { key: "b" });

      expect(animate).toHaveBeenCalledTimes(2);
      // The first animation must have been cancelled before the second started.
      expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire a flash when reduce-animations is active", () => {
      const { animate } = installAnimateShim();
      document.body.setAttribute("data-reduce-animations", "true");
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

      dispatchKeyDown(textarea, { key: "a" });

      expect(animate).not.toHaveBeenCalled();
    });

    it("does NOT fire a flash when there are no armed targets (defensive)", () => {
      const { animate } = installAnimateShim();
      // Mount with two armed, then drain synchronously before dispatching.
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;
      act(() => {
        useFleetArmingStore.getState().clear();
      });
      // Composer has unmounted (armedCount === 0), so there's nothing to test
      // against — the absence of a flash when the composer isn't mounted is
      // trivially true. The meaningful guard is the `targets.length > 0` gate.
      expect(textarea.isConnected).toBe(false);
      expect(animate).not.toHaveBeenCalled();
    });

    it("does NOT fire a flash when a benign paste fails for every target", async () => {
      submitMock.mockReset();
      submitMock.mockRejectedValue(new Error("port closed"));
      const { animate } = installAnimateShim();
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

      fireEvent.paste(textarea, {
        clipboardData: {
          getData: (type: string) => (type === "text/plain" ? "hello" : ""),
        },
      });

      await waitFor(() => {
        const last = useNotificationStore.getState().notifications.at(-1)?.message ?? "";
        expect(last).toBe("Paste failed — no agents received the payload");
      });
      // Flash must not fire when every target rejects — a confirming glow on a
      // failed send would mislead the user.
      expect(animate).not.toHaveBeenCalled();
    });

    it("fires a flash after a confirmed destructive paste reaches targets", async () => {
      const { animate } = installAnimateShim();
      armTwo();
      render(<FleetComposer />);
      const textarea = screen.getByTestId("fleet-composer-textarea") as HTMLTextAreaElement;

      fireEvent.paste(textarea, {
        clipboardData: {
          getData: (type: string) => (type === "text/plain" ? "rm -rf dist" : ""),
        },
      });
      fireEvent.click(await screen.findByTestId("fleet-composer-confirm-send"));

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
      // Flash fires once on the successful confirmed-paste path.
      expect(animate).toHaveBeenCalled();
    });
  });
});
