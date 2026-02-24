import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalSyncBuffer } from "../TerminalSyncBuffer.js";

describe("TerminalSyncBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("stability-based emission", () => {
    it("emits after stability timeout when no frame boundaries", () => {
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      stabilizer.ingest("normal output");
      expect(emits).toHaveLength(0);

      vi.advanceTimersByTime(100);
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("normal output");
    });

    it("preserves all ANSI sequences", () => {
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      const colored = "\x1b[31mRed\x1b[0m \x1b[44mBlue BG\x1b[0m";
      stabilizer.ingest(colored);
      vi.advanceTimersByTime(100);

      expect(emits[0]).toBe(colored);
    });

    it("resets stability timer on new data", () => {
      const stabilizer = new TerminalSyncBuffer();
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

  describe("traditional frame boundaries (non-DEC-2026 TUIs)", () => {
    it("emits on clear screen boundary", () => {
      const stabilizer = new TerminalSyncBuffer();
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
      const stabilizer = new TerminalSyncBuffer();
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
      const stabilizer = new TerminalSyncBuffer();
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

    it("emits escape sequences after stability timeout", () => {
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Escape sequences are emitted normally after stability timeout
      stabilizer.ingest("\x1b[2K\x1b[1A\x1b[2K\x1b[1Acontent");

      vi.advanceTimersByTime(100);
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("\x1b[2K\x1b[1A\x1b[2K\x1b[1Acontent");
    });
  });

  describe("interactive mode", () => {
    it("uses shorter stability timeout (32ms)", () => {
      const stabilizer = new TerminalSyncBuffer();
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
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Keep adding data to reset stability timer
      for (let i = 0; i < 10; i++) {
        stabilizer.ingest(`chunk${i}`);
        vi.advanceTimersByTime(60); // Reset stability timer each time
      }

      // Should have hit max hold (200ms) by now
      expect(emits.length).toBeGreaterThan(0);
    });
  });

  describe("overflow protection", () => {
    it("force flushes on buffer overflow", () => {
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      const largeData = "x".repeat(512 * 1024 + 1000);
      stabilizer.ingest(largeData);

      expect(emits).toHaveLength(1);
    });
  });

  describe("detach", () => {
    it("flushes pending data on detach", () => {
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));
      stabilizer.ingest("pending");

      expect(emits).toHaveLength(0);

      stabilizer.detach();

      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("pending");
    });
  });

  describe("bypass mode", () => {
    it("passes through data immediately when bypassed", () => {
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));
      stabilizer.setBypass(true);

      stabilizer.ingest("immediate output");

      // Should emit immediately without buffering
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("immediate output");
    });

    it("flushes buffered data when entering bypass mode", () => {
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Buffer some data
      stabilizer.ingest("buffered data");
      expect(emits).toHaveLength(0);

      // Enter bypass mode - should flush immediately
      stabilizer.setBypass(true);
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("buffered data");
    });

    it("resumes normal buffering after bypass disabled", () => {
      const stabilizer = new TerminalSyncBuffer();
      const emits: string[] = [];

      stabilizer.attach({} as any, (data: string) => emits.push(data));

      // Enter and exit bypass
      stabilizer.setBypass(true);
      stabilizer.setBypass(false);

      // New data should buffer normally
      stabilizer.ingest("new data");
      expect(emits).toHaveLength(0);

      vi.advanceTimersByTime(100);
      expect(emits).toHaveLength(1);
      expect(emits[0]).toBe("new data");
    });
  });

  describe("debug state", () => {
    it("tracks state accurately", () => {
      const stabilizer = new TerminalSyncBuffer();

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
