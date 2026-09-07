import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  SessionSnapshotter,
  type SessionSnapshotterHost,
} from "../../../electron/services/pty/SessionSnapshotter";
import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal";
import { colourize, type SnapshotSource } from "./scrollbackSnapshotFixture";
import { buildSearchCorpus } from "./terminalSearchFixture";

/**
 * Fixture for PERF-408 — the SNAPSHOT SCHEDULER, not the serializer.
 *
 * PERF-195 measures what one `SerializeAddon.serialize()` costs. This measures
 * how many of them an agent turn actually pays for, by driving the real
 * `SessionSnapshotter` through the sequence that produces the duplicate:
 * output burst (every chunk calls `schedule()`, arming the 5s debounce), agent
 * state settle 2s later (`flushEventDriven()`), then quiet past the debounce
 * deadline. Before #12237 the debounce fired on content the settle had already
 * written and serialized it again.
 *
 * WHAT IS REAL: the snapshotter itself, its timers and throttle against the
 * real clock, real xterm buffers, real `SerializeAddon` output, and the real
 * `persistSessionSnapshotAsync` writer against a temporary user-data directory.
 *
 * WHAT IS NOT: there is no pty-host, no agent FSM and no analysis worker. The
 * triggers are called directly, so this says nothing about whether production
 * fires them at the right moment — only what the coordinator does once they
 * arrive.
 *
 * SCOPE LIMIT ON THE BRACKET: `durationMs` sums SERIALIZE time only, measured
 * around the addon call, matching PERF-195's exclusion of the disk write. The
 * writes are real and counted, but their latency is not in the number.
 */

/** Chunks per burst, each one a `schedule()` call, as a data-pipeline turn produces. */
const CHUNKS_PER_TURN = 6;
/** Lines per burst — a turn's worth of new agent output on top of a full scrollback. */
const LINES_PER_TURN = 120;
/** Agent state settles this long after the burst, inside the 5s debounce window. */
const SETTLE_AT_MS = 2000;
/** Quiet window after the burst: past SESSION_SNAPSHOT_DEBOUNCE_MS (5000) so every deadline lands. */
const QUIET_LENGTH_MS = 5150;
/** Files must appear within this long after the last turn, or the run is broken. */
const DRAIN_TIMEOUT_MS = 30_000;

export interface SchedulingProbe {
  /** Serializes the coordinator asked for. The duplicate this benchmark exists to count. */
  serializeCalls: number;
  /** Summed addon time. Disk writes are deliberately outside it. */
  serializeMs: number;
}

/**
 * A host whose terminal id is unique per capture.
 *
 * `persistWrites` has to be counted somewhere the host cannot fake, or it is
 * just `serializeCalls` reported twice and a writer that silently early-returns
 * (no `DAINTREE_USER_DATA`, an over-cap payload) reads as a healthy write. One
 * file per capture makes the count a filesystem fact. Captures on a snapshotter
 * never overlap — the in-flight flag guarantees it — so the id read at persist
 * time is always the one stamped by the serialize that produced the payload.
 */
class ScriptedSnapshotHost implements SessionSnapshotterHost {
  wasKilled = false;
  // Undefined on purpose: a terminal with launchAgentId set gets no periodic
  // scheduling in either implementation, so it has no overlap to measure. The
  // subject is a runtime-detected agent in an ordinary terminal, which receives
  // both triggers.
  readonly launchAgentId: string | undefined = undefined;
  contentEpoch = 0;
  private captureSeq = 0;

  constructor(
    private readonly baseId: string,
    private readonly source: SnapshotSource,
    private readonly probe: SchedulingProbe
  ) {}

  get id(): string {
    return `${this.baseId}-c${this.captureSeq}`;
  }

  hasBannerMarkers(): boolean {
    return false;
  }

  getSerializedState(): SerializedTerminalSnapshot {
    return this.capture();
  }

  getSerializedStateAsync(): Promise<SerializedTerminalSnapshot> {
    return Promise.resolve(this.capture());
  }

  serializeForPersistence(): SerializedTerminalSnapshot {
    return this.capture();
  }

  private capture(): SerializedTerminalSnapshot {
    this.captureSeq += 1;
    this.probe.serializeCalls += 1;
    const start = performance.now();
    const data = this.source.addon.serialize();
    this.probe.serializeMs += performance.now() - start;
    return { data, cols: this.source.terminal.cols, rows: this.source.terminal.rows };
  }
}

export interface ScriptedTurnResult {
  serializeCalls: number;
  persistWrites: number;
  serializeMs: number;
  totalPayloadBytes: number;
  /** Terminals whose final persisted bytes differ from a direct serialize of their buffer. */
  payloadMisses: number;
  /** Captures that serialized but produced no file — a writer that quietly did nothing. */
  writeMisses: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countSessionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith(".restore"));
}

/** Write one turn's output, one `schedule()` per chunk, as PtyDataPipeline does. */
async function writeBurst(
  source: SnapshotSource,
  host: ScriptedSnapshotHost,
  snapshotter: SessionSnapshotter,
  seed: number
) {
  const corpus = colourize(buildSearchCorpus(LINES_PER_TURN, seed)).split("\r\n");
  const perChunk = Math.ceil(corpus.length / CHUNKS_PER_TURN);
  for (let i = 0; i < corpus.length; i += perChunk) {
    const chunk = `${corpus.slice(i, i + perChunk).join("\r\n")}\r\n`;
    await new Promise<void>((resolve) => source.terminal.write(chunk, () => resolve()));
    // Every chunk bumps the epoch and asks for a debounced snapshot, exactly as
    // the real pipeline does on each PTY data event. The first one arms the
    // 5s deadline; the rest must not move it.
    host.contentEpoch += 1;
    snapshotter.schedule();
  }
}

/** A v2 session file is `DAINTREE_SESSION_v2\n<cols>x<rows>\n<payload>`. */
const SESSION_HEADER_V2 = "DAINTREE_SESSION_v2\n";
/** Per terminal, not fleet-average: one healthy payload must not cover eleven empty ones. */
const MIN_TERMINAL_SNAPSHOT_BYTES = 250_000;

function captureIndex(fileName: string): number {
  return Number(fileName.slice(fileName.lastIndexOf("-c") + 2, -".restore".length));
}

/** The newest file this terminal wrote, by capture sequence rather than name order. */
function latestFileFor(files: string[], terminalIndex: number): string | undefined {
  return files
    .filter((name) => name.startsWith(`perf197-${terminalIndex}-c`))
    .sort((a, b) => captureIndex(a) - captureIndex(b))
    .at(-1);
}

/** Wait for the writes behind the captures already counted to land. */
async function drainWrites(sessionDir: string, probe: SchedulingProbe): Promise<string[]> {
  const deadline = performance.now() + DRAIN_TIMEOUT_MS;
  let files = await countSessionFiles(sessionDir);
  while (files.length < probe.serializeCalls && performance.now() < deadline) {
    await sleep(10);
    files = await countSessionFiles(sessionDir);
  }
  return files;
}

/**
 * Every terminal's newest persisted payload must equal a direct serialize of
 * its buffer, run after EVERY turn rather than only at the end.
 *
 * A final-only check would pass a coordinator that coalesced away whole turns
 * and happened to write last, reporting fewer serializes and zero misses — the
 * most flattering possible result for the exact bug this measures. These
 * serializes bypass the host, so they never enter the workload counters.
 */
async function verifyFleet(
  sources: SnapshotSource[],
  sessionDir: string,
  files: string[]
): Promise<{ misses: number; bytes: number }> {
  let misses = 0;
  let bytes = 0;
  for (let i = 0; i < sources.length; i += 1) {
    const expected = sources[i]!.addon.serialize();
    const latest = latestFileFor(files, i);
    if (!latest) {
      misses += 1;
      continue;
    }
    const raw = await readFile(path.join(sessionDir, latest), "utf8");
    if (!raw.startsWith(SESSION_HEADER_V2)) {
      misses += 1;
      continue;
    }
    const payload = raw.slice(raw.indexOf("\n", SESSION_HEADER_V2.length) + 1);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    bytes += payloadBytes;
    if (payload !== expected || payloadBytes < MIN_TERMINAL_SNAPSHOT_BYTES) misses += 1;
  }
  return { misses, bytes };
}

/**
 * Drive `turns` scripted agent turns across the fleet concurrently.
 *
 * Concurrent because a fleet finishing turns together is the case that matters,
 * and because the debounce is wall-clock: serialising the terminals would cost
 * `fleetSize * turns * 5s` for the same information.
 */
export async function runScriptedTurns(
  sources: SnapshotSource[],
  turns: number
): Promise<ScriptedTurnResult> {
  const previousUserData = process.env.DAINTREE_USER_DATA;
  const userData = await mkdtemp(path.join(tmpdir(), "daintree-perf-197-"));
  process.env.DAINTREE_USER_DATA = userData;
  const sessionDir = path.join(userData, "terminal-sessions");

  const probe: SchedulingProbe = { serializeCalls: 0, serializeMs: 0 };
  const hosts = sources.map((source, i) => new ScriptedSnapshotHost(`perf197-${i}`, source, probe));
  const snapshotters = hosts.map((host) => new SessionSnapshotter(host));

  let payloadMisses = 0;
  let totalPayloadBytes = 0;
  let files: string[] = [];

  try {
    for (let turn = 0; turn < turns; turn += 1) {
      await Promise.all(
        sources.map((source, i) =>
          writeBurst(source, hosts[i]!, snapshotters[i]!, 4200 + turn * 100 + i)
        )
      );

      // Anchored AFTER the burst on purpose. `schedule()` runs during it, so
      // the latest deadline any terminal armed is burstEnd + 5000; timing the
      // quiet window from here keeps every one of them inside the turn. Timing
      // it from the burst START would let a slow burst push a deadline past the
      // window, and the duplicate it would have produced would go uncounted.
      const quietStart = performance.now();
      await sleep(SETTLE_AT_MS);
      // The agent's FSM settles inside the debounce window — the overlap.
      snapshotters.forEach((snapshotter) => snapshotter.flushEventDriven());
      await sleep(Math.max(0, QUIET_LENGTH_MS - (performance.now() - quietStart)));

      files = await drainWrites(sessionDir, probe);
      const verdict = await verifyFleet(sources, sessionDir, files);
      payloadMisses += verdict.misses;
      totalPayloadBytes = verdict.bytes;
    }

    return {
      serializeCalls: probe.serializeCalls,
      persistWrites: files.length,
      serializeMs: probe.serializeMs,
      totalPayloadBytes,
      payloadMisses,
      writeMisses: probe.serializeCalls - files.length,
    };
  } finally {
    snapshotters.forEach((snapshotter) => snapshotter.dispose());
    if (previousUserData === undefined) delete process.env.DAINTREE_USER_DATA;
    else process.env.DAINTREE_USER_DATA = previousUserData;
    await rm(userData, { recursive: true, force: true });
  }
}
