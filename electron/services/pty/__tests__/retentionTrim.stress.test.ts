import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { headlessMirrorScheduler } from "../HeadlessMirrorScheduler.js";
import {
  TERMINAL_RETENTION_BUDGETS,
  type TerminalRetentionTier,
} from "../../../../shared/config/terminalRetention.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

/**
 * Deterministic stress tests over REAL TerminalProcess instances (in-thread
 * analysis stack: real headless xterm mirrors sharing the process-wide
 * HeadlessMirrorScheduler) under heavy multi-terminal output with retention
 * sweeps and governor-style targeted trims firing mid-stream.
 *
 * The load-bearing invariant of the memory diet: retention trimming touches
 * ONLY host-side analysis buffers. The renderer-bound byte stream must be
 * byte-exact regardless of how aggressively the mirrors are trimmed — a trim
 * is memory retention policy, never PTY output data loss.
 */

interface Harness {
  terminal: TerminalProcess;
  feed: (data: string) => void;
  received: string[];
  sent: string[];
}

function createHarness(id: string, launchAgentId?: string): Harness {
  let onData: ((data: string) => void) | null = null;
  const pty: Partial<IPty> = {
    pid: 1000,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      onData = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  };
  (pty as Partial<IPty> & { destroy: () => void }).destroy = vi.fn();

  const received: string[] = [];
  const sent: string[] = [];
  const spawnContext: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };

  const terminal = new TerminalProcess(
    id,
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal" as const,
      launchAgentId: launchAgentId as never,
    },
    {
      emitData: (_id, data) => {
        received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      onExit: () => {},
    },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as never,
      ptyPool: null,
      processTreeCache: null,
    },
    spawnContext,
    pty as IPty
  );

  return {
    terminal,
    received,
    sent,
    feed: (data: string) => {
      sent.push(data);
      onData!(data);
    },
  };
}

const TERMINAL_COUNT = 10;
const CHUNKS_PER_TERMINAL = 200;

describe("retention trimming under heavy multi-terminal output (stress)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("delivers every renderer-bound byte exactly, in order, while tiers churn and pressure trims fire mid-stream", async () => {
    const harnesses: Harness[] = [];
    for (let i = 0; i < TERMINAL_COUNT; i++) {
      harnesses.push(createHarness(`stress-${i}`, i % 2 === 0 ? "claude" : undefined));
    }
    const tiers: TerminalRetentionTier[] = ["foreground", "working", "settled", "archived"];

    for (let chunk = 0; chunk < CHUNKS_PER_TERMINAL; chunk++) {
      // Interleave heavy output across the fleet — each chunk is a full line
      // with enough payload that the mirrors accumulate real scrollback.
      for (let t = 0; t < TERMINAL_COUNT; t++) {
        harnesses[t].feed(`term-${t} chunk-${chunk} ${"payload ".repeat(12)}\r\n`);
      }

      // Every 25 chunks: a retention sweep re-tiers a rotating subset, and a
      // governor-style targeted trim slams a rotating subset to its floor —
      // both racing live parse work in the shared mirror scheduler.
      if (chunk % 25 === 24) {
        for (let t = 0; t < TERMINAL_COUNT; t++) {
          const tier = tiers[(t + chunk) % tiers.length];
          harnesses[t].terminal.applyRetentionTier(tier);
        }
        const victim = harnesses[chunk % TERMINAL_COUNT];
        victim.terminal.trimScrollback(TERMINAL_RETENTION_BUDGETS.settled.pressureMirrorFloorLines);
      }

      // Let the mirror scheduler's drain ticks and parse callbacks run.
      if (chunk % 10 === 9) {
        await vi.advanceTimersByTimeAsync(20);
      }
    }

    // Drain everything still queued/parsing.
    await vi.advanceTimersByTimeAsync(2000);

    for (const h of harnesses) {
      // BYTE-EXACT renderer delivery: the visual path is untouched by any
      // trim. Chunk boundaries are also preserved (emitData is per-chunk).
      expect(h.received.join("")).toBe(h.sent.join(""));
      expect(h.received.length).toBe(h.sent.length);
    }

    // The shared scheduler's in-flight accounting fully settles — no wedged
    // aggregate budget after the trim storm.
    expect(headlessMirrorScheduler.inFlightChars()).toBe(0);

    // Every mirror stays bounded by an explicit policy cap, and viewport
    // reads still serve the most recent content (state detection inputs).
    for (let t = 0; t < TERMINAL_COUNT; t++) {
      const h = harnesses[t];
      const cap = h.terminal.getCurrentScrollback();
      const tierCap =
        TERMINAL_RETENTION_BUDGETS[h.terminal.getRetentionTier()!].mirrorScrollbackLines;
      expect(cap).toBeLessThanOrEqual(tierCap);

      const tail = h.terminal.getLastNLines(3).join("\n");
      expect(tail).toContain(`chunk-${CHUNKS_PER_TERMINAL - 1}`);
    }

    for (const h of harnesses) h.terminal.dispose();
  });

  it("keeps retention snapshots consistent and trim bookkeeping monotonic through the churn", async () => {
    const harness = createHarness("stress-single", "claude");
    const { terminal, feed } = harness;

    let lastTrimEpoch = 0;
    let lastTrimCount = 0;
    for (let round = 0; round < 8; round++) {
      for (let chunk = 0; chunk < 50; chunk++) {
        feed(`round-${round} line-${chunk} ${"x".repeat(64)}\r\n`);
      }
      await vi.advanceTimersByTimeAsync(50);

      const tier: TerminalRetentionTier = round % 2 === 0 ? "settled" : "foreground";
      terminal.applyRetentionTier(tier);

      const snapshot = terminal.getRetentionSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.tier).toBe(tier);
      // Monotonic: epochs and counts never regress, and every settled
      // downgrade records exactly one more destructive trim.
      expect(terminal.trimEpoch).toBeGreaterThanOrEqual(lastTrimEpoch);
      expect(snapshot!.trimCount).toBeGreaterThanOrEqual(lastTrimCount);
      if (tier === "settled") {
        expect(snapshot!.trimCount).toBe(lastTrimCount + 1);
        expect(snapshot!.lastTrimReason).toBe("tier-change");
      }
      lastTrimEpoch = terminal.trimEpoch;
      lastTrimCount = snapshot!.trimCount;

      const est = snapshot!.estimatedRetainedBytes;
      expect(est.totalBytes).toBe(
        est.mirrorBytes +
          est.semanticBytes +
          est.forensicsBytes +
          est.agentOutputBytes +
          est.preservedSnapshotBytes
      );
    }

    // Byte-exact delivery held across all rounds.
    expect(harness.received.join("")).toBe(harness.sent.join(""));
    terminal.dispose();
  });
});
