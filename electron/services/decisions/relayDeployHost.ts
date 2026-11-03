import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DecisionsRelayDeployClaimState } from "../../../shared/types/decisions.js";
import type { RelayDeployPrefill } from "./relayDeployPrefill.js";

/**
 * Daintree's end of `decisions deploy --host-channel` (CLI 0.3.0, contract
 * version 1; daintreehq/decisions docs/self-host.md): the CLI connects and
 * says hello, Daintree answers with the prefilled answers, and when the
 * deploy ends the CLI sends its result, which Daintree confirms. Keys and the
 * claim secret cross only this socket. Nothing here logs a message, a prefill
 * or a result.
 */

export const HOST_CONTRACT_VERSION = 1;
/** The contract's own cap on one message, its newline not counted. */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** The CLI allows 15 s from starting to connect until the prefill arrives. */
const HELLO_TIMEOUT_MS = 15_000;
/**
 * How long the pane has to start the CLI: npx may first download it and
 * Wrangler, and the person may take a while to see the pane.
 */
const LAUNCH_TIMEOUT_MS = 15 * 60_000;
/** Under every platform's socket path limit (macOS: 104 bytes), as the contract asks. */
const MAX_SOCKET_PATH_BYTES = 100;
/** A path the pane's command carries unquoted, in any shell it might run. */
const SAFE_CHANNEL_PATH = /^[A-Za-z0-9._/-]+$/;
/** What the CLI bounds an error to; anything longer is cut, not refused. */
const MAX_ERROR_CHARS = 4096;
const MAX_URL_CHARS = 2048;
/** The relay's own bounds on a claim secret, as the claim form applies them. */
const MIN_CLAIM_SECRET = 16;
const MAX_CLAIM_SECRET = 256;

export interface RelayDeployResult {
  status: "completed" | "cancelled" | "failed";
  url: string | null;
  claimSecret: string | null;
  claimState: DecisionsRelayDeployClaimState;
  error?: string;
}

/** Why a channel ended with no result. */
export type RelayDeployInterruption =
  /** The CLI never connected before the launch window closed. */
  | "not-started"
  /** The CLI's hello was missing, late or not one this contract knows. */
  | "handshake"
  /** The CLI sent something the contract doesn't allow. */
  | "protocol"
  /** The connection closed before a result. */
  | "closed";

export interface RelayDeployHostEvents {
  /** Read when the CLI's hello arrives, so the keys leave the settings only then. */
  readPrefill: () => RelayDeployPrefill;
  /** The prefill went out: the person is answering the questions. */
  onRunning: () => void;
  /**
   * The CLI's result. Called before the receipt is sent, so whatever it keeps
   * is kept before the CLI is told it arrived.
   */
  onResult: (result: RelayDeployResult) => void;
  /** The channel ended with no result. Not called after `onResult` or `dispose`. */
  onInterrupted: (reason: RelayDeployInterruption) => void;
}

export interface RelayDeployHostOptions {
  platform?: NodeJS.Platform;
  /** Where the private directory for a Unix socket goes; the system temp folder by default. */
  tmpRoot?: string;
  launchTimeoutMs?: number;
  helloTimeoutMs?: number;
}

export interface RelayDeployHost {
  /** What the pane passes as `--host-channel`: no secret, and safe unquoted in any shell. */
  readonly channelPath: string;
  /** Stops listening, drops the connection and removes the socket. Idempotent. */
  dispose(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The CLI's hello, as contract version 1 says it: `{"v":1,"type":"hello",
 * "cli":"<version>","versions":[1, …]}`. A CLI that doesn't list version 1
 * can't read the prefill, so it gets none.
 */
export function isHello(message: unknown): boolean {
  return (
    isObject(message) &&
    message.type === "hello" &&
    message.v === HOST_CONTRACT_VERSION &&
    typeof message.cli === "string" &&
    Array.isArray(message.versions) &&
    message.versions.includes(HOST_CONTRACT_VERSION)
  );
}

function workerUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The CLI's result, or null for a message that isn't one. Fields a later
 * contract may add are ignored; a known field of the wrong shape refuses it.
 */
export function parseResult(message: unknown): RelayDeployResult | null {
  if (!isObject(message) || message.type !== "result" || message.v !== HOST_CONTRACT_VERSION) {
    return null;
  }
  const { status, claim_state: claimState, claim_secret: claimSecret, error } = message;
  if (status !== "completed" && status !== "cancelled" && status !== "failed") return null;
  if (claimState !== "claimed" && claimState !== "unclaimed" && claimState !== "unknown") {
    return null;
  }
  const url = workerUrl(message.url);
  if (url === undefined) return null;
  if (
    claimSecret !== null &&
    (typeof claimSecret !== "string" ||
      claimSecret.length < MIN_CLAIM_SECRET ||
      claimSecret.length > MAX_CLAIM_SECRET)
  ) {
    return null;
  }
  if (error !== undefined && typeof error !== "string") return null;
  return {
    status,
    url,
    claimSecret,
    claimState,
    ...(typeof error === "string" && error.trim() !== ""
      ? { error: error.trim().slice(0, MAX_ERROR_CHARS) }
      : {}),
  };
}

function frame(message: Record<string, unknown>): string {
  return `${JSON.stringify({ v: HOST_CONTRACT_VERSION, ...message })}\n`;
}

export interface RelayDeployEndpoint {
  /** Where the server listens. */
  listenPath: string;
  /** What the CLI is told: the same endpoint, spelled for a command line. */
  channelPath: string;
  /** The private directory to remove afterwards, on Unix. */
  directory: string | null;
}

/**
 * On Windows a named pipe with a random name. Node can't set its access list,
 * but the default one grants other non-admin users read access only, so they
 * can't write the hello that the prefill waits for. The CLI is given the
 * forward-slash spelling, which Win32 resolves to the same pipe and no shell
 * the pane might run rewrites. Elsewhere a Unix socket in a new directory
 * only this user can open.
 */
export async function relayDeployEndpoint(
  platform: NodeJS.Platform,
  tmpRoot: string
): Promise<RelayDeployEndpoint> {
  if (platform === "win32") {
    const name = `daintree-decisions-deploy-${randomBytes(16).toString("hex")}`;
    return { listenPath: `\\\\.\\pipe\\${name}`, channelPath: `//./pipe/${name}`, directory: null };
  }
  const roots = [tmpRoot, "/tmp"];
  for (const root of roots) {
    const probe = path.join(root, "daintree-deploy-XXXXXX", "host.sock");
    if (Buffer.byteLength(probe) > MAX_SOCKET_PATH_BYTES || !SAFE_CHANNEL_PATH.test(probe)) {
      continue;
    }
    const directory = await mkdtemp(path.join(root, "daintree-deploy-"));
    await chmod(directory, 0o700);
    const socketPath = path.join(directory, "host.sock");
    return { listenPath: socketPath, channelPath: socketPath, directory };
  }
  throw new Error("No temporary folder has a short enough path for the deploy's socket");
}

function listen(server: Server, listenPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(listenPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Listens for one guided deploy's CLI. Exactly one connection is taken; the
 * listener closes as it arrives and any other is dropped unanswered. The
 * prefill goes only in answer to a valid hello, and only once; after it the
 * person may take as long as they like, so nothing times the run out. A
 * result is handed to `onResult` before the receipt goes back.
 */
export async function openRelayDeployHost(
  events: RelayDeployHostEvents,
  options: RelayDeployHostOptions = {}
): Promise<RelayDeployHost> {
  const platform = options.platform ?? process.platform;
  const endpoint = await relayDeployEndpoint(platform, options.tmpRoot ?? os.tmpdir());
  let disposed = false;
  let settled = false;
  let accepted: Socket | null = null;
  let launchTimer: ReturnType<typeof setTimeout> | null = null;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;

  const removeEndpoint = () => {
    if (endpoint.directory !== null) {
      void rm(endpoint.directory, { recursive: true, force: true }).catch(() => {});
    }
  };

  const server = createServer({ allowHalfOpen: false });

  const close = () => {
    if (launchTimer) clearTimeout(launchTimer);
    if (helloTimer) clearTimeout(helloTimer);
    launchTimer = null;
    helloTimer = null;
    server.close();
    accepted?.destroy();
    removeEndpoint();
  };

  const interrupt = (reason: RelayDeployInterruption) => {
    if (settled || disposed) return;
    settled = true;
    close();
    events.onInterrupted(reason);
  };

  const serve = (socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let phase: "hello" | "running" | "done" = "hello";
    // `handle` moves the phase on, which a check of the variable itself can't see.
    const done = () => phase === "done";
    helloTimer = setTimeout(
      () => interrupt("handshake"),
      options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    );

    const handle = (message: unknown) => {
      if (phase === "hello") {
        if (!isHello(message)) return interrupt("handshake");
        if (helloTimer) clearTimeout(helloTimer);
        helloTimer = null;
        let answers: RelayDeployPrefill;
        try {
          answers = events.readPrefill();
        } catch {
          // Settings that can't be read prefill nothing; the person answers every step.
          answers = { keys: {} };
        }
        phase = "running";
        socket.write(frame({ type: "prefill", answers }));
        events.onRunning();
        return;
      }
      if (phase !== "running") return;
      const result = parseResult(message);
      if (!result) return interrupt("protocol");
      phase = "done";
      settled = true;
      events.onResult(result);
      socket.end(frame({ type: "received" }));
      if (launchTimer) clearTimeout(launchTimer);
      launchTimer = null;
      removeEndpoint();
    };

    socket.on("data", (chunk: Buffer) => {
      if (phase === "done") return;
      buffer = Buffer.concat([buffer, chunk]);
      for (let end = buffer.indexOf(10); end >= 0 && !done(); end = buffer.indexOf(10)) {
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        if (line.length > MAX_MESSAGE_BYTES) return interrupt("protocol");
        const text = line.toString("utf8").trim();
        if (text === "") continue;
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          return interrupt(phase === "hello" ? "handshake" : "protocol");
        }
        handle(message);
        if (settled && !done()) return;
      }
      if (buffer.length > MAX_MESSAGE_BYTES) interrupt("protocol");
    });
    socket.on("error", () => interrupt("closed"));
    socket.on("close", () => {
      if (phase !== "done") interrupt(phase === "hello" ? "handshake" : "closed");
    });
  };

  server.on("connection", (socket) => {
    if (accepted !== null || disposed || settled) {
      socket.destroy();
      return;
    }
    accepted = socket;
    if (launchTimer) clearTimeout(launchTimer);
    launchTimer = null;
    // The one connection is all this run takes: no second client can reach the socket.
    server.close();
    removeEndpoint();
    serve(socket);
  });

  // Nothing is awaited between listening and arming the launch timer, so no
  // connection can arrive in between; the socket's directory, only this user's,
  // is what keeps other users out of it.
  try {
    await listen(server, endpoint.listenPath);
  } catch (error) {
    disposed = true;
    close();
    throw error;
  }
  server.on("error", () => interrupt(accepted === null ? "not-started" : "closed"));
  launchTimer = setTimeout(
    () => interrupt("not-started"),
    options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS
  );

  return {
    channelPath: endpoint.channelPath,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      close();
    },
  };
}
