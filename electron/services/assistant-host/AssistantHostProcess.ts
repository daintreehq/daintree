import { utilityProcess, UtilityProcess } from "electron";
import type {
  AssistantHostCommand,
  AssistantHostEvent,
  AssistantHostSessionDescriptor,
} from "../../../shared/types/ipc/assistantHost.js";
import { parseAssistantHostEvent } from "../../schemas/ipc.js";

export interface AssistantHostProcessOptions {
  /** Absolute path to the package's `dist/host.js` (see `resolveHostEntry`). */
  hostEntry: string;
  /** Non-secret descriptor sent as the first `parentPort` message. */
  descriptor: AssistantHostSessionDescriptor;
  /**
   * Environment for the child. Secrets (`DAINTREE_MCP_URL` / `DAINTREE_MCP_TOKEN`
   * / `DAINTREE_WINDOW_ID`) and project context (`DAINTREE_PROJECT_ID`) travel
   * here, never in the descriptor — mirroring the CLI's env-only injection.
   */
  env: Record<string, string>;
  /** Working directory the runtime starts in (the bound worktree path). */
  cwd: string;
  /** Per-session service name for crash attribution. */
  serviceName: string;
  /** Every validated inbound host event, including `host:ready`. */
  onEvent: (event: AssistantHostEvent) => void;
  /** The child exited (cooperatively or via crash). */
  onExit?: (code: number) => void;
}

const READY_TIMEOUT_MS = 30_000;
const GRACEFUL_KILL_MS = 1_000;

/**
 * Owns one `utilityProcess.fork()` of the assistant's native-host entry and the
 * structured-message channel to it. Mirrors the `WorkspaceHostProcess` /
 * `PtyHostLifecycle` precedent: fork with a per-session `serviceName`, hand the
 * descriptor over `parentPort`, validate every inbound message against the
 * shared Zod schema before forwarding, and resolve a `waitForReady()` promise
 * on `host:ready`. The host entry lives in the external `daintree-assistant`
 * package; this wrapper does not assume anything about it beyond the protocol.
 */
export class AssistantHostProcess {
  private child: UtilityProcess | null = null;
  private readonly readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private disposed = false;

  constructor(private readonly opts: AssistantHostProcessOptions) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  start(): void {
    if (this.child || this.disposed) return;

    const child = utilityProcess.fork(this.opts.hostEntry, [], {
      serviceName: this.opts.serviceName,
      stdio: "pipe",
      cwd: this.opts.cwd,
      env: this.opts.env,
    });
    this.child = child;

    child.stdout?.on("data", (chunk) =>
      console.log(`[AssistantHost:${this.opts.serviceName}] ${String(chunk).trimEnd()}`)
    );
    child.stderr?.on("data", (chunk) =>
      console.warn(`[AssistantHost:${this.opts.serviceName}] ${String(chunk).trimEnd()}`)
    );

    child.on("spawn", () => {
      // The descriptor is the first message; the host validates it and replies
      // with `host:ready`. Secrets are already in `env`, not here.
      try {
        child.postMessage(this.opts.descriptor);
      } catch (error) {
        this.rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.on("message", (raw: unknown) => this.handleMessage(raw));

    child.on("exit", (code) => {
      this.child = null;
      this.clearReadyTimer();
      if (!this.settled) {
        this.rejectReady(new Error(`Assistant host exited before ready (code ${code}).`));
      }
      this.opts.onExit?.(code);
    });

    this.readyTimer = setTimeout(() => {
      this.rejectReady(new Error("Assistant host did not signal ready within 30s."));
      this.dispose();
    }, READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
  }

  /** Resolves when the host posts `host:ready`; rejects on early exit/timeout. */
  waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  /** Send a command to the host. Returns false if the child is gone. */
  send(command: AssistantHostCommand): boolean {
    if (!this.child) return false;
    try {
      this.child.postMessage(command);
      return true;
    } catch {
      return false;
    }
  }

  /** Cooperative shutdown then hard kill. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReadyTimer();
    const child = this.child;
    if (!child) return;
    try {
      child.postMessage({
        type: "shutdown",
        sessionId: this.opts.descriptor.sessionId,
      } satisfies AssistantHostCommand);
    } catch {
      // Already gone; fall through to the kill backstop.
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Nothing left to kill.
      }
    }, GRACEFUL_KILL_MS);
    killTimer.unref?.();
  }

  private handleMessage(raw: unknown): void {
    const event = parseAssistantHostEvent(raw);
    if (!event) {
      console.warn(`[AssistantHost:${this.opts.serviceName}] dropped an invalid host message.`);
      return;
    }
    if (event.type === "host:ready") {
      this.clearReadyTimer();
      this.resolveReady();
    }
    this.opts.onEvent(event);
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private resolveReady(): void {
    if (this.settled) return;
    this.settled = true;
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private rejectReady(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
  }
}
