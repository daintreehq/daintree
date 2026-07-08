import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as SerializeAddonInstance } from "@xterm/addon-serialize";
import * as xtermHeadlessModule from "@xterm/headless";
import * as serializeAddonModule from "@xterm/addon-serialize";
import { applyXtermReflowFastpath } from "../../../../shared/utils/xtermReflowFastpath.js";

// This module runs under three loaders: Vite (renderer Worker bundle), vitest,
// and a plain node worker_thread via tsx (perf harness). xterm ships a
// webpack-CJS build whose dynamic re-export loop defeats Node's
// cjs-module-lexer, so under the worker_thread the named exports live only on
// the namespace's `default`; bundlers expose them directly. Pick whichever
// shape is present.
function pickExport<T>(ns: object, name: string): T {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- CJS/ESM interop shim: the namespace shape is loader-dependent
  const direct = (ns as Record<string, unknown>)[name];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- caller pins T to the module's own export type
  if (direct) return direct as T;
  const viaDefault = ((ns as { default?: Record<string, unknown> }).default ?? {})[name];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- caller pins T to the module's own export type
  if (viaDefault) return viaDefault as T;
  throw new Error(`xterm module is missing the '${name}' export`);
}

const Terminal = pickExport<typeof import("@xterm/headless").Terminal>(
  xtermHeadlessModule,
  "Terminal"
);
const SerializeAddon = pickExport<typeof import("@xterm/addon-serialize").SerializeAddon>(
  serializeAddonModule,
  "SerializeAddon"
);

// Phase 4 of the paint fabric: the off-main-thread parse authority.
//
// xterm's InputHandler has no parse↔render seam to thread at, so instead of
// forking it, the fabric runs a SECOND, headless xterm as the parse authority
// for a flooding background terminal: the authority absorbs every byte at
// input rate (holding canonical buffer state, full scrollback), and the
// main-thread terminal becomes a mirror that receives bounded serialized
// snapshots at a fixed cadence. Main-thread cost per background terminal
// drops from O(bytes streamed) to O(snapshot size) per tick, and the
// authority — pure JS, no DOM — runs in a Web Worker (renderer), a node
// worker_thread (perf harness), or in-thread (tests) behind one transport.
//
// The mirror is lossy DURING a flood by design (its scrollback shows the
// most recent `boundedScrollbackLines`); a full-fidelity snapshot is taken
// at every sync point (reveal, focus, mode promotion), which restores the
// complete scrollback from the authority's canonical state.
export interface ParseAuthorityOptions {
  cols: number;
  rows: number;
  scrollback: number;
}

export interface AuthoritySnapshot {
  generation: number;
  serialized: string;
  isAltBuffer: boolean;
}

export class ParseAuthority {
  private terminal: HeadlessTerminal;
  private serializeAddon: SerializeAddonInstance;
  private generation = 0;
  private dirty = false;
  private pendingWrites = 0;
  private lastSnapshotBounded = false;

  constructor(options: ParseAuthorityOptions) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      allowProposedApi: true,
    });
    applyXtermReflowFastpath(this.terminal);
    this.serializeAddon = new SerializeAddon();
    // The serialize addon types against the renderer Terminal but only uses
    // the buffer API both builds share; headless + serialize is the upstream
    // pairing for exactly this server-side use. The nominal type mismatch
    // (renderer ITerminalAddon vs headless ITerminalAddon) forces the cast.
    this.terminal.loadAddon(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- cross-build xterm addon load, structurally identical interfaces
      this.serializeAddon as unknown as Parameters<HeadlessTerminal["loadAddon"]>[0]
    );
  }

  // `onParsed` fires from xterm's write-completion callback — the moment the
  // bytes are actually parsed into canonical state. The live ingest path acks
  // the pty-host from it (flow control must track parse completion, not
  // message receipt).
  write(data: string | Uint8Array, onParsed?: () => void): void {
    this.pendingWrites += 1;
    try {
      this.terminal.write(data, () => {
        this.pendingWrites -= 1;
        this.dirty = true;
        onParsed?.();
      });
    } catch (error) {
      // xterm's WriteBuffer throws past its discard watermark; roll the
      // counter back so drain() cannot wait on a write that will never parse.
      this.pendingWrites -= 1;
      throw error;
    }
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
    this.dirty = true;
  }

  // Re-seed authority state from a serialized snapshot (a session demoting a
  // terminal back to worker parse after a passthrough period, during which
  // the authority saw none of the bytes).
  restore(serialized: string): void {
    this.terminal.reset();
    this.write(serialized);
  }

  isDirty(): boolean {
    return this.dirty;
  }

  // Resolves once every write accepted so far has been parsed. Ordering rides
  // xterm's FIFO write buffer: a zero-length write enqueued now completes
  // after everything before it.
  drain(): Promise<void> {
    if (this.pendingWrites === 0) return Promise.resolve();
    return new Promise((resolve) => this.terminal.write("", () => resolve()));
  }

  /**
   * Serialize current canonical state. `boundedScrollbackLines` caps how much
   * scrollback the snapshot carries (cadence ticks stay O(bound) on the
   * mirror's main thread); `undefined` serializes everything (sync points).
   * Returns null when nothing changed since the last snapshot — the cadence
   * loop turns into a no-op for idle terminals. Exception: a FULL snapshot
   * request after a bounded one always serializes, even when clean — the
   * mirror's scrollback is truncated to the bound, and a sync point
   * (promotion, reveal) exists precisely to restore full fidelity.
   */
  async takeSnapshot(boundedScrollbackLines?: number): Promise<AuthoritySnapshot | null> {
    const wantsFull = boundedScrollbackLines === undefined;
    const clean = !this.dirty && this.pendingWrites === 0;
    if (clean && !(wantsFull && this.lastSnapshotBounded)) return null;
    await this.drain();
    this.dirty = false;
    this.lastSnapshotBounded = !wantsFull;
    this.generation += 1;
    const serialized = this.serializeAddon.serialize(
      boundedScrollbackLines === undefined ? undefined : { scrollback: boundedScrollbackLines }
    );
    return {
      generation: this.generation,
      serialized,
      isAltBuffer: this.terminal.buffer.active.type === "alternate",
    };
  }

  // Test/diagnostic access to canonical buffer text (trailing blank viewport
  // rows trimmed, so equivalence checks compare content, not padding).
  bufferText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n").replace(/\n+$/, "");
  }

  cols(): number {
    return this.terminal.cols;
  }

  rows(): number {
    return this.terminal.rows;
  }

  dispose(): void {
    this.serializeAddon.dispose();
    this.terminal.dispose();
  }
}
