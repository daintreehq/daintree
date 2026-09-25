import { MessageChannel, type MessagePort } from "node:worker_threads";
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

/** A pty-host stand-in: emits data chunks the way its port batcher posts them. */
export class FakePtyHost extends FakePeer {
  emit(id: string, text: string): number {
    const data = new TextEncoder().encode(text);
    this.post({ type: "data", id, data, bytes: data.byteLength });
    return data.byteLength;
  }
}

export function decode(message: Recorded): string {
  return new TextDecoder().decode(message.data as Uint8Array);
}
