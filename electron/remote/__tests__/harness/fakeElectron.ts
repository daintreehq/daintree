import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";

/**
 * The slice of Electron the Remote Hosts harness runs against. Everything else
 * (the link, the dispatcher, the host server, the stream bridges) is real.
 *
 * Imported by the test's `vi.mock("electron")` factory and by the harness
 * itself, so both see the same `ipcMain` handler table and open ports.
 */

type InvokeListener = (event: unknown, ...args: unknown[]) => unknown;

export const invokeHandlers = new Map<string, InvokeListener>();

const bareIpcMain = {
  handle: (channel: string, listener: InvokeListener) => {
    invokeHandlers.set(channel, listener);
  },
  handleOnce: (channel: string, listener: InvokeListener) => {
    invokeHandlers.set(channel, listener);
  },
  removeHandler: (channel: string) => {
    invokeHandlers.delete(channel);
  },
  on: () => undefined,
  removeListener: () => undefined,
  removeAllListeners: () => undefined,
  off: () => undefined,
};

export const ipcMainMock = { ...bareIpcMain };

/** Undo `enforceIpcSenderValidation`'s wrapping so wrappers never stack across tests. */
export function resetIpcMain(): void {
  Object.assign(ipcMainMock, bareIpcMain);
  invokeHandlers.clear();
}

const openPorts = new Set<FakeMessagePortMain>();

/**
 * `MessagePortMain` over a Node port: messages arrive wrapped in an event and
 * queue until `start()`, as they do in Electron's main process.
 */
export class FakeMessagePortMain extends EventEmitter {
  private started = false;
  private closed = false;

  constructor(private readonly port: MessagePort) {
    super();
    openPorts.add(this);
    port.once("close", () => {
      this.closed = true;
      openPorts.delete(this);
      this.emit("close");
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.port.postMessage(message);
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.port.on("message", (data: unknown) => this.emit("message", { data, ports: [] }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    openPorts.delete(this);
    this.port.close();
  }
}

export class FakeMessageChannelMain {
  readonly port1: FakeMessagePortMain;
  readonly port2: FakeMessagePortMain;

  constructor() {
    const { port1, port2 } = new MessageChannel();
    this.port1 = new FakeMessagePortMain(port1);
    this.port2 = new FakeMessagePortMain(port2);
  }
}

/** Close every port the test left open, so no handle keeps the worker alive. */
export function closeAllFakePorts(): void {
  for (const port of [...openPorts]) port.close();
}

export const electronMock = {
  app: {
    isPackaged: false,
    on: () => undefined,
    getVersion: () => "0.0.0-harness",
    getPath: () => "/nonexistent-harness-user-data",
  },
  ipcMain: ipcMainMock,
  session: { defaultSession: {}, fromPartition: () => ({}) },
  MessageChannelMain: FakeMessageChannelMain,
  BrowserWindow: class {},
  WebContentsView: class {},
  webContents: { fromId: () => undefined },
};
