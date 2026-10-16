// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { CanopyTerminalData, CanopyTerminalView } from "@shared/types/ipc/canopy";

const xterm = vi.hoisted(() => ({
  current: null as null | {
    writes: Array<string | Uint8Array>;
    resizes: Array<[number, number]>;
    emitData: (data: string) => void;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    buffer = {
      active: { baseY: 0, cursorY: 0, getLine: () => ({ translateToString: () => "" }) },
      onBufferChange: () => ({ dispose() {} }),
    };
    private onDataListener: ((data: string) => void) | null = null;
    cols = 80;
    rows = 24;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.current = {
        writes: [],
        resizes: [],
        emitData: (data) => this.onDataListener?.(data),
      };
    }
    open() {}
    focus() {}
    reset() {
      xterm.current!.writes.push("<reset>");
    }
    write(data: string | Uint8Array, callback?: () => void) {
      xterm.current!.writes.push(data);
      callback?.();
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      xterm.current!.resizes.push([cols, rows]);
    }
    onDimensionsChange() {
      return { dispose() {} };
    }
    onData(listener: (data: string) => void) {
      this.onDataListener = listener;
      return { dispose: () => (this.onDataListener = null) };
    }
    loadAddon() {}
    dispose() {}
  },
}));
const cell = vi.hoisted(() => ({ current: null as null | { width: number; height: number } }));
vi.mock("@/services/terminal/TerminalResizeController", () => ({
  getXtermCellDimensions: () => cell.current,
}));
const pane = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    holdGeometry: (id: string) => {
      pane.events.push(`hold ${id}`);
      return () => pane.events.push(`release ${id}`);
    },
  },
}));

vi.mock("@xterm/addon-webgl", () => {
  throw new Error("no WebGL in jsdom");
});

import {
  CanopyTerminal,
  _resetCanopyWatchBurstForTests,
  type CanopyStreamState,
} from "../CanopyTerminal";
import type { CanopyTerminalApi } from "../canopyHostSource";

let pushChunk: (chunk: CanopyTerminalData) => void = () => {};
let openStream: (view: CanopyTerminalView) => void = () => {};
const terminalInput = vi.fn(async () => {});
const terminalResize = vi.fn(async (_watchId: number, _cols: number, _rows: number) => {});

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
});

beforeEach(() => {
  _resetCanopyWatchBurstForTests();
  terminalInput.mockClear();
  pane.events.length = 0;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      canopy: {
        onTerminalData: (callback: (chunk: CanopyTerminalData) => void) => {
          pushChunk = callback;
          return () => {};
        },
        watchTerminal: () => new Promise<CanopyTerminalView>((resolve) => (openStream = resolve)),
        unwatchTerminal: vi.fn(async () => {}),
        terminalInput,
        terminalResize,
      },
    },
  });
});

afterEach(() => {
  cell.current = null;
  terminalResize.mockClear();
  xterm.current = null;
});

const data = (watchId: number, text: string, streamEnd?: number): CanopyTerminalData => ({
  kind: "data",
  watchId,
  runId: "run-1",
  data: text,
  ...(streamEnd === undefined ? {} : { streamEnd }),
});

function mount(onGoTo?: () => void) {
  const states: CanopyStreamState[] = [];
  const view = render(
    <CanopyTerminal
      runId="run-1"
      spawnedAt={100}
      onStreamChange={(s) => states.push(s)}
      {...(onGoTo ? { onGoTo } : {})}
    />
  );
  return { ...view, states, frame: view.container.querySelector("[data-canopy-terminal]")! };
}

/** Fractional, as layout reports it: 838.6 × 504.6 holds no more than 838 × 504. */
const paneRect = () =>
  ({ width: 838.6, height: 504.6, top: 0, left: 0, right: 838.6, bottom: 504.6 }) as DOMRect;

/** Past the pane's size settle, so a hold it would ask for has been asked for. */
const PAST_SIZE_SETTLE_MS = 200;

/** Long enough for xterm's composition timer, and the gesture's, to have run. */
const COMPOSITION_SENT_MS = 10;

async function open(view: CanopyTerminalView) {
  await act(async () => openStream(view));
}

describe("CanopyTerminal", () => {
  it("paints the snapshot, then only the early output it does not already hold", async () => {
    mount();
    // Arrives before the call that opened the stream has returned.
    pushChunk(data(7, "abc", 8));
    pushChunk(data(7, "defgh", 13));
    await open({
      watchId: 7,
      snapshot: {
        data: "SCREEN",
        cols: 100,
        rows: 30,
        continuation: { pendingEscapeTail: "", streamOffset: 10 },
      },
    });
    expect(xterm.current!.resizes).toEqual([[100, 30]]);
    // 0–8 is covered; of 8–13 only what lies past 10 is new.
    expect(xterm.current!.writes).toEqual(["SCREEN", "fgh"]);
  });

  it("drops early output it cannot fence rather than risk drawing it twice", async () => {
    mount();
    pushChunk(data(7, "maybe twice", 8));
    await open({ watchId: 7, snapshot: { data: "SCREEN", cols: 80, rows: 24 } });
    pushChunk(data(7, "after"));
    expect(xterm.current!.writes).toEqual(["SCREEN", "after"]);
  });

  it("ignores output from a stream the view has moved on from", async () => {
    mount();
    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });
    pushChunk(data(6, "stale"));
    expect(xterm.current!.writes).toEqual([""]);
  });

  it("follows the PTY's size", async () => {
    mount();
    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });
    pushChunk({ kind: "resize", watchId: 7, runId: "run-1", cols: 132, rows: 40 });
    expect(xterm.current!.resizes.at(-1)).toEqual([132, 40]);
  });

  it("sends what the user types, never the terminal's own replies to the program", async () => {
    const { frame } = mount();
    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });

    // A cursor-position report xterm generates while parsing output.
    xterm.current!.emitData("\x1b[24;1R");
    expect(terminalInput).not.toHaveBeenCalled();

    fireEvent.keyDown(frame, { key: "y" });
    xterm.current!.emitData("y");
    expect(terminalInput).toHaveBeenCalledWith(7, "y");
  });

  it("takes text an input method composes, which xterm sends a task after the composition ends", async () => {
    const { frame } = mount();
    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });
    fireEvent.compositionEnd(frame, { data: "é" });
    // xterm's own composition timer, queued after the gesture's.
    setTimeout(() => xterm.current!.emitData("é"), 0);
    await act(() => new Promise((resolve) => setTimeout(resolve, COMPOSITION_SENT_MS)));
    expect(terminalInput).toHaveBeenCalledWith(7, "é");
  });

  it("never sends the terminal's own replies, even inside a gesture", async () => {
    const { frame } = mount();
    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });
    fireEvent.keyDown(frame, { key: "y" });
    // A cursor-position report parsed while the key was going in.
    xterm.current!.emitData("\x1b[24;1R");
    xterm.current!.emitData("y");
    // Focusing the view tells the agent nothing.
    fireEvent.mouseDown(frame);
    xterm.current!.emitData("\x1b[I");
    expect(terminalInput.mock.calls).toEqual([[7, "y"]]);
  });

  it("takes a key an input method holds, which xterm sends a task later", async () => {
    const { frame } = mount();
    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });
    fireEvent.keyDown(frame, { key: "Process", keyCode: 229 });
    setTimeout(() => xterm.current!.emitData("あ"), 0);
    await act(() => new Promise((resolve) => setTimeout(resolve, COMPOSITION_SENT_MS)));
    expect(terminalInput).toHaveBeenCalledWith(7, "あ");
  });

  it("opens a stream at once, but waits out a burst of selections for the one that settles", () => {
    vi.useFakeTimers();
    try {
      const watch = vi.fn(() => new Promise<CanopyTerminalView>(() => {}));
      window.electron.canopy.watchTerminal = watch;
      mount().unmount();
      expect(watch).toHaveBeenCalledTimes(1);
      mount().unmount();
      const settled = mount();
      expect(watch).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(watch).toHaveBeenCalledTimes(2);
      settled.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes no input before the stream opens or after its terminal ends", async () => {
    const { frame, states } = mount();
    fireEvent.keyDown(frame, { key: "y" });
    xterm.current!.emitData("y");
    expect(terminalInput).not.toHaveBeenCalled();

    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });
    expect(states.at(-1)?.watchId).toBe(7);
    await act(async () => pushChunk({ kind: "ended", watchId: 7, runId: "run-1" }));
    expect(states.at(-1)).toMatchObject({ watchId: null, ended: true });
    fireEvent.keyDown(frame, { key: "y" });
    xterm.current!.emitData("y");
    expect(terminalInput).not.toHaveBeenCalled();
  });

  it("scrolls a grid wider than the pane sideways, before xterm can take the gesture", async () => {
    const { frame } = mount();
    await open({ watchId: 7, snapshot: { data: "", cols: 400, rows: 24 } });
    Object.defineProperty(frame, "scrollWidth", { configurable: true, value: 2000 });
    Object.defineProperty(frame, "clientWidth", { configurable: true, value: 800 });
    const inner = frame.firstElementChild!;
    const reachedXterm = vi.fn();
    inner.addEventListener("wheel", reachedXterm);

    inner.dispatchEvent(new WheelEvent("wheel", { deltaX: 120, deltaY: 4, bubbles: true }));
    expect(frame.scrollLeft).toBe(120);
    expect(reachedXterm).not.toHaveBeenCalled();

    // Mostly vertical: xterm's own scrolling, untouched.
    inner.dispatchEvent(new WheelEvent("wheel", { deltaX: 2, deltaY: 60, bubbles: true }));
    expect(frame.scrollLeft).toBe(120);
    expect(reachedXterm).toHaveBeenCalledTimes(1);
  });

  describe("sizing the PTY to the pane", () => {
    async function openSized(
      resize: (watchId: number, cols: number, rows: number) => Promise<void> = async () => {}
    ) {
      terminalResize.mockImplementation(resize);
      cell.current = { width: 8, height: 16 };
      const view = mount();
      view.frame.getBoundingClientRect = paneRect;
      await open({ watchId: 7, snapshot: { data: "", cols: 200, rows: 60 } });
      await settle();
      return view;
    }
    const settle = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("asks for the grid its pane fits at the user's font, once the stream is open", async () => {
      await openSized();
      // (838 − 24 inset − 15 scrollbar) / 8 = 99 columns; (504 − 24) / 16 = 30 rows.
      expect(terminalResize).toHaveBeenCalledTimes(1);
      expect(terminalResize).toHaveBeenCalledWith(7, 99, 30);
      expect(xterm.current!.resizes.at(-1)).toEqual([99, 30]);
    });

    it("asks once: the PTY's echo settles it", async () => {
      await openSized();
      await act(async () =>
        pushChunk({ kind: "resize", watchId: 7, runId: "run-1", cols: 99, rows: 30 })
      );
      await settle();
      expect(terminalResize).toHaveBeenCalledTimes(1);
    });

    it("asks again when the terminal's own pane resizes the PTY out from under it", async () => {
      await openSized();
      await act(async () =>
        pushChunk({ kind: "resize", watchId: 7, runId: "run-1", cols: 99, rows: 30 })
      );
      await act(async () =>
        pushChunk({ kind: "resize", watchId: 7, runId: "run-1", cols: 140, rows: 40 })
      );
      await settle();
      expect(terminalResize).toHaveBeenCalledTimes(2);
      expect(terminalResize).toHaveBeenLastCalledWith(7, 99, 30);
    });

    it("puts its grid back to the PTY's when the size is refused", async () => {
      await openSized(async () => {
        throw new Error("rate limited");
      });
      await settle();
      expect(xterm.current!.resizes.at(-1)).toEqual([200, 60]);
    });
  });

  it("freezes the terminal's own pane while streaming, and lets it go only once main has the PTY back", async () => {
    let handBack: () => void = () => {};
    window.electron.canopy.unwatchTerminal = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          handBack = () => {
            pane.events.push("handed back");
            resolve();
          };
        })
    );
    const { unmount } = mount();
    expect(pane.events).toEqual([]);
    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });
    expect(pane.events).toEqual(["hold run-1"]);

    unmount();
    expect(pane.events).toEqual(["hold run-1"]);
    await act(async () => handBack());
    expect(pane.events).toEqual(["hold run-1", "handed back", "release run-1"]);
  });

  it("freezes no pane for a stream that opens only after the view went away", async () => {
    const { unmount } = mount();
    unmount();
    await open({ watchId: 7, snapshot: { data: "", cols: 80, rows: 24 } });
    expect(pane.events).toEqual([]);
    expect(window.electron.canopy.unwatchTerminal).toHaveBeenCalled();
  });

  it("says it couldn't show a terminal the host had no screen for, with the way to see it", async () => {
    const onGoTo = vi.fn();
    const { container } = mount(onGoTo);
    await open({ watchId: 7, snapshot: null });
    expect(container.textContent).toContain("Couldn't show this terminal");
    const goTo = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Go to terminal"
    );
    goTo?.click();
    expect(onGoTo).toHaveBeenCalledTimes(1);
  });

  describe("a run on another host (#13387)", () => {
    function remoteApi() {
      const opens: Array<(view: CanopyTerminalView) => void> = [];
      let resync: () => void = () => {};
      let push: (chunk: CanopyTerminalData) => void = () => {};
      const api: CanopyTerminalApi = {
        holdsSize: false,
        watchTerminal: vi.fn(
          () => new Promise<CanopyTerminalView>((resolve) => opens.push(resolve))
        ),
        unwatchTerminal: vi.fn(async () => {}),
        terminalInput: vi.fn(async () => {}),
        terminalResize: vi.fn(async () => {}),
        terminalSubmit: vi.fn(async () => {}),
        terminalSendKey: vi.fn(async () => {}),
        answer: vi.fn(async () => {}),
        onTerminalData: (callback) => {
          push = callback;
          return () => {};
        },
        onResync: (callback) => {
          resync = callback;
          return () => {};
        },
      };
      return {
        api,
        opens,
        resync: () => resync(),
        push: (chunk: CanopyTerminalData) => push(chunk),
      };
    }

    function mountRemote(remote: ReturnType<typeof remoteApi>, reconnecting = false) {
      const states: CanopyStreamState[] = [];
      const element = (down: boolean) => (
        <CanopyTerminal
          runId="run-1"
          spawnedAt={100}
          api={remote.api}
          reconnecting={down}
          onStreamChange={(state) => states.push(state)}
        />
      );
      const view = render(element(reconnecting));
      return {
        ...view,
        states,
        setReconnecting: (down: boolean) => view.rerender(element(down)),
        frame: view.container.querySelector("[data-canopy-terminal]")!,
      };
    }

    it("follows the size the host's own window gave the terminal, freezing and sizing nothing", async () => {
      cell.current = { width: 8, height: 16 };
      const remote = remoteApi();
      const view = mountRemote(remote);
      // A pane that fits a grid other than the PTY's: the window's own host would ask for it.
      view.frame.getBoundingClientRect = paneRect;
      await act(async () =>
        remote.opens[0]!({ watchId: 3, snapshot: { data: "S", cols: 90, rows: 30 } })
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, PAST_SIZE_SETTLE_MS));
      });
      expect(remote.api.terminalResize).not.toHaveBeenCalled();
      expect(xterm.current!.resizes).toEqual([[90, 30]]);
      expect(pane.events).toEqual([]);
      remote.push({ kind: "data", watchId: 3, runId: "run-1", data: "x" });
      expect(xterm.current!.writes).toEqual(["S", "x"]);
      // Nor does the local window's own channel hear any of it.
      expect(terminalResize).not.toHaveBeenCalled();
    });

    it("stops input while the link is down, says so, and starts again from a fresh screen", async () => {
      const remote = remoteApi();
      const view = mountRemote(remote);
      await act(async () =>
        remote.opens[0]!({ watchId: 3, snapshot: { data: "OLD", cols: 80, rows: 24 } })
      );
      expect(view.states.at(-1)?.watchId).toBe(3);

      view.setReconnecting(true);
      expect(view.states.at(-1)?.watchId).toBeNull();
      expect(view.container.querySelector("[data-canopy-reconnecting]")?.textContent).toBe(
        "Reconnecting…"
      );
      // Typed at a screen the agent may no longer show: never sent, then or later.
      fireEvent.keyDown(view.frame, { key: "y" });
      xterm.current!.emitData("y");
      expect(remote.api.terminalInput).not.toHaveBeenCalled();

      // The link's return: the old stream died with it, so a new one is opened,
      // on a new xterm — the old one's parser may be mid-sequence.
      const oldScreen = xterm.current!;
      _resetCanopyWatchBurstForTests();
      await act(async () => remote.resync());
      expect(remote.opens).toHaveLength(2);
      expect(xterm.current).not.toBe(oldScreen);
      // Output still in flight for the old stream lands on nothing.
      remote.push({ kind: "data", watchId: 3, runId: "run-1", data: "late" });
      await act(async () =>
        remote.opens[1]!({ watchId: 4, snapshot: { data: "NEW", cols: 80, rows: 24 } })
      );
      expect(xterm.current!.writes).toEqual(["NEW"]);
      // Shown, but not typed into until the link reads as up.
      expect(view.states.at(-1)?.watchId ?? null).toBeNull();
      fireEvent.keyDown(view.frame, { key: "y" });
      xterm.current!.emitData("y");
      expect(remote.api.terminalInput).not.toHaveBeenCalled();

      view.setReconnecting(false);
      expect(view.states.at(-1)?.watchId).toBe(4);
      expect(view.container.querySelector("[data-canopy-reconnecting]")).toBeNull();
      // One stream: the link reading as up doesn't open another.
      expect(remote.opens).toHaveLength(2);
      expect(remote.api.terminalInput).not.toHaveBeenCalled();
    });

    it("opens nothing the link dropped before its burst wait was over", async () => {
      vi.useFakeTimers();
      try {
        const first = remoteApi();
        const view = mountRemote(first);
        // Another row picked at once waits out the burst before asking for a stream.
        view.unmount();
        const second = remoteApi();
        const next = mountRemote(second);
        next.setReconnecting(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(second.opens).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a run that exited while the link was coming back ended, not live", async () => {
      const remote = remoteApi();
      const view = mountRemote(remote);
      await act(async () =>
        remote.opens[0]!({ watchId: 3, snapshot: { data: "S", cols: 80, rows: 24 } })
      );
      view.setReconnecting(true);
      _resetCanopyWatchBurstForTests();
      await act(async () => remote.resync());
      // Opened while the link still reads as down: held, then the run exits.
      await act(async () =>
        remote.opens[1]!({ watchId: 4, snapshot: { data: "S", cols: 80, rows: 24 } })
      );
      await act(async () => remote.push({ kind: "ended", watchId: 4, runId: "run-1" }));
      view.setReconnecting(false);
      expect(view.states.at(-1)).toMatchObject({ watchId: null, ended: true });
      expect(view.container.textContent).toContain("This terminal has exited");
    });

    it("ignores the answer to a stream it asked for before the link dropped", async () => {
      const remote = remoteApi();
      const view = mountRemote(remote);
      _resetCanopyWatchBurstForTests();
      await act(async () => remote.resync());
      await act(async () =>
        remote.opens[1]!({ watchId: 5, snapshot: { data: "NEW", cols: 80, rows: 24 } })
      );
      await act(async () =>
        remote.opens[0]!({ watchId: 4, snapshot: { data: "OLD", cols: 80, rows: 24 } })
      );
      expect(view.states.at(-1)?.watchId).toBe(5);
      expect(xterm.current!.writes).toEqual(["NEW"]);
    });

    it("offers to try again when it couldn't show the terminal, there being no pane here to go to", async () => {
      const remote = remoteApi();
      const { container } = mountRemote(remote);
      await act(async () => remote.opens[0]!({ watchId: 3, snapshot: null }));
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry"
      );
      _resetCanopyWatchBurstForTests();
      await act(async () => retry?.click());
      expect(remote.opens).toHaveLength(2);
    });
  });
});
