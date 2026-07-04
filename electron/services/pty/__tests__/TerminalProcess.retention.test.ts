import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { DEFAULT_SCROLLBACK, OUTPUT_BUFFER_SIZE, SEMANTIC_BUFFER_MAX_LINES } from "../types.js";
import { FORENSIC_BUFFER_SIZE } from "../TerminalForensicsBuffer.js";
import { TERMINAL_RETENTION_BUDGETS } from "../../../../shared/config/terminalRetention.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

let ptyOnDataCallback: ((data: string) => void) | null = null;

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      ptyOnDataCallback = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  };
  const withDestroy = pty as Partial<IPty> & { destroy: () => void };
  withDestroy.destroy = vi.fn();
  return pty as IPty;
}

function defaultSpawnContext(): SpawnContext {
  return {
    shell: "/bin/zsh",
    args: ["-l"],
    env: {},
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessCallbacks = ConstructorParameters<typeof TerminalProcess>[2];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createTerminal(
  options?: Partial<TerminalProcessOptions>,
  callbacks?: Partial<TerminalProcessCallbacks>,
  agentStateService?: Partial<TerminalProcessDeps["agentStateService"]>
): TerminalProcess {
  return new TerminalProcess(
    "t-retention",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal" as const,
      ...options,
    },
    { emitData: () => {}, onExit: () => {}, ...callbacks },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
        ...agentStateService,
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
    },
    defaultSpawnContext(),
    createMockPty()
  );
}

type RetentionInternals = {
  terminalInfo: {
    agentState?: string;
    contentEpoch: number;
    semanticBuffer: string[];
    outputBuffer: string;
  };
  forensicsBuffer: { getRecentOutput: () => string };
};

async function feedLines(count: number, prefix = "line"): Promise<void> {
  for (let i = 0; i < count; i++) {
    ptyOnDataCallback!(`${prefix} ${i}\r\n`);
  }
  // Let the headless mirror scheduler's setImmediate drain + parse callbacks run.
  await vi.advanceTimersByTimeAsync(200);
}

describe("TerminalProcess retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("foreground budgets match the historical fixed caps (cross-module contract)", () => {
    const fg = TERMINAL_RETENTION_BUDGETS.foreground;
    expect(fg.mirrorScrollbackLines).toBe(DEFAULT_SCROLLBACK);
    expect(fg.semanticBufferLines).toBe(SEMANTIC_BUFFER_MAX_LINES);
    expect(fg.forensicsChars).toBe(FORENSIC_BUFFER_SIZE);
    expect(fg.agentOutputChars).toBe(OUTPUT_BUFFER_SIZE);
  });

  it("applying a lower tier trims the mirror cap and records a tier-change retention trim", () => {
    const terminal = createTerminal();
    expect(terminal.getCurrentScrollback()).toBe(DEFAULT_SCROLLBACK);
    const epochBefore = (terminal as unknown as RetentionInternals).terminalInfo.contentEpoch;

    terminal.applyRetentionTier("settled");

    expect(terminal.getRetentionTier()).toBe("settled");
    expect(terminal.getCurrentScrollback()).toBe(
      TERMINAL_RETENTION_BUDGETS.settled.mirrorScrollbackLines
    );
    const snapshot = terminal.getRetentionSnapshot();
    expect(snapshot).toMatchObject({
      tier: "settled",
      trimCount: 1,
      lastTrimReason: "tier-change",
    });
    expect(snapshot?.lastTrimAt).not.toBeNull();
    expect(terminal.trimEpoch).toBe(1);
    // A destructive trim must invalidate the snapshotter's unchanged-buffer check.
    expect((terminal as unknown as RetentionInternals).terminalInfo.contentEpoch).toBe(
      epochBefore + 1
    );

    terminal.dispose();
  });

  it("re-applying the same tier is a no-op (no trim churn on sweep ticks)", () => {
    const terminal = createTerminal();
    terminal.applyRetentionTier("settled");
    const after = terminal.getRetentionSnapshot();

    terminal.applyRetentionTier("settled");
    terminal.applyRetentionTier("settled");

    expect(terminal.getRetentionSnapshot()).toEqual(after);
    expect(terminal.trimEpoch).toBe(1);
    terminal.dispose();
  });

  it("does not undo a pressure trim below the cap while the tier is unchanged", () => {
    const terminal = createTerminal();
    terminal.applyRetentionTier("working");
    // Governor pressure trim takes the mirror to the working-tier floor.
    terminal.trimScrollback(TERMINAL_RETENTION_BUDGETS.working.pressureMirrorFloorLines);
    expect(terminal.getCurrentScrollback()).toBe(
      TERMINAL_RETENTION_BUDGETS.working.pressureMirrorFloorLines
    );

    // Next sweep re-applies the same tier — the cap must stay at the floor.
    terminal.applyRetentionTier("working");
    expect(terminal.getCurrentScrollback()).toBe(
      TERMINAL_RETENTION_BUDGETS.working.pressureMirrorFloorLines
    );

    // A genuine tier upgrade restores the cap.
    terminal.applyRetentionTier("foreground");
    expect(terminal.getCurrentScrollback()).toBe(
      TERMINAL_RETENTION_BUDGETS.foreground.mirrorScrollbackLines
    );
    terminal.dispose();
  });

  it("a tier upgrade grows the cap without recording a trim", () => {
    const terminal = createTerminal();
    terminal.applyRetentionTier("settled");
    expect(terminal.getRetentionSnapshot()?.trimCount).toBe(1);

    terminal.applyRetentionTier("foreground");
    expect(terminal.getCurrentScrollback()).toBe(DEFAULT_SCROLLBACK);
    expect(terminal.getRetentionSnapshot()?.trimCount).toBe(1);
    expect(terminal.trimEpoch).toBe(1);
    terminal.dispose();
  });

  it("archived tier trims the semantic, forensics, and agent-output tails immediately", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    const internals = terminal as unknown as RetentionInternals;

    await feedLines(40, "some fairly long output line to fill the retention buffers");
    // Semantic buffer flushes on a 100ms timer; feedLines advanced past it.
    expect(internals.terminalInfo.semanticBuffer.length).toBeGreaterThan(10);
    expect(internals.forensicsBuffer.getRecentOutput().length).toBeGreaterThan(1000);
    expect(internals.terminalInfo.outputBuffer.length).toBeGreaterThan(512);

    terminal.applyRetentionTier("archived");

    const budget = TERMINAL_RETENTION_BUDGETS.archived;
    expect(internals.terminalInfo.semanticBuffer.length).toBeLessThanOrEqual(
      budget.semanticBufferLines
    );
    expect(internals.forensicsBuffer.getRecentOutput().length).toBeLessThanOrEqual(
      budget.forensicsChars
    );
    expect(internals.terminalInfo.outputBuffer.length).toBeLessThanOrEqual(budget.agentOutputChars);
    terminal.dispose();
  });

  it("state detection still works after a retention trim: viewport reads serve recent lines and waiting→busy promotion fires", async () => {
    const handleActivityState = vi.fn();
    const terminal = createTerminal({ launchAgentId: "claude" }, undefined, {
      handleActivityState,
    } as never);
    const internals = terminal as unknown as RetentionInternals;
    internals.terminalInfo.agentState = "waiting";

    // Fill well past the post-trim cap, then trim to the settled floor.
    await feedLines(400);
    terminal.trimScrollback(TERMINAL_RETENTION_BUDGETS.settled.pressureMirrorFloorLines);

    // Recent content must survive the trim (the trim evicts OLDEST lines).
    ptyOnDataCallback!("\r\nsentinel-after-trim\r\n");
    await vi.advanceTimersByTimeAsync(100);
    const tail = terminal.getLastNLines(5).join("\n");
    expect(tail).toContain("sentinel-after-trim");

    // The temperature-model promotion path (waiting → busy) keeps working on
    // the trimmed mirror: distinct full-line updates every 100ms for 3s.
    for (let i = 0; i < 30; i++) {
      ptyOnDataCallback!(`\r\nstatus ${i}: ${"#".repeat(20 + (i % 7))}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(handleActivityState).toHaveBeenCalledWith(expect.anything(), "busy", {
      trigger: "output",
    });
    terminal.dispose();
  });

  it("getRetentionSnapshot reports per-category estimates that track the live buffers", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    const internals = terminal as unknown as RetentionInternals;
    terminal.applyRetentionTier("working");

    await feedLines(20);

    const snapshot = terminal.getRetentionSnapshot();
    expect(snapshot).not.toBeNull();
    const est = snapshot!.estimatedRetainedBytes;
    // Mirror estimate follows the scrollback cap × cols × 12 convention.
    expect(est.mirrorBytes).toBe(terminal.getCurrentScrollback() * 80 * 12);
    expect(est.forensicsBytes).toBe(internals.forensicsBuffer.getRecentOutput().length * 2);
    expect(est.agentOutputBytes).toBe(internals.terminalInfo.outputBuffer.length * 2);
    expect(est.preservedSnapshotBytes).toBe(0);
    expect(est.totalBytes).toBe(
      est.mirrorBytes +
        est.semanticBytes +
        est.forensicsBytes +
        est.agentOutputBytes +
        est.preservedSnapshotBytes
    );
    terminal.dispose();
  });

  it("terminals are born stamped at foreground with full budgets and no trims", () => {
    // The construction-time stamp closes the untiered window before the
    // coordinator's first sweep: the governor's non-critical targeted trim
    // must never see a fresh terminal as an unprotected legacy entry.
    const terminal = createTerminal();
    expect(terminal.getRetentionTier()).toBe("foreground");
    expect(terminal.getCurrentScrollback()).toBe(DEFAULT_SCROLLBACK);
    const snapshot = terminal.getRetentionSnapshot();
    expect(snapshot).toMatchObject({ tier: "foreground", trimCount: 0, lastTrimAt: null });
    expect(terminal.trimEpoch).toBe(0);
    terminal.dispose();
  });
});
