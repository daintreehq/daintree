import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/headless";
import { createHeadlessTerminal } from "./workloads";
import { buildSearchCorpus } from "./terminalSearchFixture";

/**
 * Fixture for the session snapshot/restore scenarios (PERF-195/196).
 *
 * Every preserved terminal is captured with `SerializeAddon.serialize()` — see
 * PreservedSnapshotCapture.snapshotAndDispose and AnalysisSession — and every
 * restored terminal replays that payload back through the xterm parser. Both
 * legs run once per terminal per app lifecycle, so the cost multiplies by fleet
 * size on quit and again on launch.
 *
 * The corpus is SGR-dense on purpose: real agent and build output is heavily
 * coloured, and colour is what dominates a serialized payload. A plain-text
 * corpus would understate both the byte count and the reparse cost by a wide
 * margin.
 */

/** Matches PERF-121's background fleet, so the two benchmarks stay comparable. */
export const REPRESENTATIVE_FLEET = 12;

/**
 * Wrap two of every three lines in SGR sequences (green, then bold red). The
 * pattern is fixed rather than random so payload size is deterministic across
 * runs — a snapshot that changed size run to run would make the byte metrics
 * unreadable.
 */
function colourize(corpus: string): string {
  return corpus
    .split("\r\n")
    .map((line, index) => {
      if (line.length === 0) return line;
      if (index % 3 === 0) return `\x1b[32m${line}\x1b[0m`;
      if (index % 3 === 1) return `\x1b[1;31m${line}\x1b[0m`;
      return line;
    })
    .join("\r\n");
}

export interface SnapshotSource {
  terminal: Terminal;
  addon: SerializeAddon;
}

async function createSeededTerminal(
  scrollbackLines: number,
  seed: number
): Promise<SnapshotSource> {
  const terminal = await createHeadlessTerminal({
    cols: 120,
    rows: 40,
    scrollback: scrollbackLines,
  });
  const { SerializeAddon: SerializeAddonCtor } = await import("@xterm/addon-serialize");
  const addon = new SerializeAddonCtor();
  terminal.loadAddon(addon);

  // Overfill so the scrollback is trimmed to its steady-state size, which is
  // the state a long-running agent terminal is actually snapshotted in.
  const corpus = colourize(buildSearchCorpus(Math.floor(scrollbackLines * 1.2), seed));
  await new Promise<void>((resolve) => {
    terminal.write(corpus, () => resolve());
  });

  return { terminal, addon };
}

export interface SnapshotFleet {
  sources: SnapshotSource[];
  scrollbackLines: number;
}

const fleetCache = new Map<string, Promise<SnapshotFleet>>();

/**
 * Build a fleet of seeded terminals once per process. `serialize()` does not
 * mutate the buffer, so the same fleet is safe to re-snapshot every iteration.
 */
export function getSnapshotFleet(scrollbackLines: number, size: number): Promise<SnapshotFleet> {
  const key = `${scrollbackLines}:${size}`;
  let existing = fleetCache.get(key);
  if (!existing) {
    existing = (async () => {
      const sources: SnapshotSource[] = [];
      for (let i = 0; i < size; i += 1) {
        // Distinct seeds so terminals do not share a buffer shape and give the
        // allocator an unrealistically friendly access pattern.
        sources.push(await createSeededTerminal(scrollbackLines, 1950 + i));
      }
      return { sources, scrollbackLines };
    })();
    fleetCache.set(key, existing);
  }
  return existing;
}

/**
 * Fresh, empty terminals to replay snapshots into. Created OUTSIDE the timed
 * bracket by callers: in production the xterm instance already exists when a
 * snapshot is replayed into it, so construction is not part of restore latency.
 */
export async function createRestoreTargets(
  scrollbackLines: number,
  count: number
): Promise<Terminal[]> {
  const targets: Terminal[] = [];
  for (let i = 0; i < count; i += 1) {
    targets.push(
      await createHeadlessTerminal({ cols: 120, rows: 40, scrollback: scrollbackLines })
    );
  }
  return targets;
}

/**
 * Replay one payload and resolve only once the parser has drained it.
 *
 * This is a single raw `write` — deliberately NOT the production restore path.
 * `TerminalRestoreController` splits payloads over 256 KiB into 32 KiB chunks
 * with UI yields between them, so the number this produces is the parser floor,
 * not wall-clock restore. See the note on PERF-196.
 *
 * The timeout exists because a write whose callback never fires would otherwise
 * hang the whole benchmark run until the workflow timeout.
 */
export function replaySnapshot(terminal: Terminal, payload: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("snapshot replay did not drain within 30s — parser callback never fired"));
    }, 30_000);
    terminal.write(payload, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Free a terminal's buffers once a scenario is done with it. */
export function disposeTerminals(terminals: Terminal[]): void {
  for (const terminal of terminals) {
    terminal.dispose();
  }
}
