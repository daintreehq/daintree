import { EventEmitter } from "node:events";
import type { FakeMessagePortMain } from "./fakeElectron.js";

export type PortMessage = Record<string, unknown> & { type: string };

interface Waiter {
  match: (message: PortMessage) => boolean;
  resolve: (message: PortMessage) => void;
}

/**
 * A project view on the Shell: its `WebContents` (which receives the relayed
 * terminal port through the same token handshake `portDistribution` uses) and
 * the renderer's end of that port, which acks output the way the renderer's
 * terminal client does once it has written it.
 */
export class FakeView {
  readonly webContents: EventEmitter & {
    id: number;
    isDestroyed(): boolean;
    postMessage(channel: string, message: unknown, transfer?: unknown[]): void;
    send(channel: string, ...args: unknown[]): void;
  };
  /** Every message the renderer's terminal port received, in order. */
  readonly messages: PortMessage[] = [];
  /** Pushed events (channel + args) the Shell delivered to this view. */
  readonly events: Array<{ channel: string; args: unknown[] }> = [];
  readonly resyncs: string[] = [];
  readonly tokens: string[] = [];
  portsReceived = 0;
  autoAck = true;

  private port: FakeMessagePortMain | null = null;
  private destroyed = false;
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<(message: PortMessage) => void>();
  private readonly decoder = new TextDecoder();

  constructor(readonly id: number) {
    const emitter = new EventEmitter() as FakeView["webContents"];
    emitter.id = id;
    emitter.isDestroyed = () => this.destroyed;
    emitter.postMessage = (channel, message, transfer) => {
      if (channel === "terminal-port-token") {
        this.tokens.push((message as { token: string }).token);
      } else if (channel === "terminal-port") {
        const token = (message as { token: string }).token;
        if (this.tokens.at(-1) !== token) throw new Error("terminal port without its token");
        this.adopt(transfer![0] as FakeMessagePortMain);
      }
    };
    emitter.send = (channel, ...args) => {
      this.events.push({ channel, args });
    };
    this.webContents = emitter;
  }

  get hasPort(): boolean {
    return this.port !== null && !this.port.isClosed;
  }

  write(id: string, data: string): void {
    this.post({ type: "write", id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.post({ type: "resize", id, cols, rows });
  }

  ack(id: string, bytes: number): void {
    this.post({ type: "ack", id, bytes });
  }

  dataFrames(id: string): PortMessage[] {
    return this.messages.filter((m) => m.type === "data" && m.id === id);
  }

  /** Output for `id` as the renderer painted it, in arrival order. */
  text(id: string): string {
    return this.dataFrames(id)
      .map((m) => this.decoder.decode(m.data as Uint8Array))
      .join("");
  }

  resets(id: string): PortMessage[] {
    return this.messages.filter((m) => m.type === "reset" && m.id === id);
  }

  onMessage(listener: (message: PortMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves on the first message from now on that matches. */
  nextMessage(match: (message: PortMessage) => boolean, timeoutMs = 10_000): Promise<PortMessage> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`view ${this.id}: no matching port message within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.port?.close();
    this.webContents.emit("destroyed");
  }

  private post(message: PortMessage): void {
    if (!this.port) throw new Error(`view ${this.id} has no terminal port`);
    this.port.postMessage(message);
  }

  private adopt(port: FakeMessagePortMain): void {
    this.port?.close();
    this.port = port;
    this.portsReceived++;
    port.on("message", (event: { data: unknown }) => {
      if (this.port === port) this.receive(event.data as PortMessage);
    });
    port.start();
  }

  private receive(message: PortMessage): void {
    this.messages.push(message);
    if (this.autoAck && message.type === "data") {
      this.ack(message.id as string, message.bytes as number);
    }
    for (const listener of [...this.listeners]) listener(message);
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(message)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }
}

/** The Shell's live views by WebContents id, as `webContentsRegistry` would resolve them. */
export const liveViews = new Map<number, FakeView>();
/** Each view's host-scoped project key (`toHostScopedKey`). */
export const projectKeys = new Map<number, string>();
