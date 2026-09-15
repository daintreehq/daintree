// @vitest-environment node
//
// Real xterm buffers, no DOM: `@xterm/headless` is the same core as the
// renderer's `@xterm/xterm`, so the ED3 handler, the DECSTBM scrolling and the
// parser-handler ordering exercised here are the ones that ship. The render
// step the browser build waits on is driven by hand — headless never paints.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import {
  installViewportAnchorController,
  REPLAY_QUIET_MS,
  type ViewportAnchorController,
  type ViewportAnchorDeps,
} from "../TerminalViewportAnchorController";

const ESC = "\x1b";
const BSU = `${ESC}[?2026h`;
const ESU = `${ESC}[?2026l`;
// The bytes Codex 0.154 writes before re-inserting its transcript
// (`clear_terminal_for_resize_replay`, inline mode). Captured with tmux
// `pipe-pane` while shrinking the window by one row (#12398).
const CODEX_CLEAR = `${ESC}[r${ESC}[0m${ESC}[H${ESC}[2J${ESC}[3J${ESC}[H`;

const ROWS = 24;
const COLS = 80;
const TRANSCRIPT_LINES = 200;
const SCROLL_BACK_BY = 40;

const transcriptLine = (i: number): string =>
  `line ${String(i).padStart(4, "0")} of the transcript`;
const transcript = (count = TRANSCRIPT_LINES, prefix = ""): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${transcriptLine(i + 1)}`);

/**
 * The captured burst: the previous frame's ESU, the clear (outside any sync
 * block — openai/codex#25622), then the replay in its own block: DECSTBM
 * `1;rows-1` with reverse indexes to lay out the screen, DECSTBM `1;10` with
 * the transcript scrolling through the region into scrollback, region reset,
 * ESU.
 */
function codexReplayBurst(lines: string[]): string {
  const layout = `${ESC}[1;${ROWS - 1}r${`${ESC}M`.repeat(ROWS - 1)}`;
  const body = lines.map((line) => `${line}\r\n`).join("");
  return `${ESU}${CODEX_CLEAR}${BSU}${layout}${ESC}[1;10r${body}${ESC}[r${ESU}`;
}

const writeAndFlush = (terminal: Terminal, data: string): Promise<void> =>
  new Promise<void>((resolve) => terminal.write(data, () => resolve()));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeTerminal(): Terminal {
  return new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
}

const topLine = (terminal: Terminal): string =>
  terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true) ?? "";

interface Harness {
  controller: ViewportAnchorController;
  deps: {
    isOwnClear: ReturnType<typeof vi.fn<() => boolean>>;
    syncViewport: ReturnType<typeof vi.fn<() => void>>;
    getUnseen: ReturnType<typeof vi.fn<() => number>>;
    restoreUnseen: ReturnType<typeof vi.fn<(count: number) => void>>;
  };
  /** Run every render callback the controller is waiting on, once. */
  flushRender: () => void;
  pendingRenders: () => number;
}

function install(terminal: Terminal, overrides: Partial<ViewportAnchorDeps> = {}): Harness {
  const renders: Array<() => void> = [];
  const deps = {
    isOwnClear: vi.fn<() => boolean>(() => false),
    syncViewport: vi.fn<() => void>(),
    getUnseen: vi.fn<() => number>(() => 0),
    restoreUnseen: vi.fn<(count: number) => void>(),
  };
  const controller = installViewportAnchorController(terminal, {
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
  return {
    controller,
    deps,
    flushRender: () => {
      for (const callback of renders.splice(0)) callback();
    },
    pendingRenders: () => renders.length,
  };
}

/** A terminal full of transcript, scrolled back by `SCROLL_BACK_BY` rows. */
async function scrolledBackTerminal(): Promise<{ terminal: Terminal; anchorLine: string }> {
  const terminal = makeTerminal();
  await writeAndFlush(terminal, transcript().join("\r\n") + "\r\n");
  const buffer = terminal.buffer.active;
  expect(buffer.baseY).toBeGreaterThan(SCROLL_BACK_BY);
  terminal.scrollLines(-SCROLL_BACK_BY);
  expect(buffer.viewportY).toBe(buffer.baseY - SCROLL_BACK_BY);
  return { terminal, anchorLine: topLine(terminal) };
}

describe("TerminalViewportAnchorController (real xterm)", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });
  const track = (terminal: Terminal, harness?: Harness): void => {
    cleanup.push(() => {
      harness?.controller.dispose();
      terminal.dispose();
    });
  };

  it("control: without the controller the replay parks a scrolled-back reader on line 0", async () => {
    const { terminal } = await scrolledBackTerminal();
    track(terminal);

    await writeAndFlush(terminal, codexReplayBurst(transcript()));

    const buffer = terminal.buffer.active;
    expect(buffer.baseY).toBeGreaterThan(0);
    expect(buffer.viewportY).toBe(0);
    expect(topLine(terminal)).toBe(transcriptLine(1));
  });

  it("restores a scrolled-back reader to the same content after the replay", async () => {
    const { terminal, anchorLine } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    await writeAndFlush(terminal, codexReplayBurst(transcript()));
    // The parser saw ESC[3J then the closing ESU; the scroll waits for a render.
    expect(harness.controller.phase).toBe("restoring");
    expect(terminal.buffer.active.viewportY).toBe(0);

    harness.flushRender();
    expect(topLine(terminal)).toBe(anchorLine);
    expect(harness.deps.syncViewport).toHaveBeenCalledTimes(1);

    // The read-back on the following frame confirms the scroll took.
    harness.flushRender();
    expect(harness.controller.phase).toBe("idle");
    expect(topLine(terminal)).toBe(anchorLine);
    expect(harness.pendingRenders()).toBe(0);
  });

  it("leaves a bottom-pinned reader following the rebuilt transcript", async () => {
    const terminal = makeTerminal();
    const harness = install(terminal);
    track(terminal, harness);
    await writeAndFlush(terminal, transcript().join("\r\n") + "\r\n");

    await writeAndFlush(terminal, codexReplayBurst(transcript()));

    expect(harness.controller.phase).toBe("idle");
    const buffer = terminal.buffer.active;
    expect(buffer.viewportY).toBe(buffer.baseY);
    expect(harness.deps.restoreUnseen).not.toHaveBeenCalled();
  });

  it("hands the unseen count back to its value at the erase", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    harness.deps.getUnseen.mockReturnValue(7);
    track(terminal, harness);

    await writeAndFlush(terminal, codexReplayBurst(transcript()));

    expect(harness.deps.restoreUnseen).toHaveBeenCalledTimes(1);
    expect(harness.deps.restoreUnseen).toHaveBeenCalledWith(7);
  });

  it("drops the restore when the reader scrolls during the replay", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    await writeAndFlush(terminal, codexReplayBurst(transcript()));
    expect(harness.controller.phase).toBe("restoring");

    // A scrollbar drag or PageDown: the buffer moves off the parked position.
    terminal.scrollLines(5);
    expect(harness.controller.phase).toBe("idle");
    expect(harness.pendingRenders()).toBe(0);

    harness.flushRender();
    expect(terminal.buffer.active.viewportY).toBe(5);
  });

  it("a wheel gesture cancels even before the replay ends", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    await writeAndFlush(terminal, `${ESU}${CODEX_CLEAR}${BSU}`);
    expect(harness.controller.phase).toBe("armed");

    harness.controller.cancel();
    expect(harness.controller.phase).toBe("idle");

    await writeAndFlush(terminal, `${transcript().join("\r\n")}\r\n${ESU}`);
    expect(harness.controller.phase).toBe("idle");
    expect(harness.deps.restoreUnseen).not.toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(0);
  });

  it("a plain clear with no sync block settles at line 0 without scrolling", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);
    const scrollToLine = vi.spyOn(terminal, "scrollToLine");

    await writeAndFlush(terminal, `${ESC}[H${ESC}[2J${ESC}[3J`);
    expect(harness.controller.phase).toBe("armed");

    await sleep(REPLAY_QUIET_MS + 50);
    expect(harness.controller.phase).toBe("restoring");
    harness.flushRender();

    expect(harness.controller.phase).toBe("idle");
    expect(scrollToLine).not.toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(0);
  });

  it("ignores an erase on the alternate buffer", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    await writeAndFlush(terminal, `${ESC}[?1049h${ESC}[2J${ESC}[3J`);

    expect(terminal.buffer.active.type).toBe("alternate");
    expect(harness.controller.phase).toBe("idle");
  });

  it("ignores Daintree's own clears", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    harness.deps.isOwnClear.mockReturnValue(true);
    track(terminal, harness);

    await writeAndFlush(terminal, codexReplayBurst(transcript()));

    expect(harness.controller.phase).toBe("idle");
    expect(terminal.buffer.active.viewportY).toBe(0);
    expect(harness.deps.restoreUnseen).not.toHaveBeenCalled();
  });

  it("falls back to the distance from bottom when the anchor text is gone", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    await writeAndFlush(terminal, codexReplayBurst(transcript(TRANSCRIPT_LINES, "rewritten ")));
    harness.flushRender();

    const buffer = terminal.buffer.active;
    expect(buffer.viewportY).toBe(buffer.baseY - SCROLL_BACK_BY);
  });

  it("falls back to the distance from bottom after a width change, even when the text still matches", async () => {
    const { terminal, anchorLine } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    await writeAndFlush(terminal, `${ESU}${CODEX_CLEAR}`);
    expect(harness.controller.phase).toBe("armed");
    // Nothing here wraps at 70 columns, so a text search would still find the
    // anchor; the guard must not trust it once the grid width moved.
    terminal.resize(COLS - 10, ROWS);
    await writeAndFlush(
      terminal,
      codexReplayBurst(transcript()).slice(ESU.length + CODEX_CLEAR.length)
    );
    harness.flushRender();

    const buffer = terminal.buffer.active;
    expect(buffer.viewportY).toBe(buffer.baseY - SCROLL_BACK_BY);
    expect(topLine(terminal)).not.toBe(anchorLine);
  });

  it("a second erase mid-replay keeps the original anchor", async () => {
    const { terminal, anchorLine } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    // The first redraw is abandoned part-way; the program clears and starts over.
    const partial = transcript(30)
      .map((line) => `${line}\r\n`)
      .join("");
    await writeAndFlush(terminal, `${ESU}${CODEX_CLEAR}${BSU}${ESC}[1;10r${partial}`);
    expect(harness.controller.phase).toBe("armed");
    await writeAndFlush(terminal, codexReplayBurst(transcript()));
    harness.flushRender();

    expect(topLine(terminal)).toBe(anchorLine);
  });

  it("a sync-block close with nothing in scrollback yet is not the end of the replay", async () => {
    const { terminal, anchorLine } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    // A frame that clears just before closing its own block.
    await writeAndFlush(terminal, `${BSU}${CODEX_CLEAR}${ESU}`);
    expect(harness.controller.phase).toBe("armed");

    const replay = codexReplayBurst(transcript()).slice(ESU.length + CODEX_CLEAR.length);
    await writeAndFlush(terminal, replay);
    harness.flushRender();

    expect(topLine(terminal)).toBe(anchorLine);
  });

  it("a redraw shorter than the screen is a no-op", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);
    const scrollToLine = vi.spyOn(terminal, "scrollToLine");

    await writeAndFlush(terminal, codexReplayBurst(transcript(5)));
    // baseY stayed 0, so the ESU did not end it; quiescence does.
    await sleep(REPLAY_QUIET_MS + 50);
    harness.flushRender();

    expect(harness.controller.phase).toBe("idle");
    expect(scrollToLine).not.toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(0);
  });
});
