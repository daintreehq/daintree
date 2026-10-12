import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";
import type { PortLike } from "../ports.js";

export function wrapNodePort(port: MessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on("message", listener);
    },
    onClose: (listener) => {
      port.on("close", listener);
    },
    close: () => port.close(),
  };
}

export type Recorded = Record<string, unknown>;

/**
 * The far end of a port the code under test holds: records what it is sent
 * and can post back. Stands in for the pty-host, a renderer or a workspace host.
 */
export class FakePeer {
  readonly received: Recorded[] = [];
  private readonly channel = new MessageChannel();
  private closed = false;

  constructor() {
    this.channel.port2.on("message", (message: Recorded) => this.received.push(message));
  }

  /** Also react to what the code under test posts. */
  protected onReceive(listener: (message: Recorded) => void): void {
    this.channel.port2.on("message", listener);
  }

  /** The end handed to the code under test. */
  get port(): PortLike {
    return wrapNodePort(this.channel.port1);
  }

  post(message: unknown): void {
    this.channel.port2.postMessage(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.port2.close();
  }

  ofType(type: string): Recorded[] {
    return this.received.filter((m) => m.type === type);
  }

  ackedBytes(id?: string): number {
    return this.ofType("ack")
      .filter((m) => id === undefined || m.id === id)
      .reduce((sum, m) => sum + (m.bytes as number), 0);
  }
}

export interface PendingFence {
  id: string;
  requestId: number;
}

/**
 * A pty-host stand-in: emits data chunks the way its port batcher posts them,
 * and answers snapshot fences the way its port handler does: the marker at
 * once, the snapshot after. With `holdFences` the test posts both itself, to
 * put output on either side of the marker.
 */
export class FakePtyHost extends FakePeer {
  holdFences = false;
  readonly pendingFences: PendingFence[] = [];

  constructor(
    private readonly snapshotFor: (id: string) => SerializedTerminalSnapshot | null = () => null
  ) {
    super();
    this.onReceive((message) => {
      if (message.type !== "serialize-fence") return;
      const fence = { id: message.id as string, requestId: message.requestId as number };
      if (this.holdFences) {
        this.pendingFences.push(fence);
        return;
      }
      this.postFenceMarker(fence);
      setTimeout(() => this.postSnapshot(fence), 0);
    });
  }

  emit(id: string, text: string): number {
    const data = new TextEncoder().encode(text);
    this.post({ type: "data", id, data, bytes: data.byteLength });
    return data.byteLength;
  }

  postFenceMarker(fence: PendingFence): void {
    this.post({ type: "serialize-fence", id: fence.id, requestId: fence.requestId });
  }

  postSnapshot(fence: PendingFence, state = this.snapshotFor(fence.id)): void {
    this.post({ type: "serialized-state", id: fence.id, requestId: fence.requestId, state });
  }
}

export function decode(message: Recorded): string {
  return new TextDecoder().decode(message.data as Uint8Array);
}
