/**
 * TerminalSnapshotEngine - Handles terminal screen snapshot logic.
 *
 * Extracted from TerminalProcess to separate snapshot concerns:
 * - Jump-back persistence to prevent single-frame artifacts
 * - Settle-window diff gating during active output
 * - Viewport projection and change detection
 */

import type { TerminalScreenSnapshot } from "../../../../shared/types/ipc/terminal.js";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";

// Snapshot timing constants
const SNAPSHOT_SETTLE_MS = 40;
const SNAPSHOT_MAX_IN_SETTLE_CHANGED_LINES = 2;
const SNAPSHOT_MAX_IN_SETTLE_CHANGED_CHARS = 12;

// Jump-back persistence constants
const JUMP_BACK_PERSIST_MS = 120;
const JUMP_BACK_PERSIST_FRAMES = 2;
const JUMP_BACK_MAX_SUPPRESS_MS = 1000;
const RESIZE_PERSIST_MS = 200;

interface PendingJumpBack {
  viewportStart: number;
  buffer: "active" | "alt";
  firstSeenAt: number;
  stableFrames: number;
  reason: "backward" | "buffer_switch" | "resize";
}

function estimateChangedChars(prev: string, next: string): number {
  if (prev === next) return 0;
  if (prev.length === 0) return next.length;
  if (next.length === 0) return prev.length;

  const maxLen = Math.max(prev.length, next.length);
  let prefix = 0;
  while (prefix < maxLen && prev[prefix] === next[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < maxLen - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }

  return Math.max(1, maxLen - prefix - suffix);
}

function estimateViewportDelta(
  prev: string[],
  next: string[]
): { changedLines: number; changedChars: number } {
  const rowCount = Math.max(prev.length, next.length);
  let changedLines = 0;
  let changedChars = 0;
  for (let i = 0; i < rowCount; i++) {
    const a = prev[i] ?? "";
    const b = next[i] ?? "";
    if (a === b) continue;
    changedLines++;
    changedChars += estimateChangedChars(a, b);
  }
  return { changedLines, changedChars };
}

export interface SnapshotEngineOptions {
  verbose?: boolean;
}

export class TerminalSnapshotEngine {
  private sequence = 0;
  private dirty = true;
  private dirtyKind: "output" | "resize" | "unknown" = "unknown";
  private lastSnapshot: TerminalScreenSnapshot | null = null;

  // Jump-back persistence state
  private lastAcceptedViewportStart: number | null = null;
  private lastAcceptedBuffer: "active" | "alt" | null = null;
  private pendingJumpBack: PendingJumpBack | null = null;

  constructor(
    private id: string,
    private options: SnapshotEngineOptions = {}
  ) {}

  /**
   * Mark the snapshot as dirty due to output.
   */
  markDirtyOutput(): void {
    this.dirty = true;
    this.dirtyKind = "output";
  }

  /**
   * Mark the snapshot as dirty due to resize.
   */
  markDirtyResize(): void {
    this.dirty = true;
    this.dirtyKind = "resize";
  }

  /**
   * Get the current snapshot if available without computing.
   */
  getCachedSnapshot(): TerminalScreenSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Get a composed screen snapshot from the headless terminal.
   * Implements jump-back persistence and settle-window gating.
   */
  getSnapshot(
    headlessTerminal: HeadlessTerminalType,
    serializeAddon: SerializeAddonType | undefined,
    lastOutputTime: number,
    bufferPreference: "active" | "alt" | "auto" = "auto"
  ): TerminalScreenSnapshot | null {
    const buffer =
      bufferPreference === "active"
        ? headlessTerminal.buffer.normal
        : bufferPreference === "alt"
          ? headlessTerminal.buffer.alternate
          : headlessTerminal.buffer.active;

    const bufferName: "active" | "alt" =
      buffer === headlessTerminal.buffer.alternate ? "alt" : "active";

    // Return cached if not dirty and same buffer
    if (!this.dirty && this.lastSnapshot?.buffer === bufferName) {
      return this.lastSnapshot;
    }

    const now = Date.now();
    const cols = headlessTerminal.cols;
    const rows = headlessTerminal.rows;
    const start = buffer.baseY;
    const bufferLength = buffer.length;

    // Jump-back persistence gate
    const isBufferSwitch =
      this.lastAcceptedBuffer !== null && bufferName !== this.lastAcceptedBuffer;
    const isBackward =
      this.lastAcceptedViewportStart !== null &&
      bufferName === this.lastAcceptedBuffer &&
      start < this.lastAcceptedViewportStart;
    const isResize = this.dirtyKind === "resize";

    const persistMs = isResize ? RESIZE_PERSIST_MS : JUMP_BACK_PERSIST_MS;

    if (isBufferSwitch || isBackward) {
      const reason: "backward" | "buffer_switch" | "resize" = isBufferSwitch
        ? "buffer_switch"
        : isResize
          ? "resize"
          : "backward";

      const sameCandidate =
        this.pendingJumpBack &&
        this.pendingJumpBack.viewportStart === start &&
        this.pendingJumpBack.buffer === bufferName;

      if (sameCandidate) {
        this.pendingJumpBack!.stableFrames++;
      } else {
        this.pendingJumpBack = {
          viewportStart: start,
          buffer: bufferName,
          firstSeenAt: now,
          stableFrames: 1,
          reason,
        };
      }

      const elapsed = now - this.pendingJumpBack!.firstSeenAt;
      const shouldAccept =
        elapsed >= persistMs ||
        this.pendingJumpBack!.stableFrames >= JUMP_BACK_PERSIST_FRAMES ||
        elapsed >= JUMP_BACK_MAX_SUPPRESS_MS;

      if (!shouldAccept) {
        if (this.options.verbose) {
          console.log(
            `[TerminalSnapshotEngine] Suppressing ${reason} for ${this.id}: ` +
              `start=${start} (was ${this.lastAcceptedViewportStart}), ` +
              `buffer=${bufferName} (was ${this.lastAcceptedBuffer}), ` +
              `elapsed=${elapsed}ms, frames=${this.pendingJumpBack!.stableFrames}`
          );
        }
        return this.lastSnapshot;
      }

      if (this.options.verbose) {
        console.log(
          `[TerminalSnapshotEngine] Accepting ${reason} for ${this.id} after ` +
            `${elapsed}ms / ${this.pendingJumpBack!.stableFrames} frames`
        );
      }
      this.pendingJumpBack = null;
    } else {
      this.pendingJumpBack = null;
    }

    // Build candidate snapshot lines
    const lines: string[] = new Array(rows);
    for (let row = 0; row < rows; row++) {
      const line = buffer.getLine(start + row);
      lines[row] = line ? line.translateToString(true, 0, cols) : "";
    }

    // Settle-window diff gate
    if (
      this.dirty &&
      this.dirtyKind === "output" &&
      this.lastSnapshot?.buffer === bufferName &&
      now - lastOutputTime < SNAPSHOT_SETTLE_MS
    ) {
      const previousLines = this.lastSnapshot?.lines ?? [];
      const delta = estimateViewportDelta(previousLines, lines);
      const isSmallUpdate =
        delta.changedLines <= SNAPSHOT_MAX_IN_SETTLE_CHANGED_LINES &&
        delta.changedChars <= SNAPSHOT_MAX_IN_SETTLE_CHANGED_CHARS;

      if (!isSmallUpdate) {
        return this.lastSnapshot;
      }
    }

    const cursorX = Math.max(0, Math.min(cols - 1, buffer.cursorX));
    const cursorY = Math.max(0, Math.min(rows - 1, buffer.cursorY));

    let ansi: string | undefined;
    try {
      if (serializeAddon) {
        if (bufferName === "active") {
          const rangeStart = Math.max(0, start);
          const rangeEnd = Math.max(rangeStart, Math.min(buffer.length - 1, start + rows - 1));
          ansi =
            "\x1b[2J\x1b[H" +
            serializeAddon.serialize({
              range: { start: rangeStart, end: rangeEnd } as any,
              excludeAltBuffer: true,
              excludeModes: true,
            } as any);
        } else {
          const serialized = serializeAddon.serialize({
            scrollback: 0,
            excludeModes: true,
            excludeAltBuffer: false,
          } as any);
          const marker = "\x1b[?1049h\x1b[H";
          const markerIndex = serialized.indexOf(marker);
          ansi = "\x1b[2J\x1b[H" + (markerIndex >= 0 ? serialized.slice(markerIndex) : serialized);
        }
      }
    } catch (error) {
      if (this.options.verbose) {
        console.warn(`[TerminalSnapshotEngine] Failed to produce ANSI snapshot for ${this.id}:`, error);
      }
    }

    const snapshot: TerminalScreenSnapshot = {
      cols,
      rows,
      buffer: bufferName,
      cursor: { x: cursorX, y: cursorY, visible: true },
      lines,
      ansi,
      timestamp: now,
      sequence: ++this.sequence,
      meta: {
        viewportStart: start,
        baseY: buffer.baseY,
        bufferLength,
      },
    };

    // Commit as accepted
    this.lastAcceptedViewportStart = start;
    this.lastAcceptedBuffer = bufferName;
    this.dirty = false;
    this.dirtyKind = "unknown";
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Reset state when terminal is disposed.
   */
  reset(): void {
    this.dirty = true;
    this.dirtyKind = "unknown";
    this.lastSnapshot = null;
    this.lastAcceptedViewportStart = null;
    this.lastAcceptedBuffer = null;
    this.pendingJumpBack = null;
  }
}
