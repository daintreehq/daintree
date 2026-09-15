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
  return `${ESU}${CODEX_CLEAR}${codexReplay(lines)}`;
}

function codexReplay(lines: string[]): string {
  const layout = `${ESC}[1;${ROWS - 1}r${`${ESC}M`.repeat(ROWS - 1)}`;
  const body = lines.map((line) => `${line}\r\n`).join("");
  return `${BSU}${layout}${ESC}[1;10r${body}${ESC}[r${ESU}`;
}

const writeAndFlush = (terminal: Terminal, data: string): Promise<void> =>
  new Promise<void>((resolve) => terminal.write(data, () => resolve()));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeTerminal(): Terminal {
  return new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
}

const lineAt = (terminal: Terminal, y: number): string =>
  terminal.buffer.active.getLine(y)?.translateToString(true) ?? "";
const topLine = (terminal: Terminal): string => lineAt(terminal, terminal.buffer.active.viewportY);

interface Harness {
  controller: ViewportAnchorController;
  deps: {
    isOwnClear: ReturnType<typeof vi.fn<() => boolean>>;
    syncViewport: ReturnType<typeof vi.fn<() => void>>;
    holdUnseen: ReturnType<typeof vi.fn<() => number>>;
    releaseUnseen: ReturnType<typeof vi.fn<(count: number) => void>>;
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
    holdUnseen: vi.fn<() => number>(() => 0),
    releaseUnseen: vi.fn<(count: number) => void>(),
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

/** A terminal full of transcript, scrolled back by `by` rows. */
async function scrolledBackTerminal(
  by = SCROLL_BACK_BY
): Promise<{ terminal: Terminal; anchorLine: string }> {
  const terminal = makeTerminal();
  await writeAndFlush(terminal, transcript().join("\r\n") + "\r\n");
  const buffer = terminal.buffer.active;
  expect(buffer.baseY).toBeGreaterThan(by);
  terminal.scrollLines(-by);
  expect(buffer.viewportY).toBe(buffer.baseY - by);
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

  it("pins the beta.300 premise: ESC[3J reaches no public onScroll and keeps the reader scrolled back", async () => {
    const { terminal } = await scrolledBackTerminal();
    track(terminal);
    const onScroll = vi.fn();
    terminal.onScroll(onScroll);

    await writeAndFlush(terminal, CODEX_CLEAR);
    expect(onScroll).not.toHaveBeenCalled();
    expect(terminal.buffer.active.baseY).toBe(0);
    expect(terminal.buffer.active.viewportY).toBe(0);

    // The re-inserted lines do reach it — with the parked ydisp, not the bottom.
    await writeAndFlush(terminal, codexReplay(transcript()));
    expect(onScroll).toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(0);
  });

  it("restores a scrolled-back reader to the same content after the replay", async () => {
    const { terminal, anchorLine } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    await writeAndFlush(terminal, codexReplayBurst(transcript()));
    // The parser saw ESC[3J then the closing ESU; the scroll waits for a render.
    expect(harness.controller.phase).toBe("restoring");
    const buffer = terminal.buffer.active;
    expect(buffer.viewportY).toBe(0);
    // The replay's DECSTBM layout shifts the transcript, so the distance guess
    // alone would land on different content — the text anchor is load-bearing.
    expect(lineAt(terminal, buffer.baseY - SCROLL_BACK_BY)).not.toBe(anchorLine);

    harness.flushRender();
    expect(topLine(terminal)).toBe(anchorLine);
    expect(harness.deps.syncViewport).toHaveBeenCalledTimes(1);

    // The read-back on the following frame confirms the scroll took.
    harness.flushRender();
    expect(harness.controller.phase).toBe("idle");
    expect(topLine(terminal)).toBe(anchorLine);
    expect(harness.pendingRenders()).toBe(0);
  });

  it.each([1, 2])(
    "anchors a reader only %i row(s) back on scrollback alone — ED2 has already blanked the screen",
    async (by) => {
      const { terminal, anchorLine } = await scrolledBackTerminal(by);
      const harness = install(terminal);
      track(terminal, harness);

      await writeAndFlush(terminal, codexReplayBurst(transcript()));
      harness.flushRender();

      expect(topLine(terminal)).toBe(anchorLine);
    }
  );

  it("leaves a bottom-pinned reader following the rebuilt transcript", async () => {
    const terminal = makeTerminal();
    const harness = install(terminal);
    track(terminal, harness);
    await writeAndFlush(terminal, transcript().join("\r\n") + "\r\n");

    await writeAndFlush(terminal, codexReplayBurst(transcript()));

    expect(harness.controller.phase).toBe("idle");
    const buffer = terminal.buffer.active;
    expect(buffer.viewportY).toBe(buffer.baseY);
    expect(harness.deps.holdUnseen).not.toHaveBeenCalled();
  });

  it("holds the unseen count from the erase and hands it back once the redraw has landed", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    harness.deps.holdUnseen.mockReturnValue(7);
    track(terminal, harness);

    await writeAndFlush(terminal, codexReplayBurst(transcript()));
    expect(harness.deps.holdUnseen).toHaveBeenCalledTimes(1);
    // Still held: the chunk carrying the ESU has not run its parse callback
    // until after the handler, so releasing here would leave it counted.
    expect(harness.deps.releaseUnseen).not.toHaveBeenCalled();

    harness.flushRender();
    expect(harness.deps.releaseUnseen).toHaveBeenCalledTimes(1);
    expect(harness.deps.releaseUnseen).toHaveBeenCalledWith(7);

    harness.flushRender();
    expect(harness.deps.releaseUnseen).toHaveBeenCalledTimes(1);
  });

  it("a second replay arriving while the first restore is being verified keeps the reader in place", async () => {
    const { terminal, anchorLine } = await scrolledBackTerminal();
    const harness = install(terminal);
    track(terminal, harness);

    await writeAndFlush(terminal, codexReplayBurst(transcript()));
    harness.flushRender();
    expect(topLine(terminal)).toBe(anchorLine);
    expect(harness.controller.phase).toBe("restoring");

    // One more wrapped line in the input bar: the next height change replays again.
    await writeAndFlush(terminal, codexReplayBurst(transcript()));
    expect(harness.controller.phase).toBe("restoring");
    harness.flushRender();
    harness.flushRender();

    expect(harness.controller.phase).toBe("idle");
    expect(topLine(terminal)).toBe(anchorLine);
    // The count was published after the first redraw and held again for the second.
    expect(harness.deps.holdUnseen).toHaveBeenCalledTimes(2);
    expect(harness.deps.releaseUnseen).toHaveBeenCalledTimes(2);
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

  it("a wheel gesture cancels even before the replay ends, publishing the held count", async () => {
    const { terminal } = await scrolledBackTerminal();
    const harness = install(terminal);
    harness.deps.holdUnseen.mockReturnValue(2);
    track(terminal, harness);

    await writeAndFlush(terminal, `${ESU}${CODEX_CLEAR}${BSU}`);
    expect(harness.controller.phase).toBe("armed");

    harness.controller.cancel();
    expect(harness.controller.phase).toBe("idle");
    expect(harness.deps.releaseUnseen).toHaveBeenCalledWith(2);

    await writeAndFlush(terminal, `${transcript().join("\r\n")}\r\n${ESU}`);
    expect(harness.controller.phase).toBe("idle");
    expect(harness.deps.releaseUnseen).toHaveBeenCalledTimes(1);
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
    expect(harness.deps.holdUnseen).not.toHaveBeenCalled();
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
    await writeAndFlush(terminal, codexReplay(transcript()));
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

    await writeAndFlush(terminal, codexReplay(transcript()));
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
