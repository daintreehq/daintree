// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { TriageTerminalData, TriageTerminalView } from "@shared/types/ipc/triage";

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
    buffer = { active: { baseY: 0, cursorY: 0, getLine: () => ({ translateToString: () => "" }) } };
    private onDataListener: ((data: string) => void) | null = null;
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
      xterm.current!.resizes.push([cols, rows]);
    }
    onData(listener: (data: string) => void) {
      this.onDataListener = listener;
      return { dispose: () => (this.onDataListener = null) };
    }
    loadAddon() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-webgl", () => {
  throw new Error("no WebGL in jsdom");
});

import { TriageTerminal, type TriageStreamState } from "../TriageTerminal";

let pushChunk: (chunk: TriageTerminalData) => void = () => {};
let openStream: (view: TriageTerminalView) => void = () => {};
const terminalInput = vi.fn(async () => {});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  terminalInput.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      triage: {
        onTerminalData: (callback: (chunk: TriageTerminalData) => void) => {
          pushChunk = callback;
          return () => {};
        },
        watchTerminal: () => new Promise<TriageTerminalView>((resolve) => (openStream = resolve)),
        unwatchTerminal: vi.fn(async () => {}),
        terminalInput,
      },
    },
  });
});

afterEach(() => {
  xterm.current = null;
});

const data = (watchId: number, text: string, streamEnd?: number): TriageTerminalData => ({
  kind: "data",
  watchId,
  runId: "run-1",
  data: text,
  ...(streamEnd === undefined ? {} : { streamEnd }),
});

function mount() {
  const states: TriageStreamState[] = [];
  const view = render(
    <TriageTerminal runId="run-1" spawnedAt={100} onStreamChange={(s) => states.push(s)} />
  );
  return { ...view, states, frame: view.container.querySelector("[data-triage-terminal]")! };
}

async function open(view: TriageTerminalView) {
  await act(async () => openStream(view));
}

describe("TriageTerminal", () => {
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

  it("says it couldn't show a terminal the host had no screen for", async () => {
    const { container } = mount();
    await open({ watchId: 7, snapshot: null });
    expect(container.textContent).toContain("Couldn't show this terminal");
  });
});
