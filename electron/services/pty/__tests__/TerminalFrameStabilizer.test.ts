import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalFrameStabilizer } from "../TerminalFrameStabilizer.js";

describe("TerminalFrameStabilizer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("stability-based emission", () => {
    it("emits after stability timeout when no frame boundaries", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      stabilizer.ingest("normal output");
      expect(emits).toHaveLength(0);

      vi.advanceTimersByTime(100);
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("normal output");
    });

    it("preserves all ANSI sequences", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      const colored = "\x1b[31mRed\x1b[0m \x1b[44mBlue BG\x1b[0m";
      stabilizer.ingest(colored);
      vi.advanceTimersByTime(100);

      expect(emits[0]).toBe(colored);
    });

    it("resets stability timer on new data", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      stabilizer.ingest("part1");
      vi.advanceTimersByTime(50);
      expect(emits).toHaveLength(0);

      stabilizer.ingest("part2");
      vi.advanceTimersByTime(50);
      expect(emits).toHaveLength(0);

      vi.advanceTimersByTime(50);
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("part1part2");
    });
  });

  describe("synchronized output mode", () => {
    it("buffers during sync mode and emits on sync end", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Start sync mode
      stabilizer.ingest("\x1b[?2026h");
      expect(emits).toHaveLength(0); // Still buffering

      // Add content during sync mode
      stabilizer.ingest("\x1b[2K\x1b[1Acontent");
      expect(emits).toHaveLength(0); // Still buffering

      // End sync mode - should emit complete frame
      stabilizer.ingest("\x1b[?2026l");
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("\x1b[?2026h\x1b[2K\x1b[1Acontent\x1b[?2026l");
    });

    it("handles multiple sync frames in one chunk", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Two complete sync frames in one chunk
      stabilizer.ingest("\x1b[?2026hFrame1\x1b[?2026l\x1b[?2026hFrame2\x1b[?2026l");

      expect(emits).toHaveLength(2);
      expect(emits[0]).toBe("\x1b[?2026hFrame1\x1b[?2026l");
      expect(emits[1]).toBe("\x1b[?2026hFrame2\x1b[?2026l");
    });

    it("emits content before sync mode starts", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Content before sync start
      stabilizer.ingest("prefix\x1b[?2026hcontent\x1b[?2026l");

      // Should emit prefix immediately (pre-sync), then complete frame
      expect(emits).toHaveLength(2);
      expect(emits[0]).toBe("prefix");
      expect(emits[1]).toBe("\x1b[?2026hcontent\x1b[?2026l");
    });

    it("times out sync mode after 500ms", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Start sync mode but never end it
      stabilizer.ingest("\x1b[?2026hhanging content");
      expect(emits).toHaveLength(0);

      // Wait for sync timeout
      vi.advanceTimersByTime(500);
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("\x1b[?2026hhanging content");
    });
  });

  describe("traditional frame boundaries (non-sync TUIs)", () => {
    it("emits on clear screen boundary", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Content followed by clear screen
      stabilizer.ingest("old content\x1b[2Jnew content");

      // "old content" emitted immediately at boundary
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("old content");

      // Remaining content emitted after stability
      vi.advanceTimersByTime(100);
      expect(emits).toHaveLength(2);
      expect(emits[1]).toBe("\x1b[2Jnew content");
    });

    it("emits on alt buffer boundary", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Content followed by alt buffer switch
      stabilizer.ingest("normal\x1b[?1049halt screen");

      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("normal");

      vi.advanceTimersByTime(100);
      expect(emits).toHaveLength(2);
      expect(emits[1]).toBe("\x1b[?1049halt screen");
    });

    it("handles multiple boundaries in one chunk", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      stabilizer.ingest("A\x1b[2JB\x1b[2JC");

      // A and B emitted at boundaries
      expect(emits).toHaveLength(2);
      expect(emits[0]).toBe("A");
      expect(emits[1]).toBe("\x1b[2JB");

      // C emitted after stability
      vi.advanceTimersByTime(100);
      expect(emits).toHaveLength(3);
      expect(emits[2]).toBe("\x1b[2JC");
    });
  });

  describe("interactive mode", () => {
    it("uses shorter stability timeout (32ms)", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));
      stabilizer.markInteractive();

      stabilizer.ingest("typing");

      vi.advanceTimersByTime(32);
      expect(emits).toHaveLength(1);
    });
  });

  describe("max hold time", () => {
    it("emits after max hold even if data keeps arriving", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Keep adding data to reset stability timer
      for (let i = 0; i < 10; i++) {
        stabilizer.ingest(`chunk${i}`);
        vi.advanceTimersByTime(60); // Reset stability timer each time
      }

      // Should have hit max hold (500ms) by now
      expect(emits.length).toBeGreaterThan(0);
    });
  });

  describe("overflow protection", () => {
    it("force flushes on buffer overflow", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      const largeData = "x".repeat(512 * 1024 + 1000);
      stabilizer.ingest(largeData);

      expect(emits).toHaveLength(1);
    });
  });

  describe("detach", () => {
    it("flushes pending data on detach", () => {
      const stabilizer = new TerminalFrameStabilizer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));
      stabilizer.ingest("pending");

      expect(emits).toHaveLength(0);

      stabilizer.detach();

      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("pending");
    });
  });

  describe("debug state", () => {
    it("tracks state accurately", () => {
      const stabilizer = new TerminalFrameStabilizer();

      stabilizer.attach({} as any, () => {});

      let state = stabilizer.getDebugState();
      expect(state.hasPending).toBe(false);
      expect(state.pendingBytes).toBe(0);
      expect(state.framesEmitted).toBe(0);

      stabilizer.ingest("test data");
      state = stabilizer.getDebugState();
      expect(state.hasPending).toBe(true);
      expect(state.pendingBytes).toBe(9);

      vi.advanceTimersByTime(100);
      state = stabilizer.getDebugState();
      expect(state.framesEmitted).toBe(1);
      expect(state.hasPending).toBe(false);
    });
  });
});
