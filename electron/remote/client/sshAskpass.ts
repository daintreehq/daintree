import net from "node:net";

/**
 * ssh's SSH_ASKPASS during a Remote Hosts sign-in, and the wire between it
 * and the Daintree that started that ssh (`SshSignInService`).
 *
 * ssh runs its askpass program once per prompt, with the prompt as its only
 * argument and the answer read from its stdout. Daintree's is a small
 * launcher script that starts this build with `--ssh-askpass`, which
 * connects to the sign-in's own socket, sends the prompt with the sign-in's
 * token, and prints whatever answer comes back. It stores nothing and decides
 * nothing: the main process chooses which prompts reach a person at all.
 *
 * The prompt travels in an environment variable, never on the command line:
 * a server writes keyboard-interactive prompts, and one shaped like a
 * Chromium switch would otherwise be read as one by the helper's own launch.
 *
 * Only pure Node here: the helper process loads this and nothing else of
 * Remote Hosts.
 */

/** The sign-in's socket, set on the ssh it starts and so inherited by its askpass. */
export const ASKPASS_SOCKET_ENV = "DAINTREE_ASKPASS_SOCKET";
/** The sign-in's one-time token, so only its own askpass is heard on the socket. */
export const ASKPASS_TOKEN_ENV = "DAINTREE_ASKPASS_TOKEN";
/** The prompt ssh passed the launcher, handed on to the helper. */
export const ASKPASS_PROMPT_ENV = "DAINTREE_ASKPASS_PROMPT";

/** Longest line either side reads: a prompt is a sentence or two, an answer a passphrase. */
export const ASKPASS_MAX_LINE_BYTES = 64 * 1024;

/** One prompt, as the helper sends it: `SSH_ASKPASS_PROMPT` is the hint (`none`, `confirm`, or empty). */
export interface AskpassRequest {
  token: string;
  prompt: string;
  hint: string;
}

/** The main process's reply: the text to give ssh, or a refusal (the helper exits non-zero). */
export type AskpassReply = { answer: string } | { refuse: true };

/**
 * Calls back once with the first newline-terminated line on `socket`, or
 * null when the socket ends, errors or sends more than `maxBytes` first.
 */
export function readOneLine(
  socket: net.Socket,
  maxBytes: number,
  onLine: (line: string | null) => void
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  const finish = (line: string | null) => {
    if (done) return;
    done = true;
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("close", onEnd);
    socket.off("error", onEnd);
    onLine(line);
  };
  const onData = (chunk: Buffer) => {
    const newline = chunk.indexOf(0x0a);
    const take = newline === -1 ? chunk : chunk.subarray(0, newline);
    size += take.byteLength;
    if (size > maxBytes) {
      finish(null);
      return;
    }
    chunks.push(take);
    if (newline !== -1) finish(Buffer.concat(chunks).toString("utf8"));
  };
  const onEnd = () => finish(null);
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  socket.once("error", onEnd);
}

export function parseAskpassReply(line: string | null): AskpassReply | null {
  if (line === null) return null;
  try {
    const value = JSON.parse(line) as { answer?: unknown; refuse?: unknown } | null;
    if (typeof value?.answer === "string") return { answer: value.answer };
    if (value?.refuse === true) return { refuse: true };
  } catch {
    // Not a reply this helper understands: treated as a refusal.
  }
  return null;
}

export interface AskpassClient {
  /** The helper's exit status: 0 once an answer was printed, 1 otherwise. */
  done: Promise<number>;
  /** ssh is done with this prompt (it sends SIGTERM once a security key is touched): let go of it. */
  stop(): void;
}

/**
 * Ask the sign-in for one answer. A notice (`hint` none) is never answered:
 * the helper holds its connection until ssh stops it, and the connection
 * closing is how the notice comes down.
 */
export function runAskpassClient(options: {
  socketPath: string;
  token: string;
  prompt: string;
  hint: string;
  /** Prints the answer for ssh, resolving once it was handed to stdout. */
  writeAnswer: (answer: string) => Promise<void>;
  connect?: (socketPath: string) => net.Socket;
}): AskpassClient {
  const socket = (options.connect ?? ((socketPath) => net.connect({ path: socketPath })))(
    options.socketPath
  );
  // Every outcome is read from the line or the close; an error is one of those.
  socket.on("error", () => {});
  let stopped = false;
  const done = new Promise<number>((resolve) => {
    socket.once("connect", () => {
      const request: AskpassRequest = {
        token: options.token,
        prompt: options.prompt,
        hint: options.hint,
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    readOneLine(socket, ASKPASS_MAX_LINE_BYTES, (line) => {
      const reply = stopped ? null : parseAskpassReply(line);
      socket.destroy();
      if (!reply || "refuse" in reply) {
        resolve(1);
        return;
      }
      options.writeAnswer(reply.answer).then(
        () => resolve(0),
        () => resolve(1)
      );
    });
  });
  return {
    done,
    stop() {
      stopped = true;
      socket.destroy();
    },
  };
}
