import { describe, it, expect } from "vitest";
import { stripIdleTerminalSequences } from "../IdleSequenceFilter.js";

describe("stripIdleTerminalSequences", () => {
  it("strips Grok's repeated Kitty image deletion without removing visible output", () => {
    const deletion = "\x1b_Ga=d,d=i,i=1,q=2\x1b\\";
    expect(stripIdleTerminalSequences(deletion)).toBe("");
    expect(stripIdleTerminalSequences(`READY${deletion}❯`)).toBe("READY❯");
  });

  it("preserves Kitty image transmission and incomplete delete commands", () => {
    const transmission = "\x1b_Ga=T,f=100;AAAA\x1b\\";
    const incomplete = "\x1b_Ga=d,d=i,i=1,q=2";
    expect(stripIdleTerminalSequences(transmission)).toBe(transmission);
    expect(stripIdleTerminalSequences(incomplete)).toBe(incomplete);
  });

  it("returns plain text unchanged", () => {
    expect(stripIdleTerminalSequences("hello world")).toBe("hello world");
  });

  it("strips DECSET cursor hide/show", () => {
    expect(stripIdleTerminalSequences("\x1b[?25l\x1b[?25h")).toBe("");
  });

  it("strips DECSET focus event toggles", () => {
    expect(stripIdleTerminalSequences("\x1b[?1004h\x1b[?1004l")).toBe("");
  });

  it("strips DECSET bracketed-paste mode toggles", () => {
    expect(stripIdleTerminalSequences("\x1b[?2004h\x1b[?2004l")).toBe("");
  });

  it("strips DECSET sync-update toggles", () => {
    expect(stripIdleTerminalSequences("\x1b[?2026h\x1b[?2026l")).toBe("");
  });

  it("strips DECSET alt-screen toggles", () => {
    expect(stripIdleTerminalSequences("\x1b[?1049h\x1b[?1049l")).toBe("");
  });

  it("strips DECSET combined-mode sequences with all known-noise codes", () => {
    expect(stripIdleTerminalSequences("\x1b[?25;2026h")).toBe("");
    expect(stripIdleTerminalSequences("\x1b[?1049;2004l")).toBe("");
    expect(stripIdleTerminalSequences("\x1b[?25;1004;2004h")).toBe("");
  });

  it("preserves DECSET combined-mode when any code is unknown", () => {
    expect(stripIdleTerminalSequences("\x1b[?25;9999h")).toBe("\x1b[?25;9999h");
    expect(stripIdleTerminalSequences("\x1b[?9999h")).toBe("\x1b[?9999h");
    // Unknown code sandwiched between known codes still rejects the whole sequence.
    expect(stripIdleTerminalSequences("\x1b[?25;9999;2026h")).toBe("\x1b[?25;9999;2026h");
    expect(stripIdleTerminalSequences("\x1b[?9999;25h")).toBe("\x1b[?9999;25h");
  });

  it("strips OSC 0 set-window-title", () => {
    expect(stripIdleTerminalSequences("\x1b]0;Window Title\x07")).toBe("");
  });

  it("strips OSC 1 set-icon-name", () => {
    expect(stripIdleTerminalSequences("\x1b]1;Icon\x07")).toBe("");
  });

  it("strips OSC 2 set-window-title-only", () => {
    expect(stripIdleTerminalSequences("\x1b]2;Claude — Working\x07")).toBe("");
  });

  it("strips OSC 7 set-cwd", () => {
    expect(stripIdleTerminalSequences("\x1b]7;file:///tmp\x07")).toBe("");
  });

  it("strips OSC 8 hyperlink", () => {
    expect(stripIdleTerminalSequences("\x1b]8;;https://example.com\x07")).toBe("");
  });

  it("strips OSC 9 taskbar progress", () => {
    expect(stripIdleTerminalSequences("\x1b]9;4;1;50\x07")).toBe("");
  });

  it("strips OSC 10 foreground-color query/response", () => {
    expect(stripIdleTerminalSequences("\x1b]10;?\x07")).toBe("");
    expect(stripIdleTerminalSequences("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBe("");
  });

  it("strips OSC 11 background-color query/response", () => {
    expect(stripIdleTerminalSequences("\x1b]11;?\x07")).toBe("");
    expect(stripIdleTerminalSequences("\x1b]11;rgb:0000/0000/0000\x07")).toBe("");
  });

  it("strips OSC 12 cursor-color query/response", () => {
    expect(stripIdleTerminalSequences("\x1b]12;?\x07")).toBe("");
  });

  it("strips OSC 52 clipboard metadata", () => {
    expect(stripIdleTerminalSequences("\x1b]52;c;aGVsbG8=\x07")).toBe("");
  });

  it("strips OSC 1337 iTerm2 sequences", () => {
    expect(stripIdleTerminalSequences("\x1b]1337;CurrentDir=/tmp\x07")).toBe("");
    expect(stripIdleTerminalSequences("\x1b]1337;RemoteHost=user@host\x07")).toBe("");
  });

  it("preserves OSC 1337 with payload exceeding 512 chars", () => {
    const start = performance.now();
    const payload = "x".repeat(2000);
    const input = `\x1b]1337;File=name=foo.png:${payload}\x07`;
    const out = stripIdleTerminalSequences(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(out).toBe(input);
  });

  it("preserves unknown OSC codes (e.g. OSC 14, OSC 777)", () => {
    expect(stripIdleTerminalSequences("\x1b]14;?\x07")).toBe("\x1b]14;?\x07");
    expect(stripIdleTerminalSequences("\x1b]777;notify\x07")).toBe("\x1b]777;notify\x07");
  });

  it("strips OSC 133 shell integration", () => {
    expect(stripIdleTerminalSequences("\x1b]133;A\x07\x1b]133;B\x07")).toBe("");
  });

  it("strips OSC 633 VS Code shell integration", () => {
    expect(stripIdleTerminalSequences("\x1b]633;P;Cwd=/foo\x07")).toBe("");
  });

  it("strips OSC terminated by ST (ESC \\)", () => {
    expect(stripIdleTerminalSequences("\x1b]0;Title\x1b\\")).toBe("");
  });

  it("strips CPR cursor-position responses", () => {
    expect(stripIdleTerminalSequences("\x1b[24;80R")).toBe("");
    expect(stripIdleTerminalSequences("\x1b[1;1R")).toBe("");
  });

  it("strips DSR cursor-position queries", () => {
    expect(stripIdleTerminalSequences("\x1b[6n")).toBe("");
  });

  it("strips bracketed-paste markers", () => {
    expect(stripIdleTerminalSequences("\x1b[200~\x1b[201~")).toBe("");
  });

  it("preserves spinner frames (CR + braille + text)", () => {
    expect(stripIdleTerminalSequences("\r⠋ Thinking…")).toBe("\r⠋ Thinking…");
  });

  it("preserves erase-line sequences (cosmetic, not idle-noise)", () => {
    expect(stripIdleTerminalSequences("\x1b[2K\r⠋")).toBe("\x1b[2K\r⠋");
  });

  it("preserves SGR color sequences", () => {
    expect(stripIdleTerminalSequences("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
  });

  it("strips noise but keeps wrapped content", () => {
    const input = "\x1b[?25l\rThinking…\x1b[?25h";
    expect(stripIdleTerminalSequences(input)).toBe("\rThinking…");
  });

  it("strips OSC payloads up to 512 chars", () => {
    const payload = "x".repeat(512);
    expect(stripIdleTerminalSequences(`\x1b]7;${payload}\x07`)).toBe("");
  });

  it("does not hang on unterminated OSC sequence", () => {
    const start = performance.now();
    const input = `\x1b]7;${"x".repeat(2000)}`;
    const out = stripIdleTerminalSequences(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(out).toBe(input);
  });

  it("does not hang on OSC payload exceeding 512 chars", () => {
    const start = performance.now();
    const payload = "x".repeat(2000);
    const input = `\x1b]7;${payload}\x07`;
    const out = stripIdleTerminalSequences(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(out).toBe(input);
  });

  it("strips multiple noise types interleaved with content", () => {
    const input = "\x1b[?25l\x1b]133;A\x07hello\x1b[24;80R world\x1b[?25h";
    expect(stripIdleTerminalSequences(input)).toBe("hello world");
  });

  it("does not strip 4-digit CPR-shaped numbers in plain text", () => {
    expect(stripIdleTerminalSequences("price: $1234")).toBe("price: $1234");
  });
});
