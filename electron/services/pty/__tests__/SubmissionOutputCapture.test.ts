import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import {
  ParseBarrier,
  SUBMISSION_CAPTURE_PUBLISH_MS,
  SubmissionCaptureHost,
  SubmissionOutputCapture,
  cutToBytes,
} from "../SubmissionOutputCapture.js";
import {
  SUBMISSION_OUTPUT_MAX_BYTES,
  SUBMISSION_OUTPUT_MAX_LINES,
} from "../../../../shared/types/terminalSubmission.js";

const terminals: Terminal[] = [];

function mirror(cols = 40, rows = 10, scrollback = 1000): Terminal {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  terminals.push(terminal);
  return terminal;
}

function write(terminal: Terminal, data: string, capture?: SubmissionOutputCapture): Promise<void> {
  return new Promise((resolve) =>
    terminal.write(data, () => {
      capture?.sync();
      resolve();
    })
  );
}

function numbered(prefix: string, count: number, from = 1): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${from + index}\r\n`).join("");
}

/**
 * An inline TUI in the shape Codex draws: history above a scroll region whose
 * bottom sits on the composer, new history scrolled in at the region's
 * bottom, the composer repainted below it.
 */
async function insertHistory(
  terminal: Terminal,
  lines: string[],
  capture?: SubmissionOutputCapture
): Promise<void> {
  const regionBottom = terminal.rows - 2;
  let data = `\x1b[1;${regionBottom}r`;
  for (const line of lines) data += `\x1b[${regionBottom};1H\n\r\x1b[2K${line}`;
  data += `\x1b[r\x1b[${terminal.rows - 1};1H\x1b[2K› \x1b[${terminal.rows};1H\x1b[2Kstatus`;
  await write(terminal, data, capture);
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  vi.useRealTimers();
});

/** Codex on a resize: erase the screen, purge scrollback, then the transcript again. */
async function replay(
  terminal: Terminal,
  transcript: string[],
  capture: SubmissionOutputCapture
): Promise<void> {
  await write(terminal, "\x1b[2J\x1b[3J\x1b[H", capture);
  await insertHistory(terminal, transcript, capture);
}

function rows(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
}

describe("SubmissionOutputCapture", () => {
  it("keeps a shell's output after the write and drops the rows that were already on screen", async () => {
    const terminal = mirror();
    await write(terminal, "before one\r\nbefore two\r\n$ ");
    const capture = new SubmissionOutputCapture(terminal, "ask");
    await write(terminal, "ask\r\n" + numbered("answer", 30) + "$ ", capture);

    const { text, truncated, state } = capture.snapshot();
    const lines = text.split("\n");
    expect(lines[0]).toBe("$ ask");
    expect(lines[1]).toBe("answer 1");
    expect(lines).toContain("answer 30");
    expect(text).not.toContain("before");
    expect(truncated).toBe(false);
    expect(state).toBe("capturing");
  });

  it("reads an answer that has scrolled far past the screen, starting from the write", async () => {
    const terminal = mirror();
    await write(terminal, numbered("old", 25) + "$ ");
    const capture = new SubmissionOutputCapture(terminal, "ask");
    await write(terminal, "ask\r\nTHE ANSWER\r\n", capture);
    for (let batch = 0; batch < 10; batch += 1) {
      await write(terminal, numbered("chatter", 15, batch * 15 + 1), capture);
    }

    const { text } = capture.snapshot();
    expect(text.split("\n").slice(0, 2)).toEqual(["$ ask", "THE ANSWER"]);
    expect(text).not.toContain("old");
  });

  it("stops at the line cap, keeping the start, and does no more work after it", async () => {
    const terminal = mirror();
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    await write(terminal, "go\r\n" + numbered("row", SUBMISSION_OUTPUT_MAX_LINES + 50), capture);

    const result = capture.snapshot();
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(SUBMISSION_OUTPUT_MAX_LINES);
    expect(lines[0]).toBe("$ go");
    expect(result.truncated).toBe(true);
    expect(result.state).toBe("closed");
    expect(capture.isOpen).toBe(false);

    await write(terminal, numbered("later", 40), capture);
    expect(capture.snapshot()).toEqual(result);
  });

  it("stops at the byte cap", async () => {
    const terminal = mirror(200, 10);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    const wide = "x".repeat(190);
    let data = "go\r\n";
    for (let index = 0; index < 120; index += 1) data += `${wide}\r\n`;
    await write(terminal, data, capture);

    const result = capture.snapshot();
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(SUBMISSION_OUTPUT_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.state).toBe("closed");
  });

  it("includes rows still on screen, and keeps them when it closes", async () => {
    const terminal = mirror();
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "ask");
    await write(terminal, "ask\r\nshort answer\r\n$ ", capture);

    expect(capture.snapshot().text).toBe("$ ask\nshort answer\n$");
    const closed = capture.close();
    expect(closed).toEqual({ text: "$ ask\nshort answer\n$", truncated: false, state: "closed" });

    // Whatever the terminal shows next belongs to someone else.
    await write(terminal, "\x1b[2J\x1b[Hnext prompt's output\r\n", capture);
    expect(capture.snapshot()).toEqual(closed);
  });

  it("joins soft-wrapped rows back into one line", async () => {
    const terminal = mirror(20, 6);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "ask");
    const long = "abcdefghij".repeat(5);
    await write(terminal, `ask\r\n${long}\r\n` + numbered("tail", 10), capture);

    expect(capture.snapshot().text.split("\n")[1]).toBe(long);
  });

  it("captures history an inline TUI scrolls in above its composer", async () => {
    const terminal = mirror(40, 10);
    await insertHistory(terminal, ["• earlier reply one", "• earlier reply two"]);
    const capture = new SubmissionOutputCapture(terminal, "what is left?");
    const reply = Array.from({ length: 20 }, (_, index) => `• reply line ${index + 1}`);
    await insertHistory(terminal, ["› what is left?", ...reply], capture);

    const lines = capture.snapshot().text.split("\n");
    expect(lines[0]).toBe("› what is left?");
    expect(lines).toContain("• reply line 1");
    expect(lines).toContain("• reply line 20");
    expect(lines.join("\n")).not.toContain("earlier reply");
  });

  it("lines a resize replay back up with what it had captured and keeps only the continuation", async () => {
    const terminal = mirror(40, 10);
    await insertHistory(terminal, ["• earlier reply"]);
    const capture = new SubmissionOutputCapture(terminal, "what is left?");
    const before = Array.from({ length: 12 }, (_, index) => `• the answer part ${index + 1}`);
    await insertHistory(terminal, ["› what is left?", ...before], capture);
    const captured = capture.snapshot().text;

    // Codex on a resize: purge, then the whole transcript again, rewrapped.
    terminal.resize(30, 10);
    await write(terminal, "\x1b[2J\x1b[3J\x1b[H", capture);
    await insertHistory(
      terminal,
      ["• earlier reply", "› what is left?", ...before, "• and then more"],
      capture
    );
    await insertHistory(terminal, numbered("• busy", 12).trim().split("\r\n"), capture);

    const lines = capture.snapshot().text.split("\n");
    expect(lines.filter((line) => line === "• the answer part 1")).toHaveLength(1);
    expect(lines.filter((line) => line === "› what is left?")).toHaveLength(1);
    expect(lines).toContain("• and then more");
    expect(lines.join("\n")).not.toContain("earlier reply");
    expect(lines.join("\n").startsWith(captured.split("\n").slice(0, 3).join("\n"))).toBe(true);
  });

  it("anchors a replay on the submitted text when nothing had scrolled off yet", async () => {
    const terminal = mirror(40, 10);
    await insertHistory(terminal, ["• earlier reply"]);
    const question = "please list the permissions you still need from the owner";
    const capture = new SubmissionOutputCapture(terminal, question);

    await write(terminal, "\x1b[2J\x1b[3J\x1b[H", capture);
    const transcript = [
      "• earlier reply",
      "› please list the permissions you still",
      "  need from the owner",
      "• network access",
      "• write access to ~/deploy",
      ...numbered("• more", 12).trim().split("\r\n"),
    ];
    await insertHistory(terminal, transcript, capture);

    const lines = capture.snapshot().text.split("\n");
    expect(lines[0]).toBe("• network access");
    expect(lines[1]).toBe("• write access to ~/deploy");
    expect(lines.join("\n")).not.toContain("earlier reply");
  });

  it("takes the latest occurrence when the replay holds the question twice", async () => {
    const terminal = mirror(40, 10);
    const question = "please list the permissions you still need";
    const capture = new SubmissionOutputCapture(terminal, question);
    await write(terminal, "\x1b[2J\x1b[3J\x1b[H", capture);
    await insertHistory(
      terminal,
      [`› ${question}`, "• the stale answer", `› ${question}`, "• the fresh answer"],
      capture
    );
    await insertHistory(terminal, numbered("• more", 12).trim().split("\r\n"), capture);

    const text = capture.snapshot().text;
    expect(text.split("\n")[0]).toBe("• the fresh answer");
    expect(text).not.toContain("stale");
  });

  it("reports a purge it cannot line back up with as lost, keeping what came before", async () => {
    const terminal = mirror(40, 10);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "ask");
    await write(terminal, "ask\r\n" + numbered("kept before the purge", 12), capture);
    const before = capture.snapshot().text;

    await write(terminal, "\x1b[H\x1b[2J\x1b[3J" + numbered("unrelated", 20), capture);
    const closed = capture.close();
    expect(closed.state).toBe("lost");
    expect(closed.text).toBe(
      before.split("\n").slice(0, closed.text.split("\n").length).join("\n")
    );
    expect(closed.text).toContain("kept before the purge 1");
    expect(closed.text).not.toContain("unrelated");
  });

  it("reports lost when rows leave the mirror's scrollback before they are read", async () => {
    const terminal = mirror(40, 5, 10);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "ask");
    await write(terminal, "ask\r\nfirst\r\n" + numbered("second", 5), capture);
    // One parse that scrolls far more than the scrollback holds.
    await write(terminal, numbered("flood", 40));
    capture.sync();
    const lost = capture.snapshot();
    expect(lost.state).toBe("lost");
    expect(lost.text.split("\n").slice(0, 3)).toEqual(["$ ask", "first", "second 1"]);
    expect(lost.text).not.toContain("flood");
  });

  it("reads the alternate screen live without journaling it", async () => {
    const terminal = mirror(40, 6);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "top");
    await write(terminal, "top\r\n\x1b[?1049h\x1b[Hfull screen app", capture);
    expect(capture.snapshot().text).toBe("full screen app");
    await write(terminal, "\x1b[?1049l", capture);
    expect(capture.snapshot().text).toBe("$ top");
  });
});

describe("cutToBytes", () => {
  it("never splits a code point", () => {
    expect(cutToBytes("aé", 2)).toBe("a");
    expect(cutToBytes("aé", 3)).toBe("aé");
    expect(cutToBytes("😀b", 3)).toBe("");
  });
});

describe("SubmissionOutputCapture after review (#16210)", () => {
  it("keeps the latest match even when an older answer in the replay is longer than the cap", async () => {
    const terminal = mirror(60, 10);
    const question = "please list the permissions you still need";
    const capture = new SubmissionOutputCapture(terminal, question);
    await replay(
      terminal,
      [
        `› ${question}`,
        ...rows("• stale", SUBMISSION_OUTPUT_MAX_LINES + 50),
        `› ${question}`,
        "• the fresh answer",
        ...rows("• more", 12),
      ],
      capture
    );

    const output = capture.snapshot();
    expect(output.text.split("\n")[0]).toBe("• the fresh answer");
    expect(output.text).not.toContain("stale");
    expect(output.state).toBe("capturing");
  });

  it("neither drops nor repeats text when a column change reflows a wrapped line", async () => {
    const terminal = mirror(20, 6);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    const long = "abcdefghij".repeat(4);
    await write(terminal, `go\r\n${long}\r\n` + numbered("a", 8), capture);
    terminal.resize(40, 6);
    await write(terminal, numbered("b", 8), capture);
    terminal.resize(15, 6);
    await write(terminal, numbered("c", 8), capture);

    const lines = capture.snapshot().text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["$ go", long]);
    for (const prefix of ["a", "b", "c"]) {
      for (let index = 1; index <= 8; index += 1) {
        expect(lines.filter((line) => line === `${prefix} ${index}`)).toHaveLength(1);
      }
    }
  });

  it("does not take the normal screen's history when it starts on the alternate screen", async () => {
    const terminal = mirror(40, 6);
    await write(terminal, numbered("history", 30) + "$ vim\r\n\x1b[?1049h\x1b[Hediting");
    const capture = new SubmissionOutputCapture(terminal, ":q");
    await write(terminal, "\x1b[?1049l$ " + numbered("after", 12), capture);

    const text = capture.snapshot().text;
    expect(text).toContain("after 1");
    expect(text).not.toContain("history");
  });

  it("ignores a scrollback purge on the alternate screen", async () => {
    const terminal = mirror(40, 6);
    await write(terminal, "$ ");
    // Long enough to anchor a replay, and never echoed: a purge wrongly taken
    // for the normal screen's would wait for it forever.
    const capture = new SubmissionOutputCapture(terminal, "a question long enough to anchor on");
    await write(terminal, "\r\n\x1b[?1049h\x1b[3J\x1b[?1049l" + numbered("out", 12), capture);

    const output = capture.close();
    expect(output.state).toBe("closed");
    expect(output.text).toContain("out 12");
  });

  it("keeps output that scrolled off just before an app took the alternate screen", async () => {
    const terminal = mirror(40, 6);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "run");
    await write(terminal, "run\r\n" + numbered("answer", 12) + "\x1b[?1049h\x1b[Hpager", capture);

    const output = capture.close();
    expect(output.text).toContain("answer 1");
    expect(output.text).toContain("pager");
  });

  it("lines a replay up after the pane grew taller and the erase took its marker", async () => {
    const terminal = mirror(40, 8);
    await insertHistory(terminal, ["• earlier reply"]);
    const capture = new SubmissionOutputCapture(terminal, "what is left?");
    const answer = rows("• the answer part", 12);
    await insertHistory(terminal, ["› what is left?", ...answer], capture);

    terminal.resize(40, 16);
    await replay(
      terminal,
      ["• earlier reply", "› what is left?", ...answer, "• and then more"],
      capture
    );
    await insertHistory(terminal, rows("• busy", 20), capture);

    const output = capture.snapshot();
    expect(output.state).toBe("capturing");
    const lines = output.text.split("\n");
    expect(lines.filter((line) => line === "• the answer part 1")).toHaveLength(1);
    expect(lines).toContain("• and then more");
    expect(output.text).not.toContain("earlier reply");
  });

  it("does not repeat a short captured start when a replay is anchored on the question", async () => {
    const terminal = mirror(40, 6);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    await write(terminal, "go\r\nOK\r\n" + numbered("x", 6), capture);
    await write(terminal, "\x1b[2J\x1b[3J\x1b[H$ go\r\nOK\r\n" + numbered("x", 6), capture);

    const lines = capture.snapshot().text.split("\n");
    expect(lines.filter((line) => line === "OK")).toHaveLength(1);
  });

  it("stops skipping on screen at the first line that is not from before the write", async () => {
    const terminal = mirror(40, 8);
    await write(terminal, "Done\r\n$ ");
    const capture = new SubmissionOutputCapture(terminal, "next");
    await write(terminal, "\x1b[2J\x1b[HNew answer\r\nDone\r\n", capture);

    expect(capture.snapshot().text).toBe("New answer\nDone");
  });

  it("keeps the exact start of the output when the byte cap cuts it", async () => {
    const terminal = mirror(100, 10);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    const line = "y".repeat(99);
    const count = Math.ceil(SUBMISSION_OUTPUT_MAX_BYTES / 100) + 10;
    let data = "go\r\n";
    for (let index = 0; index < count; index += 1) data += `${line}\r\n`;
    await write(terminal, data, capture);

    const output = capture.snapshot();
    const expected = cutToBytes(
      ["$ go", ...Array<string>(count).fill(line)].join("\n"),
      SUBMISSION_OUTPUT_MAX_BYTES
    );
    expect(output.text).toBe(expected);
    expect(Buffer.byteLength(output.text, "utf8")).toBe(SUBMISSION_OUTPUT_MAX_BYTES);
    expect(output).toMatchObject({ truncated: true, state: "closed" });
  });
});

describe("SubmissionCaptureHost", () => {
  it("publishes a growing capture at most once per interval, skips unchanged output, and ends it once", async () => {
    vi.useFakeTimers();
    const terminal = mirror();
    const published: Array<{ id: number; text: string; state: string }> = [];
    const host = new SubmissionCaptureHost((id, output) =>
      published.push({ id, text: output.text, state: output.state })
    );
    terminal.write("$ ");
    await vi.runAllTimersAsync();
    host.start(terminal, 7, "ask");
    expect(published).toEqual([{ id: 7, text: "$", state: "capturing" }]);

    terminal.write("ask\r\none\r\n");
    await vi.advanceTimersByTimeAsync(1);
    host.sync();
    host.sync();
    expect(published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SUBMISSION_CAPTURE_PUBLISH_MS);
    expect(published).toHaveLength(2);
    expect(published[1]!.text).toBe("$ ask\none");

    host.sync();
    await vi.advanceTimersByTimeAsync(SUBMISSION_CAPTURE_PUBLISH_MS);
    expect(published).toHaveLength(2);

    host.start(terminal, 8, "next");
    expect(published[2]).toEqual({ id: 7, text: "$ ask\none", state: "closed" });
    expect(published[3]!.id).toBe(8);
    host.dispose();
    expect(published[4]).toMatchObject({ id: 8, state: "closed" });
    host.dispose();
    expect(published).toHaveLength(5);
  });

  it("publishes the final form as soon as the cap ends a capture", async () => {
    const terminal = mirror();
    const published: Array<{ id: number; state: string; truncated: boolean }> = [];
    const host = new SubmissionCaptureHost((id, output) =>
      published.push({ id, state: output.state, truncated: output.truncated })
    );
    host.start(terminal, 1, "go");
    await write(terminal, numbered("row", SUBMISSION_OUTPUT_MAX_LINES + 20));
    host.sync();
    expect(published.at(-1)).toEqual({ id: 1, state: "closed", truncated: true });
    host.dispose();
    expect(published.filter((entry) => entry.state === "closed")).toHaveLength(1);
  });
});

describe("ParseBarrier", () => {
  it("runs work once every write fed before it has parsed, in order", () => {
    const barrier = new ParseBarrier();
    const ran: string[] = [];
    barrier.after(() => ran.push("idle"));
    const first = barrier.noteFed();
    const second = barrier.noteFed();
    barrier.after(() => ran.push("after two"));
    const third = barrier.noteFed();
    barrier.after(() => ran.push("after three"));
    first();
    expect(ran).toEqual(["idle"]);
    second();
    expect(ran).toEqual(["idle", "after two"]);
    third();
    expect(ran).toEqual(["idle", "after two", "after three"]);
  });

  it("does not count a parse callback that runs twice", () => {
    const barrier = new ParseBarrier();
    const ran: string[] = [];
    const first = barrier.noteFed();
    const second = barrier.noteFed();
    barrier.after(() => ran.push("both parsed"));
    first();
    first();
    expect(ran).toEqual([]);
    second();
    expect(ran).toEqual(["both parsed"]);
  });

  it("lets a later write's parse stand in for an earlier one whose callback was dropped", () => {
    const barrier = new ParseBarrier();
    const ran: string[] = [];
    barrier.noteFed();
    barrier.after(() => ran.push("after the dropped one"));
    const later = barrier.noteFed();
    later();
    expect(ran).toEqual(["after the dropped one"]);
  });

  it("survives a resize that drains the mirror synchronously", async () => {
    const terminal = mirror();
    const barrier = new ParseBarrier();
    const seen: string[] = [];
    const feed = (data: string) => {
      const parsed = barrier.noteFed();
      terminal.write(data, parsed);
    };
    feed("before ");
    barrier.after(() => seen.push(terminal.buffer.active.getLine(0)!.translateToString(true)));
    feed("after");
    terminal.resize(41, 10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["before "]);
    expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toBe("before after");
  });
});

describe("SubmissionOutputCapture, second review (#16210)", () => {
  it("keeps the space a soft wrap lands on", async () => {
    const terminal = mirror(10, 4);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    await write(terminal, "go\r\n123456789 word\r\n" + numbered("n", 6), capture);
    expect(capture.snapshot().text.split("\n")[1]).toBe("123456789 word");
  });

  it("reports lost when one parse overflows scrollback before anything was read", async () => {
    const terminal = mirror(40, 5, 10);
    const capture = new SubmissionOutputCapture(terminal, "go");
    await write(terminal, numbered("flood", 40), capture);
    expect(capture.snapshot().state).toBe("lost");
  });

  it("does not jump past unread output that repeats what was read last when a column change realigns", async () => {
    const terminal = mirror(100, 20);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    // 600 characters, six rows at this width: longer than the anchor, so an
    // unread repeat of it on screen matches the anchor whole.
    const repeated = Array.from({ length: 100 }, (_, index) => `w${index % 10}xyz`).join(" ");
    // The first copy is the last line read; the answer and a second copy
    // are still on screen, unread.
    await write(
      terminal,
      `go\r\n${numbered("start", 5)}${repeated}\r\nthe unique answer\r\n${repeated}\r\n` +
        numbered("pad", 12),
      capture
    );
    // Narrowing keeps the first copy in scrollback and pushes the answer up.
    terminal.resize(80, 20);
    await write(terminal, numbered("tail", 30), capture);

    const lines = capture.snapshot().text.split("\n");
    expect(lines).toContain("the unique answer");
    expect(lines.filter((line) => line === repeated)).toHaveLength(2);
  });

  it("lines a second replay up after one anchored on the question", async () => {
    const terminal = mirror(60, 10);
    await insertHistory(terminal, ["• an earlier reply that is long enough to be context"]);
    const question = "please list the permissions you still need";
    const capture = new SubmissionOutputCapture(terminal, question);
    const transcript = [
      "• an earlier reply that is long enough to be context",
      `› ${question}`,
      "• network access",
      ...rows("• detail", 12),
    ];
    await replay(terminal, transcript, capture);
    await replay(terminal, [...transcript, "• written after both"], capture);
    await insertHistory(terminal, rows("• busy", 12), capture);

    const output = capture.snapshot();
    expect(output.state).toBe("capturing");
    const lines = output.text.split("\n");
    expect(lines[0]).toBe("• network access");
    expect(lines.filter((line) => line === "• network access")).toHaveLength(1);
    expect(lines).toContain("• written after both");
  });

  it("does not flag a fresh answer truncated because a stale one before it was", async () => {
    const terminal = mirror(60, 10);
    const question = "please list the permissions you still need";
    const capture = new SubmissionOutputCapture(terminal, question);
    await replay(
      terminal,
      [`› ${question}`, ...rows("• stale", SUBMISSION_OUTPUT_MAX_LINES + 20)],
      capture
    );
    // The fresh match is still on screen: only the live read finds it.
    await write(terminal, `\x1b[2J\x1b[H› ${question}\r\n• fresh\r\n`, capture);
    const output = capture.snapshot();
    expect(output.text).toBe("• fresh");
    expect(output.truncated).toBe(false);
  });

  it("keeps a continuation's truncation when a later purge commits it", async () => {
    const terminal = mirror(60, 10);
    const question = "please list the permissions you still need";
    const capture = new SubmissionOutputCapture(terminal, question);
    await replay(
      terminal,
      [`› ${question}`, ...rows("• line", SUBMISSION_OUTPUT_MAX_LINES + 20)],
      capture
    );
    await write(terminal, "\x1b[2J\x1b[3J", capture);
    expect(capture.snapshot()).toMatchObject({ truncated: true, state: "closed" });
  });
});

describe("SubmissionOutputCapture, third review (#16210)", () => {
  it("keeps a wide character that wrapped intact across a column change", async () => {
    const terminal = mirror(10, 4);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    await write(terminal, "go\r\n123456789界\r\n" + numbered("n", 6), capture);
    terminal.resize(20, 4);
    await write(terminal, numbered("m", 6), capture);

    const output = capture.snapshot();
    expect(output.state).toBe("capturing");
    expect(output.text.split("\n")[1]).toBe("123456789界");
    expect(output.text).toContain("m 6");
  });

  it("finds the boundary behind a long unread line when a narrowing pushes it far back", async () => {
    const terminal = mirror(10, 5, 5000);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    await write(terminal, "go\r\nthe answer starts here\r\n", capture);
    await write(terminal, numbered("x", 6), capture);
    // Still reaching the screen, so not read yet.
    await write(terminal, "y".repeat(11_000), capture);
    terminal.resize(5, 5);
    await write(terminal, "\r\n" + numbered("z", 6), capture);

    const output = capture.snapshot();
    expect(output.state).toBe("capturing");
    const lines = output.text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["$ go", "the answer starts here"]);
    expect(lines.filter((line) => line === "x 1")).toHaveLength(1);
  });

  it("does not read repeated lines twice when a resize pulls them back on screen", async () => {
    const terminal = mirror(40, 6);
    await write(terminal, "$ ");
    const capture = new SubmissionOutputCapture(terminal, "go");
    const same = Array.from({ length: 100 }, () => "the same line\r\n").join("");
    await write(terminal, `go\r\n${same}`, capture);
    terminal.resize(41, 150);
    await write(terminal, "end\r\n", capture);

    const lines = capture.close().text.split("\n");
    expect(lines.filter((line) => line === "the same line")).toHaveLength(100);
    expect(lines.at(-1)).toBe("end");
  });

  it("stays closed when a column change commits a replay that reached the cap", async () => {
    const terminal = mirror(60, 10);
    const question = "please list the permissions you still need";
    const capture = new SubmissionOutputCapture(terminal, question);
    await replay(
      terminal,
      [`› ${question}`, ...rows("• line", SUBMISSION_OUTPUT_MAX_LINES + 20)],
      capture
    );
    terminal.resize(70, 10);
    expect(capture.snapshot()).toMatchObject({ truncated: true, state: "closed" });
  });
});
