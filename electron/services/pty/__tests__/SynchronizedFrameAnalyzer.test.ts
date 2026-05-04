import { describe, it, expect, beforeEach } from "vitest";
import {
  SynchronizedFrameAnalyzer,
  type FrameCell,
  type FrameSnapshot,
} from "../SynchronizedFrameAnalyzer.js";

function cell(code: number, width = 1): FrameCell {
  return { code, width };
}

function rowOf(text: string, padToCols: number): FrameCell[] {
  const out: FrameCell[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(cell(text.codePointAt(i)!));
  }
  while (out.length < padToCols) {
    out.push(cell(0x20));
  }
  return out;
}

function snapshot(opts: {
  rows: string[];
  cols: number;
  capturedAt: number;
  terminalRows?: number;
}): FrameSnapshot {
  const cols = opts.cols;
  const rows = opts.rows.map((r) => rowOf(r, cols));
  return {
    capturedAt: opts.capturedAt,
    terminalRows: opts.terminalRows ?? 24,
    terminalCols: cols,
    rows,
    bottomRowText: opts.rows[opts.rows.length - 1] ?? "",
    secondToBottomText: opts.rows.length >= 2 ? opts.rows[opts.rows.length - 2] : "",
  };
}

describe("SynchronizedFrameAnalyzer", () => {
  let analyzer: SynchronizedFrameAnalyzer;

  beforeEach(() => {
    analyzer = new SynchronizedFrameAnalyzer();
  });

  describe("time-counter classifier", () => {
    it("returns time-counter on strictly increasing seconds with stable prefix", () => {
      analyzer.classify(snapshot({ rows: ["", "Working… 1s"], cols: 40, capturedAt: 1000 }));
      analyzer.classify(snapshot({ rows: ["", "Working… 2s"], cols: 40, capturedAt: 1100 }));
      const result = analyzer.classify(
        snapshot({ rows: ["", "Working… 3s"], cols: 40, capturedAt: 1200 })
      );
      expect(result.signal).toBe("time-counter");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("does not return time-counter on a decreasing counter", () => {
      analyzer.classify(snapshot({ rows: ["", "Working… 5s"], cols: 40, capturedAt: 1000 }));
      analyzer.classify(snapshot({ rows: ["", "Working… 4s"], cols: 40, capturedAt: 1100 }));
      const result = analyzer.classify(
        snapshot({ rows: ["", "Working… 3s"], cols: 40, capturedAt: 1200 })
      );
      expect(result.signal).not.toBe("time-counter");
    });

    it("does not return time-counter when prefix keeps changing", () => {
      analyzer.classify(snapshot({ rows: ["", "Compiling 1s"], cols: 40, capturedAt: 1000 }));
      analyzer.classify(snapshot({ rows: ["", "Linking 2s"], cols: 40, capturedAt: 1100 }));
      const result = analyzer.classify(
        snapshot({ rows: ["", "Bundling 3s"], cols: 40, capturedAt: 1200 })
      );
      // Each frame has a different prefix, so counterStreak resets every
      // frame and never reaches the 2-frame threshold.
      expect(result.signal).not.toBe("time-counter");
    });

    it("recognizes minute counters", () => {
      analyzer.classify(snapshot({ rows: ["", "Running 1m"], cols: 40, capturedAt: 1000 }));
      analyzer.classify(snapshot({ rows: ["", "Running 2m"], cols: 40, capturedAt: 61000 }));
      const result = analyzer.classify(
        snapshot({ rows: ["", "Running 3m"], cols: 40, capturedAt: 121000 })
      );
      expect(result.signal).toBe("time-counter");
    });

    it("does not return time-counter when no counter is present", () => {
      analyzer.classify(snapshot({ rows: ["", "Working"], cols: 40, capturedAt: 1000 }));
      const result = analyzer.classify(
        snapshot({ rows: ["", "Working"], cols: 40, capturedAt: 1100 })
      );
      expect(result.signal).not.toBe("time-counter");
    });
  });

  describe("cosmetic-only classifier", () => {
    it("returns cosmetic-only when only the bottom row changes", () => {
      // Use bottom rows without digit+unit patterns to avoid hitting the
      // time-counter classifier. Two frames isn't enough for the spinner
      // classifier (MIN_FRAMES_FOR_SPINNER=3), so this falls through to
      // cosmetic-only.
      const snap1 = snapshot({
        rows: ["import foo from 'bar'", "console.log(1)", "spinner ✦"],
        cols: 40,
        capturedAt: 1000,
      });
      const snap2 = snapshot({
        rows: ["import foo from 'bar'", "console.log(1)", "spinner ✧"],
        cols: 40,
        capturedAt: 1100,
      });
      analyzer.classify(snap1);
      const result = analyzer.classify(snap2);
      expect(result.signal).toBe("cosmetic-only");
    });

    it("does NOT return cosmetic-only when higher rows change", () => {
      const snap1 = snapshot({
        rows: ["line 1 v1", "line 2 v1", "spinner ✦"],
        cols: 40,
        capturedAt: 1000,
      });
      const snap2 = snapshot({
        rows: ["line 1 v2", "line 2 v1", "spinner ✦"],
        cols: 40,
        capturedAt: 1100,
      });
      analyzer.classify(snap1);
      const result = analyzer.classify(snap2);
      expect(result.signal).not.toBe("cosmetic-only");
    });

    it("returns none when nothing changed", () => {
      const snap1 = snapshot({
        rows: ["unchanged", "row", "bottom"],
        cols: 40,
        capturedAt: 1000,
      });
      const snap2 = snapshot({
        rows: ["unchanged", "row", "bottom"],
        cols: 40,
        capturedAt: 1100,
      });
      analyzer.classify(snap1);
      const result = analyzer.classify(snap2);
      expect(result.signal).toBe("none");
    });
  });

  describe("spinner classifier", () => {
    it("returns spinner when one cell cycles through codepoints at 100ms cadence", () => {
      // 4-item cycle iterated twice — each codepoint is revisited, which
      // satisfies the revisitation requirement (rejects monotonic counters).
      const cycle = ["⠋", "⠙", "⠹", "⠸"];
      let lastResult = analyzer.classify(
        snapshot({ rows: ["", "  static text"], cols: 40, capturedAt: 1000 })
      );
      for (let i = 0; i < 8; i++) {
        const ch = cycle[i % cycle.length];
        const row = `${ch} static text`;
        lastResult = analyzer.classify(
          snapshot({ rows: ["", row], cols: 40, capturedAt: 1100 + i * 100 })
        );
      }
      expect(lastResult.signal).toBe("spinner");
      expect(lastResult.confidence).toBeGreaterThan(0.4);
    });

    it("does NOT return spinner when neighbors also cycle (whole-row redraw)", () => {
      // Every cell on the bottom row cycles — that's a paint, not a spinner.
      const charsByFrame = ["abcdefgh", "bcdefgha", "cdefghab", "defghabc"];
      let result = analyzer.classify(
        snapshot({ rows: ["", "        "], cols: 8, capturedAt: 1000 })
      );
      for (let i = 0; i < charsByFrame.length; i++) {
        result = analyzer.classify(
          snapshot({ rows: ["", charsByFrame[i]], cols: 8, capturedAt: 1100 + i * 100 })
        );
      }
      expect(result.signal).not.toBe("spinner");
    });

    it("does NOT return spinner when cell stays static across frames", () => {
      let result = analyzer.classify(
        snapshot({ rows: ["", "✦ static"], cols: 40, capturedAt: 1000 })
      );
      for (let i = 0; i < 6; i++) {
        result = analyzer.classify(
          snapshot({ rows: ["", "✦ static"], cols: 40, capturedAt: 1100 + i * 100 })
        );
      }
      expect(result.signal).not.toBe("spinner");
    });

    it("does NOT classify monotonic counter cell as spinner", () => {
      // A digit cell incrementing 0→1→2→3→… without repeats has the right
      // distinct-count and cadence, but no revisitation. Real spinners
      // return to previously-seen codepoints.
      const chars = ["0", "1", "2", "3", "4", "5", "6"];
      let result = analyzer.classify(
        snapshot({ rows: ["", `${chars[0]} progress`], cols: 40, capturedAt: 1000 })
      );
      for (let i = 0; i < 6; i++) {
        const row = `${chars[i + 1]} progress`;
        result = analyzer.classify(
          snapshot({ rows: ["", row], cols: 40, capturedAt: 1100 + i * 100 })
        );
      }
      expect(result.signal).not.toBe("spinner");
    });

    it("returns spinner when cell revisits codepoints", () => {
      // 4-frame braille cycle revisited across 8 frames — each codepoint
      // appears twice, satisfying the revisitation requirement.
      const cycle = ["⠋", "⠙", "⠹", "⠸"];
      let result = analyzer.classify(
        snapshot({ rows: ["", "  static"], cols: 40, capturedAt: 1000 })
      );
      for (let i = 0; i < 8; i++) {
        const ch = cycle[i % cycle.length];
        result = analyzer.classify(
          snapshot({ rows: ["", `${ch} static`], cols: 40, capturedAt: 1100 + i * 100 })
        );
      }
      expect(result.signal).toBe("spinner");
    });

    it("does NOT return spinner when interval is too slow", () => {
      const cycle = ["⠋", "⠙", "⠹", "⠸"];
      let result = analyzer.classify(
        snapshot({ rows: ["", "  static"], cols: 40, capturedAt: 1000 })
      );
      for (let i = 0; i < 6; i++) {
        const row = `${cycle[i % cycle.length]} static`;
        result = analyzer.classify(
          // 800ms intervals — far too slow to be a spinner glyph.
          snapshot({ rows: ["", row], cols: 40, capturedAt: 1800 + i * 800 })
        );
      }
      expect(result.signal).not.toBe("spinner");
    });
  });

  describe("resize handling", () => {
    it("clears state and returns none on terminal-cols change", () => {
      const cycle = ["⠋", "⠙", "⠹", "⠸"];
      analyzer.classify(snapshot({ rows: ["", "  static"], cols: 40, capturedAt: 1000 }));
      for (let i = 0; i < 3; i++) {
        const row = `${cycle[i]} static`;
        analyzer.classify(snapshot({ rows: ["", row], cols: 40, capturedAt: 1100 + i * 100 }));
      }
      // Resize: same content, new col count.
      const result = analyzer.classify(
        snapshot({ rows: ["", "⠋ static"], cols: 80, capturedAt: 1500 })
      );
      expect(result.signal).toBe("none");
    });

    it("clears state and returns none on terminal-rows change", () => {
      analyzer.classify(snapshot({ rows: ["", "Working 1s"], cols: 40, capturedAt: 1000 }));
      analyzer.classify(snapshot({ rows: ["", "Working 2s"], cols: 40, capturedAt: 1100 }));
      const result = analyzer.classify(
        snapshot({
          rows: ["", "Working 3s"],
          cols: 40,
          capturedAt: 1200,
          terminalRows: 30,
        })
      );
      expect(result.signal).toBe("none");
    });
  });

  describe("reset", () => {
    it("clears all internal state", () => {
      analyzer.classify(snapshot({ rows: ["", "Working 1s"], cols: 40, capturedAt: 1000 }));
      analyzer.classify(snapshot({ rows: ["", "Working 2s"], cols: 40, capturedAt: 1100 }));
      analyzer.reset();
      const result = analyzer.classify(
        snapshot({ rows: ["", "Working 3s"], cols: 40, capturedAt: 1200 })
      );
      // After reset the analyzer treats this as the first observation, so it
      // can't yet conclude anything is incrementing.
      expect(result.signal).toBe("none");
    });
  });
});
