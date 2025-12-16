/**
 * Terminal Projection Service
 *
 * Provides async screen snapshot generation (single-flight per terminal)
 * and a bounded "clean log" derived from composed headless terminal state.
 *
 * Snapshot generation yields to the event loop to avoid blocking the PTY host
 * message loop under frequent polling.
 */

import type {
  TerminalScreenSnapshot,
  TerminalCleanLogEntry,
} from "../../../shared/types/ipc/terminal.js";

const CLEAN_LOG_MAX_ENTRIES = 2000;
const CLEAN_LOG_DEFAULT_LIMIT = 200;
const ASYNC_SNAPSHOT_YIELD = true;

type SnapshotFn = () => TerminalScreenSnapshot | null;

interface CleanLogState {
  lastLines: string[] | null;
  lastSnapshotTimestamp: number;
  latestSequence: number;
  entries: TerminalCleanLogEntry[];
  lastEmittedByRow: Map<number, { timestamp: number; line: string }>;
}

function isSpinnerishUpdate(prev: string, next: string, dtMs: number): boolean {
  if (dtMs > 300) return false;
  if (!prev || !next) return false;

  const spinnerChars = new Set(["|", "/", "-", "\\"]);
  const prevTrimmed = prev.trimEnd();
  const nextTrimmed = next.trimEnd();

  if (prevTrimmed.length === 0 || nextTrimmed.length === 0) return false;

  const prevLast = prevTrimmed[prevTrimmed.length - 1];
  const nextLast = nextTrimmed[nextTrimmed.length - 1];
  if (!spinnerChars.has(prevLast) || !spinnerChars.has(nextLast)) return false;

  const prevPrefix = prevTrimmed.slice(0, -1);
  const nextPrefix = nextTrimmed.slice(0, -1);
  return prevPrefix === nextPrefix;
}

export class TerminalProjectionService {
  private inFlightSnapshots = new Map<string, Promise<TerminalScreenSnapshot | null>>();
  private cleanLogs = new Map<string, CleanLogState>();

  async getSnapshotAsync(
    id: string,
    snapshotFn: SnapshotFn
  ): Promise<TerminalScreenSnapshot | null> {
    const existing = this.inFlightSnapshots.get(id);
    if (existing) return existing;

    const promise = new Promise<TerminalScreenSnapshot | null>((resolve) => {
      const run = () => {
        try {
          const snapshot = snapshotFn();
          if (snapshot) {
            this.ingestSnapshotForCleanLog(id, snapshot);
          }
          resolve(snapshot);
        } catch (error) {
          console.error(`[TerminalProjectionService] Snapshot failed for ${id}:`, error);
          resolve(null);
        } finally {
          this.inFlightSnapshots.delete(id);
        }
      };

      if (ASYNC_SNAPSHOT_YIELD) {
        setImmediate(run);
      } else {
        run();
      }
    });

    this.inFlightSnapshots.set(id, promise);
    return promise;
  }

  getCleanLog(
    id: string,
    sinceSequence?: number,
    limit?: number
  ): {
    latestSequence: number;
    entries: TerminalCleanLogEntry[];
  } {
    const state = this.cleanLogs.get(id);
    if (!state) {
      return { latestSequence: 0, entries: [] };
    }

    const max = Math.max(1, Math.min(CLEAN_LOG_MAX_ENTRIES, limit ?? CLEAN_LOG_DEFAULT_LIMIT));
    const filtered =
      sinceSequence === undefined
        ? state.entries
        : state.entries.filter((e) => e.sequence > sinceSequence);

    if (filtered.length <= max) {
      return { latestSequence: state.latestSequence, entries: filtered };
    }
    return { latestSequence: state.latestSequence, entries: filtered.slice(-max) };
  }

  clear(id: string): void {
    this.inFlightSnapshots.delete(id);
    this.cleanLogs.delete(id);
  }

  dispose(): void {
    this.inFlightSnapshots.clear();
    this.cleanLogs.clear();
  }

  private ingestSnapshotForCleanLog(id: string, snapshot: TerminalScreenSnapshot): void {
    const nextLines = snapshot.lines;
    const now = snapshot.timestamp;

    const existing =
      this.cleanLogs.get(id) ??
      ({
        lastLines: null,
        lastSnapshotTimestamp: now,
        latestSequence: 0,
        entries: [],
        lastEmittedByRow: new Map(),
      } satisfies CleanLogState);

    if (snapshot.sequence <= existing.latestSequence) {
      return;
    }

    existing.latestSequence = Math.max(existing.latestSequence, snapshot.sequence);

    const prevLines = existing.lastLines;
    if (prevLines) {
      const rowCount = Math.max(prevLines.length, nextLines.length);
      const dt = Math.max(0, now - existing.lastSnapshotTimestamp);

      for (let row = 0; row < rowCount; row++) {
        const prev = prevLines[row] ?? "";
        const next = nextLines[row] ?? "";
        if (prev === next) continue;

        const trimmed = next.trimEnd();
        if (trimmed.length === 0) continue;

        const lastRowEmission = existing.lastEmittedByRow.get(row);
        const rowDt = lastRowEmission ? now - lastRowEmission.timestamp : dt;
        if (lastRowEmission && isSpinnerishUpdate(lastRowEmission.line, trimmed, rowDt)) {
          continue;
        }

        existing.entries.push({ sequence: snapshot.sequence, timestamp: now, line: trimmed });
        existing.lastEmittedByRow.set(row, { timestamp: now, line: trimmed });
      }

      if (existing.entries.length > CLEAN_LOG_MAX_ENTRIES) {
        existing.entries.splice(0, existing.entries.length - CLEAN_LOG_MAX_ENTRIES);
      }
    }

    existing.lastLines = nextLines.slice();
    existing.lastSnapshotTimestamp = now;
    this.cleanLogs.set(id, existing);
  }
}

let projectionInstance: TerminalProjectionService | null = null;

export function getTerminalProjectionService(): TerminalProjectionService {
  if (!projectionInstance) {
    projectionInstance = new TerminalProjectionService();
  }
  return projectionInstance;
}

export function disposeTerminalProjectionService(): void {
  if (projectionInstance) {
    projectionInstance.dispose();
    projectionInstance = null;
  }
}
