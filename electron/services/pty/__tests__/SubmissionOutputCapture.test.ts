import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { SubmissionOutputCapture, cutToBytes } from "../SubmissionOutputCapture.js";
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
});

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
