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

import { CanopyTerminal, type CanopyStreamState } from "../CanopyTerminal";

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

function mount() {
  const states: CanopyStreamState[] = [];
  const view = render(
    <CanopyTerminal runId="run-1" spawnedAt={100} onStreamChange={(s) => states.push(s)} />
  );
  return { ...view, states, frame: view.container.querySelector("[data-canopy-terminal]")! };
}

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
      // Fractional, as layout reports it: 838.6 × 504.6 holds no more than 838 × 504.
      view.frame.getBoundingClientRect = () =>
        ({ width: 838.6, height: 504.6, top: 0, left: 0, right: 838.6, bottom: 504.6 }) as DOMRect;
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

  it("says it couldn't show a terminal the host had no screen for", async () => {
    const { container } = mount();
    await open({ watchId: 7, snapshot: null });
    expect(container.textContent).toContain("Couldn't show this terminal");
  });
});
