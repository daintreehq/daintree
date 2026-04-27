import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { EventEmitter } from "events";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * A fake UtilityProcess-shaped object whose IPC is backed by a real
 * worker_threads.MessageChannel. Forwarding postMessage/kill through a real
 * Worker exercises the same V8 structured-clone path that
 * `process.parentPort` uses inside an Electron utility process — the host
 * code already casts `process.parentPort as unknown as MessagePort` from
 * "node:worker_threads", so the serialization semantics match.
 *
 * Known coverage gap: worker_threads does NOT populate `event.ports` on the
 * receiver side when ports are passed via `transferList`. The production
 * pty-host/workspace-host code reads `rawMsg?.ports || []` to extract
 * transferred ports — that path only fires inside Electron's
 * MessagePortMain, not in worker_threads. So tests using this harness can
 * verify the SOURCE-side call shape (port lives in the transferList second
 * arg, not the message body) but cannot verify the receiver actually unwraps
 * the port. End-to-end port-receipt coverage requires a real Electron
 * runtime and lives outside this contract test tier.
 */
export interface FakeUtilityChild extends EventEmitter {
  postMessage: (msg: unknown, transferList?: ReadonlyArray<unknown>) => void;
  kill: (signal?: string | number) => boolean;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
}

export interface StubHostHandle {
  /** Fake UtilityProcess for injecting into utilityProcess.fork() mocks. */
  fakeChild: FakeUtilityChild;
  /** Underlying worker — terminate() to simulate abrupt host death. */
  worker: Worker;
  /**
   * Test-side port for boundary tests that bypass clients. Touching this
   * (attaching a listener) starts the port and drains any queued messages
   * — do not use it when the fakeChild is also being consumed by a client,
   * or messages will be split between the two listeners.
   */
  testPort: MessagePort;
  /** Cleanup all resources (worker, ports, listeners). */
  dispose: () => Promise<void>;
}

/**
 * Resolve a worker script path relative to this helpers directory.
 */
export function helperPath(filename: string): string {
  return path.resolve(__dirname, filename);
}

/**
 * Spawn a stub host backed by a real worker_threads.Worker. The returned
 * `fakeChild` delegates all postMessage/kill calls through a real
 * MessageChannel, so the client under test exercises the actual V8
 * serialization boundary, real port transfer/neutering, and real
 * worker exit signaling.
 */
export function spawnStubHost(workerScriptPath: string): StubHostHandle {
  const channel = new MessageChannel();
  const worker = new Worker(workerScriptPath, {
    workerData: { port: channel.port2 },
    transferList: [channel.port2],
  });
  const fakeChild = createFakeChild(worker, channel.port1);

  let disposed = false;
  return {
    fakeChild,
    worker,
    testPort: channel.port1,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        channel.port1.close();
      } catch {
        /* ignore */
      }
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
    },
  };
}

function createFakeChild(worker: Worker, port: MessagePort): FakeUtilityChild {
  const emitter = new EventEmitter() as FakeUtilityChild;
  emitter.stdout = new Readable({ read() {} });
  emitter.stderr = new Readable({ read() {} });
  // Leave pid undefined so PtyClient/WorkspaceHostProcess watchdog paths
  // skip process.kill() — workers don't have OS-level pids reachable from
  // kill(2), and we don't want to send a real signal from a test.
  emitter.pid = undefined;

  emitter.postMessage = (msg, transferList) => {
    try {
      port.postMessage(msg, transferList as Parameters<typeof port.postMessage>[1] | undefined);
    } catch (err) {
      emitter.emit("error", err);
    }
  };

  emitter.kill = () => {
    void worker.terminate();
    return true;
  };

  // Defer the port-side listener attachment until the consumer attaches its
  // first "message" listener on the fake child. MessagePort buffers messages
  // while paused; attaching the listener implicitly calls start() and drains
  // the queue asynchronously — guaranteeing the consumer's handler is
  // registered before queued messages are delivered. Without this, a worker
  // that posts "ready" during startup would race the consumer's listener
  // attachment and the message would be silently dropped.
  let portStarted = false;
  emitter.on("newListener", (event) => {
    if (event === "message" && !portStarted) {
      portStarted = true;
      port.on("message", (msg) => emitter.emit("message", msg));
    }
  });

  worker.on("exit", (code) => {
    try {
      emitter.stdout.push(null);
    } catch {
      /* already closed */
    }
    try {
      emitter.stderr.push(null);
    } catch {
      /* already closed */
    }
    emitter.emit("exit", code);
  });

  worker.on("error", (err) => {
    emitter.emit("error", err);
  });

  return emitter;
}

/**
 * Wait for the first message on `child` matching `predicate`, or reject after
 * `timeoutMs`. Used to assert real round-trips through the worker port.
 */
export function waitForChildMessage<T = unknown>(
  child: EventEmitter,
  predicate: (msg: unknown) => boolean,
  timeoutMs: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for matching message`));
    }, timeoutMs);
    function onMessage(msg: unknown) {
      if (predicate(msg)) {
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(msg as T);
      }
    }
    child.on("message", onMessage);
  });
}

/**
 * Wait for the first message on a raw worker_threads MessagePort matching
 * `predicate`, or reject after `timeoutMs`. Use for direct boundary tests
 * that bypass the FakeUtilityChild abstraction.
 */
export function waitForPortMessage<T = unknown>(
  port: MessagePort,
  predicate: (msg: unknown) => boolean,
  timeoutMs: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.off("message", onMessage);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for matching port message`));
    }, timeoutMs);
    function onMessage(msg: unknown) {
      if (predicate(msg)) {
        clearTimeout(timer);
        port.off("message", onMessage);
        resolve(msg as T);
      }
    }
    port.on("message", onMessage);
  });
}
