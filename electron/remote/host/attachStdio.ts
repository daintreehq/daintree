import net from "node:net";
import type { Readable, Writable } from "node:stream";
import { readDiscoveryFile } from "./discoveryFile.js";

/**
 * The stdio attach bridge: `daintree --attach-stdio` run on a host pipes its
 * stdin and stdout, byte for byte, to that host's own Unix socket, so any
 * command that can run a program there and carry its stdio (`ssh <target>
 * <cmd>` when the server refuses socket forwarding, later `wsl.exe -d <distro>
 * -- <cmd>`) can carry a link. It never starts a backend: it reads the running
 * host's discovery file, connects to the socket it names, and says which
 * token that host expects in one preamble line before the first link byte.
 *
 * Pure Node (no Electron) so the CLI mode and the tests share it.
 */

export { ATTACH_STDIO_FLAG } from "../../boot/hostModeLaunch.js";

/** Exit codes: 0 once either side closed; the rest say what was observed. */
export const ATTACH_EXIT = {
  ok: 0,
  noHost: 2,
  connectFailed: 3,
} as const;

const PREAMBLE_PREFIX = "daintree-attach 1 ";
const TOKEN = /^[0-9a-f]{64}$/;
/** After our side ends, how long the host gets to close before the socket is dropped. */
const END_GRACE_MS = 2_000;

export function formatAttachPreamble(token: string): string {
  return `${PREAMBLE_PREFIX}${token}\n`;
}

/** The token from a preamble line (without its newline); null for any other line. */
export function parseAttachPreamble(line: string): string | null {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!text.startsWith(PREAMBLE_PREFIX)) return null;
  const token = text.slice(PREAMBLE_PREFIX.length);
  return TOKEN.test(token) ? token : null;
}

export interface AttachStdioOptions {
  /** The host's discovery file (host.json next to its socket). */
  discoveryPath: string;
  input: Readable;
  output: Writable;
  /** Where failures are written, in words; the link never sees them. */
  errorOutput?: Writable;
  connect?: (socketPath: string) => net.Socket;
  endGraceMs?: number;
}

function connectOnce(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      socket.off("connect", onConnect);
      reject(err);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/**
 * Run the bridge until either side closes. Resolves to the process exit code;
 * never throws.
 */
export async function runAttachStdioBridge(options: AttachStdioOptions): Promise<number> {
  const say = (line: string) => options.errorOutput?.write(`${line}\n`);
  const info = await readDiscoveryFile(options.discoveryPath);
  if (!info) {
    say(`daintree: no host is listening here (no discovery file at ${options.discoveryPath})`);
    return ATTACH_EXIT.noHost;
  }
  const socket = (options.connect ?? ((p: string) => net.connect(p)))(info.socketPath);
  try {
    await connectOnce(socket);
  } catch (err) {
    socket.destroy();
    say(`daintree: could not connect to ${info.socketPath}: ${(err as Error).message}`);
    return ATTACH_EXIT.connectFailed;
  }

  const { input, output } = options;
  return new Promise<number>((resolve) => {
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      input.unpipe(socket);
      input.pause();
      socket.unpipe(output);
      socket.destroy();
      // What the host sent is written before the process is let go; a reader
      // that is already gone has nothing left to flush.
      const settle = () => resolve(ATTACH_EXIT.ok);
      if (output.destroyed || output.writableFinished) {
        settle();
        return;
      }
      output.once("finish", settle);
      output.once("close", settle);
      output.once("error", settle);
      output.end();
    };
    socket.on("error", () => {});
    socket.once("close", finish);
    input.once("error", finish);
    output.once("error", finish);
    // Our side closed: tell the host, and give it a moment to close in turn.
    input.once("end", () => {
      graceTimer = setTimeout(finish, options.endGraceMs ?? END_GRACE_MS);
      graceTimer.unref?.();
    });
    input.once("close", () => {
      if (!input.readableEnded && !done) finish();
    });

    output.write(formatAttachPreamble(info.token));
    // pipe() carries backpressure both ways: a slow reader pauses the writer.
    socket.pipe(output, { end: false });
    input.pipe(socket);
  });
}
