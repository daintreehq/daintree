// @vitest-environment node
//
// The timing and retry legs of the state machine against a scripted terminal,
// where a scroll can be made to miss and the clock can be driven. The replay
// suite next door covers the same controller on real xterm buffers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANCHOR_LINE_COUNT,
  installViewportAnchorController,
  RENDER_WAIT_MS,
  REPLAY_DEADLINE_MS,
  REPLAY_QUIET_MS,
  type ViewportAnchorController,
  type ViewportAnchorDeps,
  type ViewportAnchorTerminal,
} from "../TerminalViewportAnchorController";

type CsiParams = (number | number[])[];

interface FakeTerminal extends ViewportAnchorTerminal {
  lines: string[];
  viewportY: number;
  baseY: number;
  bufferType: "normal" | "alternate";
  synchronizedOutput: boolean;
  /** Rows short of the request a `scrollToLine` lands — a scroll against stale DOM dimensions. */
  scrollShortBy: number;
  ed3(): void;
  esu(): void;
  writeParsed(): void;
  fireScroll(): void;
  scrollToLine: ReturnType<typeof vi.fn<(line: number) => void>>;
  disposed: string[];
}

const ORIGINAL_LINES = 200;
const originalLines = (): string[] => Array.from({ length: ORIGINAL_LINES }, (_, i) => `line ${i}`);

function makeFakeTerminal(): FakeTerminal {
  const csi = new Map<string, (params: CsiParams) => boolean>();
  const scrollListeners = new Set<(position: number) => void>();
  const writeParsedListeners = new Set<() => void>();
  const disposed: string[] = [];

  const fake: FakeTerminal = {
    cols: 80,
    rows: 24,
    lines: originalLines(),
    viewportY: 100,
    baseY: ORIGINAL_LINES - 24,
    bufferType: "normal",
    synchronizedOutput: false,
    scrollShortBy: 0,
    disposed,
    get buffer() {
      return {
        active: {
          get type() {
            return fake.bufferType;
          },
          get viewportY() {
            return fake.viewportY;
          },
          get baseY() {
            return fake.baseY;
          },
          getLine: (y: number) => {
            const text = fake.lines[y];
            return text === undefined ? undefined : { translateToString: () => text };
          },
        },
      };
    },
    get modes() {
      return { synchronizedOutputMode: fake.synchronizedOutput };
    },
    parser: {
      registerCsiHandler: (id, callback) => {
        const key = `${id.prefix ?? ""}${id.final}`;
        csi.set(key, callback);
        return { dispose: () => disposed.push(`csi:${key}`) };
      },
    },
    onScroll: (listener) => {
      scrollListeners.add(listener);
      return { dispose: () => disposed.push("onScroll") };
    },
    onWriteParsed: (listener) => {
      writeParsedListeners.add(listener);
      return { dispose: () => disposed.push("onWriteParsed") };
    },
    scrollToLine: vi.fn<(line: number) => void>((line) => {
      fake.viewportY = Math.max(0, Math.min(fake.baseY, line - fake.scrollShortBy));
      fake.fireScroll();
    }),
    ed3: () => {
      // Our handler runs first and must return false; then xterm's erase runs.
      expect(csi.get("J")?.([3])).toBe(false);
      fake.viewportY = 0;
      fake.baseY = 0;
      fake.lines = [];
    },
    esu: () => {
      expect(csi.get("?l")?.([2026])).toBe(false);
    },
    writeParsed: () => {
      for (const listener of writeParsedListeners) listener();
    },
    fireScroll: () => {
      for (const listener of scrollListeners) listener(fake.viewportY);
    },
  };
  return fake;
}

/** The program re-inserts its transcript: scrollback grows while the reader stays parked at 0. */
function replay(terminal: FakeTerminal, lines: string[]): void {
  terminal.lines = lines;
  terminal.baseY = Math.max(0, lines.length - terminal.rows);
  terminal.viewportY = 0;
  terminal.writeParsed();
  terminal.fireScroll();
}

describe("TerminalViewportAnchorController (scripted terminal)", () => {
  let terminal: FakeTerminal;
  let renders: Array<() => void>;
  let deps: {
    isOwnClear: ReturnType<typeof vi.fn<() => boolean>>;
    syncViewport: ReturnType<typeof vi.fn<() => void>>;
    holdUnseen: ReturnType<typeof vi.fn<() => number>>;
    releaseUnseen: ReturnType<typeof vi.fn<(count: number) => void>>;
  };
  let controller: ViewportAnchorController;

  const flushRender = (): void => {
    for (const callback of renders.splice(0)) callback();
  };

  const install = (overrides: Partial<ViewportAnchorDeps> = {}): void => {
    controller = installViewportAnchorController(terminal, {
      ...deps,
      afterRender: (callback) => {
        renders.push(callback);
        return () => {
          const index = renders.indexOf(callback);
          if (index >= 0) renders.splice(index, 1);
        };
      },
      ...overrides,
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    terminal = makeFakeTerminal();
    renders = [];
    deps = {
      isOwnClear: vi.fn<() => boolean>(() => false),
      syncViewport: vi.fn<() => void>(),
      holdUnseen: vi.fn<() => number>(() => 3),
      releaseUnseen: vi.fn<(count: number) => void>(),
    };
  });

  afterEach(() => {
    controller?.dispose();
    vi.useRealTimers();
  });

  it("arms only for ESC[3J while scrolled back on the normal buffer", () => {
    install();
    terminal.viewportY = terminal.baseY;
    terminal.ed3();
    expect(controller.phase).toBe("idle");

    terminal = makeFakeTerminal();
    controller.dispose();
    install();
    terminal.bufferType = "alternate";
    terminal.ed3();
    expect(controller.phase).toBe("idle");

    terminal = makeFakeTerminal();
    controller.dispose();
    deps.isOwnClear.mockReturnValue(true);
    install();
    terminal.ed3();
    expect(controller.phase).toBe("idle");

    terminal = makeFakeTerminal();
    controller.dispose();
    deps.isOwnClear.mockReturnValue(false);
    install();
    terminal.ed3();
    expect(controller.phase).toBe("armed");
    expect(deps.holdUnseen).toHaveBeenCalledTimes(1);
  });

  it("scrolls to the anchor after the sync block closes and a frame renders", () => {
    install();
    terminal.ed3();
    replay(terminal, originalLines());
    terminal.esu();
    expect(controller.phase).toBe("restoring");
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    // Held until the redraw has landed — the chunk carrying the ESU has not
    // run its parse callback when the handler fires.
    expect(deps.releaseUnseen).not.toHaveBeenCalled();

    flushRender();
    expect(deps.releaseUnseen).toHaveBeenCalledWith(3);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(100);
    expect(deps.syncViewport).toHaveBeenCalledTimes(1);
    expect(terminal.viewportY).toBe(100);

    flushRender();
    expect(controller.phase).toBe("idle");
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(1);
    expect(deps.releaseUnseen).toHaveBeenCalledTimes(1);
  });

  it("prefers the anchor text over the distance guess when the two disagree", () => {
    install();
    terminal.ed3();
    // Three lines appended: the distance guess moves three rows down the
    // rebuilt transcript while the reader's content stays where it was.
    replay(terminal, [...originalLines(), "tail a", "tail b", "tail c"]);
    terminal.esu();
    flushRender();
    expect(terminal.scrollToLine).toHaveBeenCalledWith(100);
  });

  it("uses the distance from bottom when the anchor was blank", () => {
    terminal.lines = terminal.lines.map((line, i) =>
      i >= 100 && i < 100 + ANCHOR_LINE_COUNT ? "" : line
    );
    install();
    terminal.ed3();
    // A blank block nearer the guess than anything else would be the "match"
    // of an all-blank anchor; the guess itself is what the reader gets.
    const rebuilt = ["extra a", "extra b", "extra c", ...originalLines()];
    for (let i = 90; i < 90 + ANCHOR_LINE_COUNT; i++) rebuilt[i] = "";
    replay(terminal, rebuilt);
    terminal.esu();
    flushRender();
    expect(terminal.scrollToLine).toHaveBeenCalledWith(103);
  });

  it("retries once when the first scroll does not take, then gives up", () => {
    install();
    terminal.scrollShortBy = 100;
    terminal.ed3();
    replay(terminal, originalLines());
    terminal.esu();

    flushRender();
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(1);
    expect(controller.phase).toBe("restoring");

    flushRender();
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(2);

    flushRender();
    expect(controller.phase).toBe("idle");
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(2);
    expect(renders).toHaveLength(0);
  });

  it("output scrolling past a short landing does not cancel the retry; reaching the target ends it", () => {
    install();
    terminal.scrollShortBy = 20;
    terminal.ed3();
    replay(terminal, originalLines());
    terminal.esu();
    flushRender();
    expect(terminal.viewportY).toBe(80);

    // Buffer-driven scrolls report the parked (short) position unchanged.
    terminal.fireScroll();
    expect(controller.phase).toBe("restoring");

    // The queued viewport sync carries it the rest of the way.
    terminal.viewportY = 100;
    terminal.fireScroll();
    expect(controller.phase).toBe("restoring");

    flushRender();
    expect(controller.phase).toBe("idle");
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(1);
  });

  it("falls back to quiescence when no sync block follows the erase", () => {
    install();
    terminal.ed3();
    replay(terminal, originalLines());
    vi.advanceTimersByTime(REPLAY_QUIET_MS - 1);
    terminal.writeParsed();
    vi.advanceTimersByTime(REPLAY_QUIET_MS - 1);
    expect(controller.phase).toBe("armed");

    vi.advanceTimersByTime(1);
    expect(controller.phase).toBe("restoring");
    flushRender();
    expect(terminal.scrollToLine).toHaveBeenCalledWith(100);
  });

  it("holds quiescence while synchronized output is on; the deadline restores anyway", () => {
    install();
    terminal.ed3();
    terminal.synchronizedOutput = true;
    replay(terminal, originalLines());
    vi.advanceTimersByTime(REPLAY_QUIET_MS + 1);
    expect(controller.phase).toBe("armed");

    vi.advanceTimersByTime(REPLAY_DEADLINE_MS);
    expect(controller.phase).toBe("restoring");
    flushRender();
    expect(terminal.scrollToLine).toHaveBeenCalledWith(100);
  });

  it("attempts anyway when no frame renders within the wait bound", () => {
    install();
    terminal.ed3();
    replay(terminal, originalLines());
    terminal.esu();
    expect(renders).toHaveLength(1);

    vi.advanceTimersByTime(RENDER_WAIT_MS);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(100);
    // The lapsed wait's render callback is withdrawn, not left to fire twice.
    expect(renders).toHaveLength(1);
    flushRender();
    expect(controller.phase).toBe("idle");
  });

  it("a scroll to a position it did not ask for cancels the restore", () => {
    install();
    terminal.ed3();
    replay(terminal, originalLines());
    terminal.esu();
    expect(controller.phase).toBe("restoring");

    // scrollToBottom from the pill / scrollToLastActivity / a scrollbar drag.
    terminal.viewportY = terminal.baseY;
    terminal.fireScroll();
    expect(controller.phase).toBe("idle");
    expect(renders).toHaveLength(0);
  });

  it("cancel before the replay ends publishes the held count without scrolling", () => {
    install();
    terminal.ed3();
    controller.cancel();
    expect(deps.releaseUnseen).toHaveBeenCalledWith(3);
    replay(terminal, originalLines());
    terminal.esu();
    expect(controller.phase).toBe("idle");
    expect(deps.releaseUnseen).toHaveBeenCalledTimes(1);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a second erase while armed keeps the original anchor and deadline", () => {
    install();
    terminal.ed3();
    // A sync block that never closes: quiescence defers, the deadline decides.
    terminal.synchronizedOutput = true;
    vi.advanceTimersByTime(REPLAY_DEADLINE_MS - 10);
    expect(controller.phase).toBe("armed");
    replay(terminal, originalLines().slice(0, 30));
    terminal.ed3();
    expect(controller.phase).toBe("armed");
    expect(deps.holdUnseen).toHaveBeenCalledTimes(1);
    replay(terminal, originalLines());
    // The first erase's deadline still applies — not a fresh two seconds.
    vi.advanceTimersByTime(10);
    expect(controller.phase).toBe("restoring");
    flushRender();
    expect(terminal.scrollToLine).toHaveBeenCalledWith(100);
  });

  it("a second erase while the restore is being verified restarts the cycle with the original anchor", () => {
    install();
    terminal.ed3();
    replay(terminal, originalLines());
    terminal.esu();
    flushRender();
    expect(terminal.viewportY).toBe(100);
    expect(deps.releaseUnseen).toHaveBeenCalledTimes(1);

    terminal.ed3();
    expect(controller.phase).toBe("armed");
    // The count was published; the next redraw must be held back again.
    expect(deps.holdUnseen).toHaveBeenCalledTimes(2);
    replay(terminal, originalLines());
    expect(controller.phase).toBe("armed");
    terminal.esu();
    flushRender();
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(100);
    expect(terminal.viewportY).toBe(100);
    flushRender();
    expect(controller.phase).toBe("idle");
    expect(deps.releaseUnseen).toHaveBeenCalledTimes(2);
  });

  it("gives up rather than scrolling a buffer that switched to the alternate screen", () => {
    install();
    terminal.ed3();
    replay(terminal, originalLines());
    terminal.esu();
    terminal.bufferType = "alternate";
    flushRender();
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(controller.phase).toBe("idle");
    expect(deps.releaseUnseen).toHaveBeenCalledWith(3);
  });

  it("dispose drops timers, the pending render, and every parser handler", () => {
    install();
    terminal.ed3();
    replay(terminal, originalLines());
    terminal.esu();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(renders).toHaveLength(0);
    expect(terminal.disposed).toEqual(["csi:J", "csi:?l", "onWriteParsed", "onScroll"]);
  });
});
