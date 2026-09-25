import { EventEmitter } from "node:events";
import path from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { harnessState } from "./harnessState.js";

/**
 * The slice of Electron the Remote Hosts harness runs against. Everything else
 * (the link, the dispatcher, the host server, the stream bridges) is real.
 *
 * Imported by the test's `vi.mock("electron")` factory and by the harness
 * itself, so both see the same `ipcMain` handler table and open ports.
 */

type InvokeListener = (event: unknown, ...args: unknown[]) => unknown;

export const invokeHandlers = new Map<string, InvokeListener>();
/** `ipcMain.on` listeners: what a renderer's `ipcRenderer.send` reaches. */
export const sendListeners = new Map<string, Set<InvokeListener>>();
/** `protocol.handle` handlers by scheme. */
export const protocolHandlers = new Map<string, (request: Request) => Promise<Response>>();

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
  on: (channel: string, listener: InvokeListener) => {
    let listeners = sendListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      sendListeners.set(channel, listeners);
    }
    listeners.add(listener);
  },
  removeListener: (channel: string, listener: InvokeListener) => {
    sendListeners.get(channel)?.delete(listener);
  },
  removeAllListeners: (channel?: string) => {
    if (channel === undefined) sendListeners.clear();
    else sendListeners.delete(channel);
  },
  off: (channel: string, listener: InvokeListener) => {
    sendListeners.get(channel)?.delete(listener);
  },
};

export const ipcMainMock = { ...bareIpcMain };

/** Undo `enforceIpcSenderValidation`'s wrapping so wrappers never stack across tests. */
export function resetIpcMain(): void {
  Object.assign(ipcMainMock, bareIpcMain);
  invokeHandlers.clear();
  sendListeners.clear();
  protocolHandlers.clear();
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
    getPath: (name: string) =>
      name === "userData" ? harnessState.userDataDir : path.join(harnessState.userDataDir, name),
    getAppPath: () => harnessState.userDataDir,
    getName: () => "Daintree",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    isAsyncEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => "basic_text",
  },
  shell: {},
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
      protocolHandlers.set(scheme, handler);
    },
    unhandle: (scheme: string) => {
      protocolHandlers.delete(scheme);
    },
  },
  clipboard: {},
  ipcMain: ipcMainMock,
  session: { defaultSession: {}, fromPartition: () => ({}) },
  MessageChannelMain: FakeMessageChannelMain,
  BrowserWindow: class {},
  WebContentsView: class {},
  webContents: { fromId: () => undefined },
};
