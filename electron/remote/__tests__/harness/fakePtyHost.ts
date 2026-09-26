import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";
import type { FakeMessagePortMain } from "./fakeElectron.js";

/**
 * A pty-host stand-in that speaks its window-port protocol: output goes out as
 * `{type:"data", id, data, bytes}` to every connection scoped to the
 * terminal's project and counts as unacked until an `ack` for it arrives;
 * `write` and `resize` reach the terminal; a `serialize-fence` is answered
 * the way the real port handler does (the marker FIFO behind everything sent,
 * then the snapshot from `getSerializedStateAsync`).
 */

export interface FakeTerminal {
  id: string;
  projectId: string;
  /** What the headless mirror would hold: the tail of all output. */
  transcript: string;
  cols: number;
  rows: number;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  /** Echo every write straight back as output, like a shell in cooked mode. */
  echo: boolean;
}

interface Connection {
  windowId: number;
  projectId: string | null;
  port: FakeMessagePortMain;
  unacked: Map<string, number>;
}

/** How much output the fake mirror keeps for a snapshot. */
export const SNAPSHOT_TAIL_CHARS = 64 * 1024;

export class FakePtyHost {
  readonly terminals = new Map<string, FakeTerminal>();
  readonly connections = new Map<number, Connection>();
  readonly fences: Array<{ id: string; requestId: number }> = [];
  private readonly contexts = new Map<number, string>();
  private readonly writeListeners = new Set<(id: string, data: string) => void>();
  private readonly encoder = new TextEncoder();

  /** The PtyClient surface the host's terminal bridge uses. */
  readonly client = {
    registerAuxConnectionContext: (connectionId: number, projectId: string) => {
      this.contexts.set(connectionId, projectId);
    },
    setAuxConnectionRefresh: () => undefined,
    connectMessagePort: (windowId: number, port: FakeMessagePortMain) => {
      this.connect(windowId, port);
    },
    disconnectMessagePort: (windowId: number) => {
      const connection = this.connections.get(windowId);
      if (!connection) return;
      this.connections.delete(windowId);
      connection.port.close();
    },
    getTerminalProjectId: (id: string) => this.terminals.get(id)?.projectId ?? null,
  };

  spawn(id: string, projectId: string, options: { echo?: boolean } = {}): FakeTerminal {
    const terminal: FakeTerminal = {
      id,
      projectId,
      transcript: "",
      cols: 80,
      rows: 24,
      writes: [],
      resizes: [],
      echo: options.echo ?? false,
    };
    this.terminals.set(id, terminal);
    return terminal;
  }

  /** PTY output for `id`; returns its byte length. */
  emit(id: string, text: string): number {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`No fake terminal ${id}`);
    terminal.transcript = (terminal.transcript + text).slice(-SNAPSHOT_TAIL_CHARS);
    const data = this.encoder.encode(text);
    for (const connection of this.connections.values()) {
      if (connection.projectId !== terminal.projectId) continue;
      connection.unacked.set(id, (connection.unacked.get(id) ?? 0) + data.byteLength);
      connection.port.postMessage({ type: "data", id, data, bytes: data.byteLength });
    }
    return data.byteLength;
  }

  /** Bytes sent for `id` that no connection has acked yet. */
  unacked(id: string): number {
    let total = 0;
    for (const connection of this.connections.values()) total += connection.unacked.get(id) ?? 0;
    return total;
  }

  onWrite(listener: (id: string, data: string) => void): () => void {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }

  async getSerializedStateAsync(id: string): Promise<SerializedTerminalSnapshot | null> {
    const terminal = this.terminals.get(id);
    if (!terminal) return null;
    return { data: terminal.transcript, cols: terminal.cols, rows: terminal.rows };
  }

  private connect(windowId: number, port: FakeMessagePortMain): void {
    this.client.disconnectMessagePort(windowId);
    const connection: Connection = {
      windowId,
      projectId: this.contexts.get(windowId) ?? null,
      port,
      unacked: new Map(),
    };
    this.connections.set(windowId, connection);
    port.on("message", (event: { data: unknown }) => this.onPortMessage(connection, event.data));
    port.on("close", () => {
      if (this.connections.get(windowId) === connection) this.connections.delete(windowId);
    });
    port.start();
  }

  private onPortMessage(connection: Connection, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    const id = message.id;
    if (typeof id !== "string") return;
    const terminal = this.terminals.get(id);
    switch (message.type) {
      case "write": {
        if (!terminal || typeof message.data !== "string") return;
        terminal.writes.push(message.data);
        for (const listener of [...this.writeListeners]) listener(id, message.data);
        if (terminal.echo) this.emit(id, message.data);
        return;
      }
      case "resize": {
        if (!terminal || typeof message.cols !== "number" || typeof message.rows !== "number") {
          return;
        }
        terminal.cols = message.cols;
        terminal.rows = message.rows;
        terminal.resizes.push({ cols: message.cols, rows: message.rows });
        return;
      }
      case "ack": {
        if (typeof message.bytes !== "number") return;
        const owed = connection.unacked.get(id) ?? 0;
        connection.unacked.set(id, Math.max(0, owed - message.bytes));
        return;
      }
      case "serialize-fence": {
        const requestId = message.requestId;
        if (typeof requestId !== "number") return;
        this.fences.push({ id, requestId });
        connection.port.postMessage({ type: "serialize-fence", id, requestId });
        void this.getSerializedStateAsync(id).then(
          (state) =>
            connection.port.postMessage({ type: "serialized-state", id, requestId, state }),
          () =>
            connection.port.postMessage({ type: "serialized-state", id, requestId, state: null })
        );
        return;
      }
    }
  }
}
