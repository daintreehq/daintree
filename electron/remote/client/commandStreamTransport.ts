import { Duplex, type Readable, type Writable } from "node:stream";
import { parseAttachPreamble } from "../host/attachStdio.js";
import { TransportError, type LinkTransport, type LinkTransportConnection } from "./transport.js";

/**
 * A link carried over a command's stdio: the command reaches a host's
 * `--attach-stdio` bridge (`ssh <target> -- <daintree> --attach-stdio` today;
 * `wsl.exe -d <distro> -- …` is the same shape), which says which token the
 * host expects in one preamble line and then carries the link byte for byte.
 * Lines before the preamble (a chatty shell startup file on stdout) are
 * skipped; failures come back as the command's own stderr.
 */

export interface StreamCommandChild {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CommandStreamTransportOptions {
  /** How long the command gets to print its preamble. */
  preambleTimeoutMs?: number;
  /** Most bytes read looking for the preamble before giving up. */
  maxPreambleBytes?: number;
}

const DEFAULT_PREAMBLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PREAMBLE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
/** After the link lets go, how long the command gets to exit before it is stopped. */
const KILL_GRACE_MS = 2_000;

/**
 * The child's stdout (read) and stdin (write) as one stream. Writes go
 * through one at a time and complete when the child's stdin took them, so this
 * stream's own high-water mark is the backpressure the link sees; reads pause
 * the child's stdout whenever the consumer stops pulling. Destroying it closes
 * the child's stdin and stops the child if it hasn't exited shortly after; the
 * child's stdout ending ends it.
 */
export class ChildStdioDuplex extends Duplex {
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private exited = false;

  constructor(
    private readonly child: StreamCommandChild,
    initial: Buffer | null
  ) {
    super({ allowHalfOpen: false });
    if (!child.stdin || !child.stdout) throw new Error("The command's stdio must be piped");
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    if (initial && initial.byteLength > 0) this.push(initial);
    this.stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) this.stdout.pause();
    });
    this.stdout.once("end", () => this.push(null));
    this.stdout.once("error", (err) => this.destroy(err));
    this.stdin.on("error", (err) => this.destroy(err));
    this.child.on("exit", () => {
      this.exited = true;
      // Output already read still reaches the consumer; stdout's end follows.
      if (this.stdout.readableEnded) this.destroy();
    });
    this.stdout.resume();
  }

  override _read(): void {
    this.stdout.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error) => void) {
    if (this.stdin.destroyed) {
      callback(new Error("The command's stdin is closed"));
      return;
    }
    this.stdin.write(chunk, (err) => callback(err ?? undefined));
  }

  override _final(callback: (err?: Error) => void): void {
    this.stdin.end(() => callback());
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    // Closing stdin lets the command end on its own (the bridge closes its
    // side of the host socket and exits); anything still running after a
    // grace period is stopped.
    this.stdout.removeAllListeners("data");
    this.stdout.resume();
    if (!this.exited) {
      this.stdin.end();
      const timer = setTimeout(() => {
        if (!this.exited) this.child.kill("SIGTERM");
      }, KILL_GRACE_MS);
      timer.unref?.();
    }
    callback(err);
  }
}

function collectTail(stream: Readable | null, cap: number): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buf);
    size += buf.byteLength;
    while (size > cap && chunks.length > 1) size -= chunks.shift()!.byteLength;
  });
  return () => {
    const all = Buffer.concat(chunks);
    return all
      .subarray(Math.max(0, all.byteLength - cap))
      .toString("utf8")
      .trim();
  };
}

/**
 * Read stdout line by line until the preamble; resolve with the token and the
 * bytes already read past it (the start of the link).
 */
function readPreamble(
  child: StreamCommandChild,
  stderr: () => string,
  signal: AbortSignal,
  options: Required<CommandStreamTransportOptions>
): Promise<{ token: string; rest: Buffer }> {
  const stdout = child.stdout!;
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let scanned = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      child.stdout?.pause();
      fn();
    };
    const fail = (message: string, fallback: string | null) =>
      finish(() => reject(new TransportError(message, stderr() || fallback)));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffered.subarray(0, newline).toString("utf8");
        const rest = buffered.subarray(newline + 1);
        const token = parseAttachPreamble(line);
        if (token) {
          finish(() => resolve({ token, rest: Buffer.from(rest) }));
          return;
        }
        scanned += newline + 1;
        buffered = rest;
      }
      if (scanned + buffered.byteLength > options.maxPreambleBytes) {
        fail("The host's attach bridge didn't answer as expected", null);
      }
    };
    const onEnd = () => {
      // Let the exit code and stderr land before reading them.
      setImmediate(() => fail("The host's attach bridge closed before it started", null));
    };
    const onAbort = () => finish(() => reject(new TransportError("Connection cancelled", null)));
    const timer = setTimeout(
      () =>
        fail(
          "The host's attach bridge did not start in time",
          `no answer after ${options.preambleTimeoutMs} ms`
        ),
      options.preambleTimeoutMs
    );
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) =>
      finish(() => reject(new TransportError("Could not run the attach command", err.message)))
    );
    stdout.on("data", onData);
    stdout.once("end", onEnd);
  });
}

/**
 * Run `spawn()` for each connection attempt and use its stdio as the link.
 * The child must have stdin, stdout and stderr piped.
 */
export function createCommandStreamTransport(
  spawn: () => StreamCommandChild,
  options: CommandStreamTransportOptions = {}
): LinkTransport {
  const resolved: Required<CommandStreamTransportOptions> = {
    preambleTimeoutMs: options.preambleTimeoutMs ?? DEFAULT_PREAMBLE_TIMEOUT_MS,
    maxPreambleBytes: options.maxPreambleBytes ?? DEFAULT_MAX_PREAMBLE_BYTES,
  };
  return {
    async open(signal): Promise<LinkTransportConnection> {
      if (signal.aborted) throw new TransportError("Connection cancelled", null);
      let child: StreamCommandChild;
      try {
        child = spawn();
      } catch (err) {
        throw new TransportError("Could not run the attach command", (err as Error).message);
      }
      if (!child.stdin || !child.stdout) {
        child.kill("SIGTERM");
        throw new TransportError("The attach command's stdio isn't piped", null);
      }
      const stderr = collectTail(child.stderr, MAX_STDERR_BYTES);
      // A write to a child that already exited must not crash the process.
      child.stdin.on("error", () => {});
      let preamble: { token: string; rest: Buffer };
      try {
        preamble = await readPreamble(child, stderr, signal, resolved);
      } catch (err) {
        child.kill("SIGTERM");
        throw err;
      }
      const socket = new ChildStdioDuplex(child, preamble.rest);
      return {
        socket,
        token: preamble.token,
        dispose: async () => {
          socket.destroy();
        },
      };
    },
  };
}
