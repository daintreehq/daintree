import { performance } from "node:perf_hooks";
import { SCROLLBACK_DEFAULT, SCROLLBACK_MAX } from "../../../shared/config/scrollback";
import {
  createRestoreTargets,
  disposeTerminals,
  getSnapshotFleet,
  replaySnapshot,
  REPRESENTATIVE_FLEET,
} from "../lib/scrollbackSnapshotFixture";
import { percentile } from "../lib/stats";
import type { PerfScenario } from "../types";

// Session snapshot and replay — the scrollback half of quitting and relaunching
// the app. On teardown every preserved terminal is serialized
// (PreservedSnapshotCapture / AnalysisSession); on launch every restored panel
// feeds its payload back through the xterm parser.
//
// Both legs are per-terminal and multiply by fleet size, which is the point:
// Daintree's normal state is a dozen-plus terminals, so a per-terminal cost that
// looks trivial in isolation becomes a visible chunk of quit-and-relaunch. The
// payload byte count is gated alongside the timings because it is what actually
// lands on disk and gets read back, and it drives both legs.
//
// SCOPE LIMIT on PERF-196 — it measures the PARSER, not production restore.
// `TerminalRestoreController` routes payloads over 256 KiB (these are ~600 KiB)
// through reset, geometry alignment, 32 KiB chunking and UI yields, and
// schedules fleet restores as independent tasks rather than the sequential loop
// here. That controller lives in the renderer behind `@/clients`, so it cannot
// be driven in-process. PERF-196 is therefore a lower bound on the parse work,
// and a regression in chunking, yielding or scheduling is INVISIBLE to it.
// Wall-clock restore belongs in a Playwright benchmark.
//
// PERF-033 already covers writing raw agent output into a terminal. This is a
// different workload: a serialized snapshot is escape-dense reconstruction data,
// not a log stream.

/** A serialized 10k-line coloured buffer is ~600 KiB; well under this is empty or broken. */
const MIN_LARGE_SNAPSHOT_BYTES = 250_000;

export const scrollbackSnapshotScenarios: PerfScenario[] = [
  {
    id: "PERF-195",
    name: "Session Snapshot Capture - Fleet Serialize",
    description:
      "Real SerializeAddon.serialize() across a 12-terminal fleet filled to the 10,000-line " +
      "scrollback maximum with SGR-dense agent output — the teardown cost paid on every quit. " +
      "durationMs is the whole fleet; p95TerminalMs is what one preserved terminal costs and " +
      "snapshotKB is what it writes to disk. snapshotMisses counts terminals whose payload came " +
      "back under the size floor, checked individually so one healthy snapshot cannot mask " +
      "eleven empty ones.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 9, nightly: 14 },
    warmups: 1,
    correctness: ["snapshotMisses"],
    async run() {
      const fleet = await getSnapshotFleet(SCROLLBACK_MAX, REPRESENTATIVE_FLEET);

      const perTerminal: number[] = [];
      const perTerminalBytes: number[] = [];

      const start = performance.now();
      for (const source of fleet.sources) {
        const terminalStart = performance.now();
        const payload = source.addon.serialize();
        perTerminal.push(performance.now() - terminalStart);
        // Byte length, not string length: the metric is named KB and the payload
        // is written to disk as UTF-8, where SGR-heavy content is not 1:1.
        perTerminalBytes.push(Buffer.byteLength(payload, "utf8"));
      }
      const durationMs = performance.now() - start;

      // Per terminal, not in aggregate: `serialize()` returning an empty
      // string is instantaneous, and one healthy snapshot in a summed byte
      // total would happily cover for eleven empty ones.
      const snapshotMisses = perTerminalBytes.filter(
        (bytes) => bytes < MIN_LARGE_SNAPSHOT_BYTES
      ).length;

      const totalBytes = perTerminalBytes.reduce((sum, bytes) => sum + bytes, 0);

      return {
        durationMs,
        metrics: {
          perTerminalMs: durationMs / fleet.sources.length,
          p95TerminalMs: percentile(perTerminal, 95),
          snapshotKB: totalBytes / 1024 / fleet.sources.length,
          fleetSnapshotKB: totalBytes / 1024,
          fleetSize: fleet.sources.length,
          snapshotMisses,
        },
        notes:
          snapshotMisses > 0
            ? `${snapshotMisses}/${fleet.sources.length} terminals serialized under the size floor`
            : undefined,
      };
    },
  },
  {
    id: "PERF-196",
    name: "Session Restore - Fleet Scrollback Reparse (parser floor)",
    description:
      "Feeds a 12-terminal fleet of serialized snapshots back through the real xterm parser and " +
      "waits for each write to drain, at both the 1,000-line default and the 10,000-line maximum. " +
      "This is the PARSER FLOOR, not wall-clock restore: production chunks payloads this size at " +
      "32 KiB with UI yields via TerminalRestoreController, which cannot run in-process. Target " +
      "terminals are built and disposed outside the bracket. replayMisses counts targets that were " +
      "not rebuilt to their full line count.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["replayMisses"],
    async run() {
      const largeFleet = await getSnapshotFleet(SCROLLBACK_MAX, REPRESENTATIVE_FLEET);
      const smallFleet = await getSnapshotFleet(SCROLLBACK_DEFAULT, REPRESENTATIVE_FLEET);

      // Snapshots and restore targets are both prepared outside the bracket:
      // capture is PERF-195's subject, and the xterm instances already exist by
      // the time production replays into them.
      const largePayloads = largeFleet.sources.map((source) => source.addon.serialize());
      const smallPayloads = smallFleet.sources.map((source) => source.addon.serialize());
      const largeTargets = await createRestoreTargets(SCROLLBACK_MAX, largePayloads.length);
      const smallTargets = await createRestoreTargets(SCROLLBACK_DEFAULT, smallPayloads.length);

      try {
        const start = performance.now();

        const largeStart = performance.now();
        for (let i = 0; i < largePayloads.length; i += 1) {
          await replaySnapshot(largeTargets[i]!, largePayloads[i]!);
        }
        const largeMs = performance.now() - largeStart;

        const smallStart = performance.now();
        for (let i = 0; i < smallPayloads.length; i += 1) {
          await replaySnapshot(smallTargets[i]!, smallPayloads[i]!);
        }
        const smallMs = performance.now() - smallStart;

        const durationMs = performance.now() - start;

        // Check EVERY target in both arms: a no-op write is the fastest possible
        // result, so one verified terminal would happily hide 23 broken ones.
        const verify = (
          targets: typeof largeTargets,
          expected: number
        ): { minLines: number; misses: number } => {
          let minLines = Infinity;
          let misses = 0;
          targets.forEach((terminal) => {
            const lines = terminal.buffer.active.length;
            minLines = Math.min(minLines, lines);
            if (lines < expected) misses += 1;
          });
          return { minLines, misses };
        };
        // Serialize emits the trimmed buffer, so a faithful replay lands on the
        // full scrollback; allow a small margin for the trailing partial row.
        const largeVerdict = verify(largeTargets, SCROLLBACK_MAX - 8);
        const smallVerdict = verify(smallTargets, SCROLLBACK_DEFAULT - 8);
        const replayMisses = largeVerdict.misses + smallVerdict.misses;

        return {
          durationMs,
          metrics: {
            largePerTerminalMs: largeMs / largePayloads.length,
            smallPerTerminalMs: smallMs / smallPayloads.length,
            msPerKLine: largeMs / largePayloads.length / (SCROLLBACK_MAX / 1000),
            fleetReparseMs: largeMs,
            restoredLines: largeVerdict.minLines,
            replayMisses,
          },
          notes:
            replayMisses > 0
              ? `${replayMisses} restore targets did not rebuild to their full line count`
              : undefined,
        };
      } finally {
        // Without this, warmups plus iterations leave hundreds of filled
        // terminals for the GC to reclaim at an unpredictable moment — often
        // inside a later timed bracket.
        disposeTerminals(largeTargets);
        disposeTerminals(smallTargets);
      }
    },
  },
];
