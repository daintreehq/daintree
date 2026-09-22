import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";
import { isNonKeyboardInput } from "../TerminalInstanceService";

describe("isNonKeyboardInput", () => {
  describe("mouse sequences", () => {
    it("detects X10/Normal mouse sequences (\\x1b[M + 3 bytes)", () => {
      expect(isNonKeyboardInput("\x1b[M #!")).toBe(true);
      expect(isNonKeyboardInput("\x1b[M\x00\x20\x21")).toBe(true);
    });

    it("detects SGR mouse sequences (\\x1b[< ... M or m)", () => {
      expect(isNonKeyboardInput("\x1b[<0;12;8M")).toBe(true);
      expect(isNonKeyboardInput("\x1b[<0;12;8m")).toBe(true);
      expect(isNonKeyboardInput("\x1b[<35;120;45M")).toBe(true);
    });

    it("detects URXVT mouse sequences (\\x1b[ digits;digits;digits M)", () => {
      expect(isNonKeyboardInput("\x1b[64;12;8M")).toBe(true);
      expect(isNonKeyboardInput("\x1b[32;1;1M")).toBe(true);
    });
  });

  describe("focus reports", () => {
    it("detects focus-in report (\\x1b[I)", () => {
      expect(isNonKeyboardInput("\x1b[I")).toBe(true);
    });

    it("detects focus-out report (\\x1b[O)", () => {
      expect(isNonKeyboardInput("\x1b[O")).toBe(true);
    });
  });

  describe("private-mode CSI sequences (must NOT trigger directing)", () => {
    it("detects the ?997 color-scheme report xterm sends on focus (the click bug)", () => {
      expect(isNonKeyboardInput("\x1b[?997;1n")).toBe(true); // dark
      expect(isNonKeyboardInput("\x1b[?997;2n")).toBe(true); // light
    });

    it("detects DEC private mode set/reset (alt screen, cursor visibility, bracketed paste)", () => {
      expect(isNonKeyboardInput("\x1b[?1049h")).toBe(true); // enter alt screen
      expect(isNonKeyboardInput("\x1b[?1049l")).toBe(true); // leave alt screen
      expect(isNonKeyboardInput("\x1b[?25l")).toBe(true); // hide cursor
      expect(isNonKeyboardInput("\x1b[?2004h")).toBe(true); // bracketed paste on
    });

    it("treats multi-parameter and truncated private-mode prefixes as non-keyboard", () => {
      expect(isNonKeyboardInput("\x1b[?1049;0;0h")).toBe(true); // multi-param set
      expect(isNonKeyboardInput("\x1b[?")).toBe(true); // truncated prefix — safe default
    });
  });

  describe("replies to application queries (must NOT trigger directing)", () => {
    it("classifies every reply the real parser emits as non-keyboard", async () => {
      const term = new Terminal({
        cols: 80,
        rows: 24,
        allowProposedApi: true,
        windowOptions: { getWinSizeChars: true },
      });
      const replies: string[] = [];
      term.onData((data) => replies.push(data));
      const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));

      const queries: Record<string, string> = {
        DA1: "\x1b[c",
        DA2: "\x1b[>c",
        DSR: "\x1b[5n",
        CPR: "\x1b[6n",
        DECXCPR: "\x1b[?6n",
        "DECRQM private": "\x1b[?2026$p",
        "DECRQM ANSI": "\x1b[4$p",
        DECRQSS: "\x1bP$qm\x1b\\",
        XTVERSION: "\x1b[>q",
        "window size": "\x1b[18t",
      };
      try {
        await write("line1\r\nline2\r\nprompt ");
        for (const [name, query] of Object.entries(queries)) {
          replies.length = 0;
          await write(query);
          expect(replies.length, `${name} produced no reply`).toBeGreaterThan(0);
          for (const reply of replies) {
            expect(isNonKeyboardInput(reply), `${name} reply ${JSON.stringify(reply)}`).toBe(true);
          }
        }
      } finally {
        term.dispose();
      }
    });

    it("detects OSC colour replies, which the headless build does not emit", () => {
      expect(isNonKeyboardInput("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\")).toBe(true);
      expect(isNonKeyboardInput("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBe(true);
      expect(isNonKeyboardInput("\x1b]4;1;rgb:cccc/0000/0000\x1b\\")).toBe(true);
    });

    it("detects a cursor position report on any row, not just row 1", () => {
      expect(isNonKeyboardInput("\x1b[24;80R")).toBe(true);
      expect(isNonKeyboardInput("\x1b[3;7R")).toBe(true);
    });

    it("detects the image addon's Kitty graphics and cell-size replies", () => {
      expect(isNonKeyboardInput("\x1b_Gi=1;OK\x1b\\")).toBe(true);
      expect(isNonKeyboardInput("\x1b]1337;ReportCellSize=17.0;8.0;1.0\x1b\\")).toBe(true);
    });

    it("does NOT swallow a raw paste that is merely framed like a string reply", () => {
      expect(isNonKeyboardInput("\x1b]0;first\rsecond\x07")).toBe(false);
      expect(isNonKeyboardInput("\x1bPfirst\rsecond\x1b\\")).toBe(false);
      expect(isNonKeyboardInput("\x1b[200~\x1b]11;rgb:0/0/0\x07\x1b[201~")).toBe(false);
    });

    it("still treats the Alt-prefixed keys that share a reply introducer as typing", () => {
      expect(isNonKeyboardInput("\x1b]")).toBe(false); // Alt+]
      expect(isNonKeyboardInput("\x1bP")).toBe(false); // Alt+Shift+P
      expect(isNonKeyboardInput("\x1bc")).toBe(false); // Alt+c
      expect(isNonKeyboardInput("\x1bn")).toBe(false); // Alt+n
      expect(isNonKeyboardInput("\x1b_")).toBe(false); // Alt+_
    });

    it("does NOT match modifyOtherKeys key events", () => {
      expect(isNonKeyboardInput("\x1b[27;5;13~")).toBe(false);
    });
  });

  describe("navigation sequences (must match)", () => {
    it("matches arrow keys (normal mode)", () => {
      expect(isNonKeyboardInput("\x1b[A")).toBe(true);
      expect(isNonKeyboardInput("\x1b[B")).toBe(true);
      expect(isNonKeyboardInput("\x1b[C")).toBe(true);
      expect(isNonKeyboardInput("\x1b[D")).toBe(true);
    });

    it("matches arrow keys (application cursor mode)", () => {
      expect(isNonKeyboardInput("\x1bOA")).toBe(true);
      expect(isNonKeyboardInput("\x1bOB")).toBe(true);
      expect(isNonKeyboardInput("\x1bOC")).toBe(true);
      expect(isNonKeyboardInput("\x1bOD")).toBe(true);
    });

    it("matches Home/End (normal mode)", () => {
      expect(isNonKeyboardInput("\x1b[H")).toBe(true);
      expect(isNonKeyboardInput("\x1b[F")).toBe(true);
    });

    it("matches Home/End (application mode)", () => {
      expect(isNonKeyboardInput("\x1bOH")).toBe(true);
      expect(isNonKeyboardInput("\x1bOF")).toBe(true);
    });

    it("matches Page Up/Down", () => {
      expect(isNonKeyboardInput("\x1b[5~")).toBe(true);
      expect(isNonKeyboardInput("\x1b[6~")).toBe(true);
    });

    it("matches Insert and Forward Delete keys", () => {
      expect(isNonKeyboardInput("\x1b[2~")).toBe(true);
      expect(isNonKeyboardInput("\x1b[3~")).toBe(true);
    });

    it("matches F1–F4 (SS3 prefix)", () => {
      expect(isNonKeyboardInput("\x1bOP")).toBe(true);
      expect(isNonKeyboardInput("\x1bOQ")).toBe(true);
      expect(isNonKeyboardInput("\x1bOR")).toBe(true);
      expect(isNonKeyboardInput("\x1bOS")).toBe(true);
    });

    it("matches F5–F12 (tilde-terminated)", () => {
      expect(isNonKeyboardInput("\x1b[15~")).toBe(true); // F5
      expect(isNonKeyboardInput("\x1b[17~")).toBe(true); // F6
      expect(isNonKeyboardInput("\x1b[18~")).toBe(true); // F7
      expect(isNonKeyboardInput("\x1b[19~")).toBe(true); // F8
      expect(isNonKeyboardInput("\x1b[20~")).toBe(true); // F9
      expect(isNonKeyboardInput("\x1b[21~")).toBe(true); // F10
      expect(isNonKeyboardInput("\x1b[23~")).toBe(true); // F11
      expect(isNonKeyboardInput("\x1b[24~")).toBe(true); // F12
    });

    it("matches lone Escape", () => {
      expect(isNonKeyboardInput("\x1b")).toBe(true);
    });

    it("matches modifier-bearing arrow keys (Shift+Up, Ctrl+Left, etc.)", () => {
      expect(isNonKeyboardInput("\x1b[1;2A")).toBe(true); // Shift+Up
      expect(isNonKeyboardInput("\x1b[1;5C")).toBe(true); // Ctrl+Right
      expect(isNonKeyboardInput("\x1b[1;3D")).toBe(true); // Alt+Left
      expect(isNonKeyboardInput("\x1b[1;2H")).toBe(true); // Shift+Home
      expect(isNonKeyboardInput("\x1b[1;5F")).toBe(true); // Ctrl+End
    });

    it("matches modifier-bearing F-keys (Shift+F1, Ctrl+F5, etc.)", () => {
      expect(isNonKeyboardInput("\x1b[1;2P")).toBe(true); // Shift+F1
      expect(isNonKeyboardInput("\x1b[1;5Q")).toBe(true); // Ctrl+F2
      expect(isNonKeyboardInput("\x1b[15;2~")).toBe(true); // Shift+F5
      expect(isNonKeyboardInput("\x1b[24;5~")).toBe(true); // Ctrl+F12
    });

    it("matches modifier-bearing PgUp/PgDn/Insert/Delete", () => {
      expect(isNonKeyboardInput("\x1b[5;2~")).toBe(true); // Shift+PgUp
      expect(isNonKeyboardInput("\x1b[6;5~")).toBe(true); // Ctrl+PgDn
      expect(isNonKeyboardInput("\x1b[3;5~")).toBe(true); // Ctrl+Delete
      expect(isNonKeyboardInput("\x1b[2;2~")).toBe(true); // Shift+Insert
    });
  });

  describe("control characters (must match)", () => {
    it("matches Ctrl+C", () => {
      expect(isNonKeyboardInput("\x03")).toBe(true);
    });

    it("matches Ctrl+D", () => {
      expect(isNonKeyboardInput("\x04")).toBe(true);
    });

    it("matches Ctrl+L", () => {
      expect(isNonKeyboardInput("\x0c")).toBe(true);
    });

    it("matches Ctrl+Z", () => {
      expect(isNonKeyboardInput("\x1a")).toBe(true);
    });
  });

  describe("keyboard input (must NOT match)", () => {
    it("does NOT match printable characters", () => {
      expect(isNonKeyboardInput("a")).toBe(false);
      expect(isNonKeyboardInput("hello")).toBe(false);
      expect(isNonKeyboardInput(" ")).toBe(false);
    });

    it("does NOT match Enter", () => {
      expect(isNonKeyboardInput("\r")).toBe(false);
      expect(isNonKeyboardInput("\x0d")).toBe(false);
    });

    it("does NOT match Backspace", () => {
      expect(isNonKeyboardInput("\x7f")).toBe(false);
      expect(isNonKeyboardInput("\x08")).toBe(false);
    });

    it("does NOT match Tab", () => {
      expect(isNonKeyboardInput("\x09")).toBe(false);
    });

    it("does NOT match Alt+key sequences", () => {
      expect(isNonKeyboardInput("\x1ba")).toBe(false);
      expect(isNonKeyboardInput("\x1bb")).toBe(false);
      expect(isNonKeyboardInput("\x1bf")).toBe(false);
    });

    it("does NOT match bracketed paste delimiters", () => {
      expect(isNonKeyboardInput("\x1b[200~")).toBe(false);
      expect(isNonKeyboardInput("\x1b[201~")).toBe(false);
    });

    it("does NOT match Kitty keyboard protocol sequences", () => {
      expect(isNonKeyboardInput("\x1b[13;2u")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for empty string", () => {
      expect(isNonKeyboardInput("")).toBe(false);
    });

    it("returns false for incomplete CSI prefix", () => {
      expect(isNonKeyboardInput("\x1b[")).toBe(false);
    });

    it("does NOT match CSI sequences with wrong terminators", () => {
      expect(isNonKeyboardInput("\x1b[32;1;1K")).toBe(false);
      expect(isNonKeyboardInput("\x1b[32;1;1m")).toBe(false);
    });
  });
});
