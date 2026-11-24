import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import type { WebContents } from "electron";
import type { HostConnection } from "../../../shared/types/remoteHosts.js";
import type {
  AnswerSshSignInPayload,
  CancelSshSignInPayload,
  SshSignInEvent,
  SshSignInPromptKind,
  SshSignInResult,
  StartSshSignInPayload,
} from "../../../shared/types/ipc/remoteHosts.js";
import { displaySafeText } from "../../../shared/utils/displaySafeText.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { sshRefusalAdvice, sshRefusalLine } from "../../../shared/utils/sshRefusal.js";
import { HEADLESS_OZONE_SWITCH, SSH_ASKPASS_FLAG } from "../../boot/hostModeLaunch.js";
import { CHANNELS } from "../../ipc/channels.js";
import { sendToWebContents } from "../../ipc/utils.js";
import { AppError } from "../../utils/errorTypes.js";
import { maxSocketPathBytes } from "../host/hostSocketPath.js";
import type { CommandResult, CommandRunner } from "./commandRunner.js";
import {
  requireHostConnection,
  requireSshTarget,
  requireSupportedConnection,
} from "./connection.js";
import {
  ASKPASS_MAX_LINE_BYTES,
  ASKPASS_PROMPT_ENV,
  ASKPASS_SOCKET_ENV,
  ASKPASS_TOKEN_ENV,
  readOneLine,
  type AskpassReply,
  type AskpassRequest,
} from "./sshAskpass.js";
import { sshExecutable } from "./sshExecutable.js";
import {
  BATCH_SSH_ENV,
  buildExitArgs,
  buildProbeArgs,
  buildSignInArgs,
  controlPathFor,
  hiddenHopRefusal,
  isProxyClosedEarly,
  noteSshMaster,
  shellQuote,
  SSH_COMMAND_TIMEOUT_MS,
  utf8TailStart,
} from "./sshTransport.js";

/**
 * A person's Sign in to an ssh host that refused a batch login (#17322).
 *
 * Every other ssh call Daintree makes runs with BatchMode=yes and rides one
 * ControlMaster per host, so only the ssh that starts that master ever needs
 * a prompt. This runs that one ssh, and only on a person's click: a batch
 * attempt first (a host that lets ssh in without asking never meets the
 * helper), then, only if ssh said `Permission denied`, the probe again with
 * BatchMode off and SSH_ASKPASS set to Daintree's own helper. Each prompt ssh
 * asks is shown to the view that clicked, as ssh wrote it; what the person
 * types is handed to ssh once and kept nowhere. Host-key questions and yes/no
 * permission questions are refused without being shown: by the time ssh says
 * `Permission denied` the host key has passed, and nothing here ever accepts
 * one. The master the sign-in leaves is the one every later call rides,
 * still in batch mode, until ControlPersist lets it go.
 *
 * There is no deadline while the person is answering: Cancel, the view
 * closing or reloading, or the server's own login grace ends it.
 */

/** How long a helper that connected has to say what it wants. */
const REQUEST_DEADLINE_MS = 10_000;
/** How long ssh gets after SIGTERM before it, and whatever it started, is killed. */
const KILL_GRACE_MS = 2_000;
const MAX_PROMPT_CHARS = 4_000;
/** ssh reads at most 1,023 bytes of askpass output, the newline included, and drops the rest. */
const MAX_ANSWER_BYTES = 1_022;
const MAX_STDERR_BYTES = 8 * 1024;
const ATTEMPT_ID = /^[A-Za-z0-9-]{8,64}$/;
const RELAY_DIR_PREFIX = "ap-";
/** ssh's own exit status when it fails, rather than the remote command's. */
const SSH_FAILED = 255;

/**
 * OpenSSH's host-key questions as it words them (sshconnect.c's confirm() and
 * clientloop.c's UpdateHostKeys): `The authenticity of host '…' can't be
 * established`, `Are you sure you want to continue connecting (yes/no…)?`,
 * `Please type 'yes'…`, `Accept updated hostkeys? (yes/no)`, and any other
 * question that ends asking yes or no.
 */
const HOST_KEY_QUESTION =
  /^The authenticity of host '|Are you sure you want to continue connecting \(yes\/no|^Please type 'yes'|^Accept updated hostkeys\?|\(yes\/no[^)]*\)\s*[?:]?\s*$/im;

/**
 * What to do with one askpass request. `SSH_ASKPASS_PROMPT=none` is a notice
 * (a security key's "Confirm user presence"), ended by ssh itself; any other
 * hint (`confirm`) asks permission, which a sign-in never grants.
 */
export function classifyAskpassPrompt(
  prompt: string,
  hint: string
): SshSignInPromptKind | "refuse" {
  if (HOST_KEY_QUESTION.test(prompt)) return "refuse";
  if (hint === "none") return "notice";
  if (hint !== "") return "refuse";
  return "secret";
}

/** ssh's prompt, line breaks kept, made safe to show: a server writes keyboard-interactive prompts. */
export function displayPrompt(prompt: string): string {
  const text = prompt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => displaySafeText(line).trimEnd())
    .join("\n")
    .trim();
  // The question comes last: a long preamble (a PAM banner, a device list) gives way first.
  return text.length > MAX_PROMPT_CHARS ? `…${text.slice(-(MAX_PROMPT_CHARS - 1))}` : text;
}

/**
 * The SSH_ASKPASS ssh runs: this build with `--ssh-askpass`, the prompt moved
 * from its argument into the environment so nothing a server wrote is ever
 * read as a switch. On Linux the helper runs Chromium headless: it never
 * shows anything.
 */
export function askpassLauncherScript(
  helperCommand: readonly string[],
  platform: NodeJS.Platform
): string {
  const argv = [
    ...helperCommand,
    ...(platform === "linux" ? [HEADLESS_OZONE_SWITCH, "--disable-gpu"] : []),
    SSH_ASKPASS_FLAG,
  ];
  return [
    "#!/bin/sh",
    "unset ELECTRON_RUN_AS_NODE",
    `${ASKPASS_PROMPT_ENV}=\${1-}`,
    `export ${ASKPASS_PROMPT_ENV}`,
    `exec ${argv.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

/** The view a sign-in's prompts go to, and the only one that may answer or cancel them. */
export interface SignInOwner {
  readonly id: number;
  send(event: SshSignInEvent): void;
  /** Calls back once the view can no longer answer (closed, crashed, reloaded); returns an unsubscribe. */
  onGone(listener: () => void): () => void;
}

export function signInOwnerFor(webContents: WebContents): SignInOwner {
  return {
    id: webContents.id,
    send: (event) => {
      sendToWebContents(webContents, CHANNELS.REMOTE_HOSTS_SSH_SIGN_IN_EVENT, event);
    },
    onGone(listener) {
      if (webContents.isDestroyed()) {
        queueMicrotask(listener);
        return () => {};
      }
      const gone = () => listener();
      webContents.once("destroyed", gone);
      webContents.on("render-process-gone", gone);
      // A reload drops the dialog that would have answered.
      webContents.on("did-navigate", gone);
      return () => {
        webContents.off("destroyed", gone);
        webContents.off("render-process-gone", gone);
        webContents.off("did-navigate", gone);
      };
    },
  };
}

export interface SignInChild {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SignInSpawner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => SignInChild;

/**
 * Its own process group (and session, so no terminal ssh could ask on
 * instead), so Cancel reaches a ProxyJump's ssh and the askpass helpers too.
 */
const defaultSpawner: SignInSpawner = (command, args, env) =>
  nodeSpawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env,
    windowsHide: true,
  }) as SignInChild;

export interface SshSignInDeps {
  /** The Remote Hosts client folder (0700) that holds the control sockets. */
  clientDir: string;
  run: CommandRunner;
  /** The argv that runs this build: its executable, plus the app folder when unpackaged. */
  helperCommand: () => string[];
  spawn?: SignInSpawner;
  sshPath?: () => string;
  platform?: NodeJS.Platform;
  /** The host is being removed or re-pointed: no sign-in to its old address starts. */
  isRetiring?: (connection: HostConnection) => boolean;
}

interface PendingPrompt {
  socket: net.Socket;
  kind: SshSignInPromptKind;
}

interface Attempt {
  readonly id: string;
  readonly ownerId: number;
  readonly target: string;
  readonly abort: AbortController;
  readonly prompts: Map<string, PendingPrompt>;
}

interface Relay {
  socketPath: string;
  launcherPath: string;
  token: string;
  close(): Promise<void>;
}

function requireAttemptId(value: unknown): string {
  if (typeof value === "string" && ATTEMPT_ID.test(value)) return value;
  throw new AppError({ code: "VALIDATION", message: "attemptId must be a short id" });
}

function parseRequest(line: string | null): AskpassRequest | null {
  if (line === null) return null;
  try {
    const value = JSON.parse(line) as Partial<AskpassRequest> | null;
    if (
      typeof value?.token === "string" &&
      typeof value.prompt === "string" &&
      typeof value.hint === "string"
    ) {
      return { token: value.token, prompt: value.prompt, hint: value.hint };
    }
  } catch {
    // Not a request: the connection is dropped.
  }
  return null;
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
}

function reply(socket: net.Socket, answer: AskpassReply): void {
  socket.end(`${JSON.stringify(answer)}\n`);
}

function killGroup(child: SignInChild, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Not a group leader (a test double), or already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function collectTail(stream: Readable | null, cap: number): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buf);
    size += buf.byteLength;
    while (size > cap && chunks.length > 1) {
      const excess = size - cap;
      const oldest = chunks[0]!;
      if (oldest.byteLength <= excess) {
        chunks.shift();
        size -= oldest.byteLength;
      } else {
        chunks[0] = oldest.subarray(excess);
        size -= excess;
      }
    }
  });
  return () => {
    const all = Buffer.concat(chunks);
    return all.subarray(utf8TailStart(all, cap)).toString("utf8");
  };
}

function batchFailure(result: CommandResult): string | null {
  if (result.spawnError) return `Couldn't run ssh: ${result.spawnError}`;
  return sshRefusalLine(result.stderr) ?? (result.timedOut ? "ssh didn't finish in time" : null);
}

export class SshSignInService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly running = new Set<Promise<SshSignInResult>>();
  private disposed = false;
  private swept: Promise<void> | null = null;

  constructor(private readonly deps: SshSignInDeps) {}

  /** {@link start} for the view that asked over IPC. */
  startFromView(view: WebContents, payload: unknown): Promise<SshSignInResult> {
    return this.start(signInOwnerFor(view), payload);
  }

  /** Runs one sign-in to its end; prompts reach `owner` as events while it runs. */
  async start(owner: SignInOwner, payload: unknown): Promise<SshSignInResult> {
    const raw = payload as Partial<StartSshSignInPayload> | null;
    const attemptId = requireAttemptId(raw?.attemptId);
    const connection = requireSupportedConnection(
      requireHostConnection(raw?.connection),
      this.platform()
    );
    const target = requireSshTarget(connection, "Signing in");
    if (this.disposed) return { status: "cancelled" };
    if (this.deps.isRetiring?.(connection)) {
      const message = `${target} is being removed or changed on this device. Try again once that finishes.`;
      throw new AppError({ code: "VALIDATION", message, userMessage: message });
    }
    if (this.attempts.has(attemptId)) {
      throw new AppError({ code: "VALIDATION", message: "That sign-in is already running" });
    }
    for (const other of this.attempts.values()) {
      if (other.target !== target) continue;
      const message = `A sign-in to ${target} is already open.`;
      throw new AppError({ code: "VALIDATION", message, userMessage: message });
    }
    const attempt: Attempt = {
      id: attemptId,
      ownerId: owner.id,
      target,
      abort: new AbortController(),
      prompts: new Map(),
    };
    this.attempts.set(attemptId, attempt);
    const offGone = owner.onGone(() => attempt.abort.abort());
    const run = this.run(attempt, owner).catch((error: unknown): SshSignInResult =>
      attempt.abort.signal.aborted
        ? { status: "cancelled" }
        : { status: "failed", detail: formatErrorMessage(error, "The sign-in couldn't start") }
    );
    this.running.add(run);
    try {
      return await run;
    } finally {
      this.running.delete(run);
      offGone();
      this.attempts.delete(attemptId);
    }
  }

  /** Hand ssh what the person typed for one prompt. False when that prompt is no longer waiting. */
  answer(ownerId: number, payload: unknown): boolean {
    const raw = payload as Partial<AnswerSshSignInPayload> | null;
    const attempt = this.ownedAttempt(ownerId, raw?.attemptId);
    const promptId = raw?.promptId;
    const prompt = attempt && typeof promptId === "string" ? attempt.prompts.get(promptId) : null;
    if (!attempt || !prompt || prompt.kind !== "secret") return false;
    const answer = raw?.answer;
    // Never echoed: the value is someone's passphrase.
    if (
      typeof answer !== "string" ||
      Buffer.byteLength(answer) > MAX_ANSWER_BYTES ||
      /[\r\n\0]/.test(answer)
    ) {
      throw new AppError({
        code: "VALIDATION",
        message: "Not an answer ssh can take",
        userMessage: `ssh takes one line here, up to ${MAX_ANSWER_BYTES} bytes.`,
      });
    }
    attempt.prompts.delete(promptId as string);
    reply(prompt.socket, { answer });
    return true;
  }

  cancel(ownerId: number, payload: unknown): boolean {
    const attempt = this.ownedAttempt(
      ownerId,
      (payload as Partial<CancelSshSignInPayload> | null)?.attemptId
    );
    if (!attempt) return false;
    attempt.abort.abort();
    return true;
  }

  /** The host is being removed or re-pointed: a sign-in to its old target stops. */
  cancelTarget(target: string): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.target === target) attempt.abort.abort();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const attempt of this.attempts.values()) attempt.abort.abort();
    await Promise.allSettled([...this.running]);
  }

  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private ownedAttempt(ownerId: number, attemptId: unknown): Attempt | null {
    const attempt = typeof attemptId === "string" ? this.attempts.get(attemptId) : undefined;
    return attempt && attempt.ownerId === ownerId ? attempt : null;
  }

  private async run(attempt: Attempt, owner: SignInOwner): Promise<SshSignInResult> {
    const { clientDir } = this.deps;
    const signal = attempt.abort.signal;
    const sshPath = (this.deps.sshPath ?? sshExecutable)();
    await fs.mkdir(clientDir, { recursive: true, mode: 0o700 });
    await fs.chmod(clientDir, 0o700);
    const controlPath = controlPathFor(clientDir, attempt.target, this.platform());
    const exitMaster = (timeoutMs: number) =>
      this.deps.run(sshPath, buildExitArgs(attempt.target, controlPath), { timeoutMs }).then(
        () => undefined,
        () => undefined
      );
    // Either call may leave a master behind; quitting closes it with the rest.
    noteSshMaster(attempt.target, controlPath, exitMaster);

    const batch = await this.deps.run(sshPath, buildProbeArgs(attempt.target, controlPath), {
      timeoutMs: SSH_COMMAND_TIMEOUT_MS,
      signal,
      env: BATCH_SSH_ENV,
    });
    if (signal.aborted) return { status: "cancelled" };
    if (batch.code === 0) return { status: "signed-in" };
    // ssh itself failing (255) with its authentication refusal: a command
    // there that prints "Permission denied" after a login doesn't count.
    let refused = batch.code === SSH_FAILED && sshRefusalAdvice(batch.stderr) === "login-refused";
    let detail = batchFailure(batch);
    if (!refused && batch.code === SSH_FAILED && isProxyClosedEarly(batch.stderr)) {
      const hop = await hiddenHopRefusal(this.deps.run, sshPath, attempt.target, signal);
      if (signal.aborted) return { status: "cancelled" };
      if (hop !== null) {
        refused = sshRefusalAdvice(hop) === "login-refused";
        detail = sshRefusalLine(hop);
      }
    }
    if (!refused) return { status: "failed", detail };

    // Cancel stops ssh and touches no master: one that is up by then may be
    // another caller's (a dial that rode an agent unlocked meanwhile), and a
    // login that finished as Cancel landed stays, like any, for ControlPersist.
    const relay = await this.openRelay(attempt, owner);
    try {
      return await this.runInteractive(attempt, relay, sshPath, controlPath);
    } finally {
      await relay.close();
    }
  }

  /** Relay folders a launch that crashed mid sign-in left behind: none is in use before this one. */
  private sweepLeftovers(): Promise<void> {
    const { clientDir } = this.deps;
    this.swept ??= fs
      .readdir(clientDir)
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(RELAY_DIR_PREFIX))
            .map((name) => fs.rm(path.join(clientDir, name), { recursive: true, force: true }))
        )
      )
      .then(
        () => undefined,
        () => undefined
      );
    return this.swept;
  }

  private async openRelay(attempt: Attempt, owner: SignInOwner): Promise<Relay> {
    const platform = this.platform();
    await this.sweepLeftovers();
    const dir = await fs.mkdtemp(path.join(this.deps.clientDir, RELAY_DIR_PREFIX));
    const socketPath = path.join(dir, "s");
    const launcherPath = path.join(dir, "askpass");
    const token = crypto.randomBytes(32).toString("hex");
    const sockets = new Set<net.Socket>();
    let server: net.Server | null = null;
    let closing = false;
    const close = async () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const listening = server;
      if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    try {
      if (Buffer.byteLength(socketPath) > maxSocketPathBytes(platform)) {
        throw new Error(`The sign-in's socket path is too long: ${socketPath}`);
      }
      await fs.writeFile(launcherPath, askpassLauncherScript(this.deps.helperCommand(), platform), {
        mode: 0o700,
      });
      const created = net.createServer((socket) => {
        if (closing) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        this.accept(attempt, owner, token, socket);
      });
      server = created;
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(socketPath, () => {
          created.off("error", reject);
          resolve();
        });
      });
      created.on("error", () => {});
      return { socketPath, launcherPath, token, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  /** One askpass helper: one prompt, answered, refused or held until ssh lets it go. */
  private accept(attempt: Attempt, owner: SignInOwner, token: string, socket: net.Socket): void {
    socket.on("error", () => {});
    const deadline = setTimeout(() => socket.destroy(), REQUEST_DEADLINE_MS);
    readOneLine(socket, ASKPASS_MAX_LINE_BYTES, (line) => {
      clearTimeout(deadline);
      const request = parseRequest(line);
      if (!request || !tokenMatches(request.token, token) || attempt.abort.signal.aborted) {
        socket.destroy();
        return;
      }
      const kind = classifyAskpassPrompt(request.prompt, request.hint);
      if (kind === "refuse") {
        reply(socket, { refuse: true });
        return;
      }
      const promptId = crypto.randomUUID();
      attempt.prompts.set(promptId, { socket, kind });
      socket.once("close", () => {
        if (attempt.prompts.get(promptId)?.socket !== socket) return;
        attempt.prompts.delete(promptId);
        owner.send({ type: "prompt-closed", attemptId: attempt.id, promptId });
      });
      owner.send({
        type: "prompt",
        attemptId: attempt.id,
        promptId,
        kind,
        text: displayPrompt(request.prompt),
      });
    });
  }

  private runInteractive(
    attempt: Attempt,
    relay: Relay,
    sshPath: string,
    controlPath: string
  ): Promise<SshSignInResult> {
    const signal = attempt.abort.signal;
    if (signal.aborted) return Promise.resolve({ status: "cancelled" });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SSH_ASKPASS: relay.launcherPath,
      SSH_ASKPASS_REQUIRE: "force",
      [ASKPASS_SOCKET_ENV]: relay.socketPath,
      [ASKPASS_TOKEN_ENV]: relay.token,
    };
    // ssh sets the hint itself for each prompt that has one; an inherited one would mislabel the rest.
    delete env[ASKPASS_PROMPT_ENV];
    delete env.SSH_ASKPASS_PROMPT;
    return new Promise((resolve) => {
      let child: SignInChild;
      try {
        child = (this.deps.spawn ?? defaultSpawner)(
          sshPath,
          buildSignInArgs(attempt.target, controlPath),
          env
        );
      } catch (error) {
        resolve({ status: "failed", detail: `Couldn't run ssh: ${formatErrorMessage(error, "")}` });
        return;
      }
      child.stdout?.resume();
      const stderr = collectTail(child.stderr, MAX_STDERR_BYTES);
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: SshSignInResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        // ssh is gone; anything it started that outlived its SIGTERM (a ProxyJump's ssh) goes now.
        if (signal.aborted) killGroup(child, "SIGKILL");
        resolve(result);
      };
      const onAbort = () => {
        killGroup(child, "SIGTERM");
        killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) =>
        finish(
          signal.aborted
            ? { status: "cancelled" }
            : { status: "failed", detail: `Couldn't run ssh: ${error.message}` }
        )
      );
      child.on("exit", (code) => {
        // Let the last of stderr land before reading it.
        setImmediate(() => {
          if (signal.aborted) finish({ status: "cancelled" });
          else if (code === 0) finish({ status: "signed-in" });
          else finish({ status: "failed", detail: sshRefusalLine(stderr()) });
        });
      });
    });
  }
}
