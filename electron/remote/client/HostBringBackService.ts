import {
  HOST_BRING_BACK_OBSERVED_MAX,
  type HostBringBackAnswer,
  type HostBringBackStatus,
  type HostWakeResult,
  type HostWakeSetup,
} from "../../../shared/types/hostWake.js";
import {
  isLocalHostId,
  type HostConnectionState,
  type HostDescriptor,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import type { HostStartRefusal } from "./HostSetupService.js";
import type { HostStartEvent } from "./hostStarts.js";
import type { WakeRoute } from "./wakeOnLan.js";

/**
 * How long one attempt waits for the host: a wake, ssh coming up after it,
 * and Daintree's start there (which waits up to a minute to listen).
 */
export const BRING_BACK_DEADLINE_MS = 120_000;
/** How often a link waiting out its backoff is told to try now, during an attempt. */
export const BRING_BACK_NUDGE_MS = 5_000;

export interface HostBringBackDeps {
  host(hostId: HostId): HostDescriptor | null;
  linkState(hostId: HostId): HostConnectionState;
  onLinkState(listener: (hostId: HostId, state: HostConnectionState) => void): () => void;
  /** A person's Retry: abandons a dial under way, checks startability afresh and dials now. */
  redial(hostId: HostId): void;
  /** Dial now instead of waiting out the backoff; a dial under way is left alone. */
  nudge(hostId: HostId): void;
  /** Keeps the host's connection open until the release. */
  hold(hostId: HostId): () => void;
  /** Lets a dial start Daintree there until the release (see `HostStarts.allowExplicit`). */
  allowStart(hostId: HostId): () => void;
  observeStarts(hostId: HostId, listener: (event: HostStartEvent) => void): () => void;
  wakeRoute(setup: HostWakeSetup): WakeRoute;
  sendWake(
    mac: string,
    route: Extract<WakeRoute, { kind: "route" }>,
    signal: AbortSignal
  ): Promise<void>;
  now?: () => number;
  deadlineMs?: number;
  nudgeMs?: number;
}

const REFUSALS: Record<HostStartRefusal, string | null> = {
  unreached: null,
  "not-installed": "ssh got in; Daintree isn't installed there.",
  "host-mode-off": "ssh got in; Daintree isn't running there and its Host mode isn't on.",
  quit: "ssh got in; Daintree was quit there.",
  held: "ssh got in; Daintree there couldn't be started a moment ago.",
  busy: "Daintree is being installed there, or the host changed, from this machine.",
};

function clip(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > HOST_BRING_BACK_OBSERVED_MAX
    ? `${trimmed.slice(0, HOST_BRING_BACK_OBSERVED_MAX - 1)}…`
    : trimmed;
}

function linkUp(state: HostConnectionState): boolean {
  return state.status === "connected" || state.status === "driven-elsewhere";
}

/**
 * Brings back a paired host whose link is down (#16170), for the person (the
 * host's row) and this machine's assistants (`host.bringBack`) alike: one
 * attempt per host, which every later caller joins until it answers. It
 * sends the host's wake first when one is set up and this machine is on its
 * LAN, then dials it as a person's Retry does, letting that dial start
 * Daintree there in Host mode where Host mode is on. It answers with what it
 * observed once the link is up, can't come up by waiting, or the deadline
 * passes. It never changes the host's settings or turns Host mode on.
 */
export class HostBringBackService {
  private readonly attempts = new Map<HostId, Promise<HostBringBackAnswer>>();
  private readonly cancels = new Set<() => void>();
  private disposed = false;

  constructor(private readonly deps: HostBringBackDeps) {}

  /** The attempt under way for the host, joined, or a new one. */
  bringBack(hostId: HostId): Promise<HostBringBackAnswer> {
    const running = this.attempts.get(hostId);
    if (running) return running;
    if (isLocalHostId(hostId)) {
      throw new AppError({
        code: "VALIDATION",
        message: "This machine isn't a host to bring back",
        userMessage: "This machine isn't a host to bring back.",
      });
    }
    const descriptor = this.deps.host(hostId);
    if (!descriptor) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id ${hostId}`,
        userMessage: "That host isn't in your host list.",
      });
    }
    if (this.disposed) {
      throw new AppError({ code: "UNAVAILABLE", message: "Remote Hosts is stopping" });
    }
    const attempt = this.run(descriptor);
    this.attempts.set(hostId, attempt);
    void attempt.finally(() => {
      if (this.attempts.get(hostId) === attempt) this.attempts.delete(hostId);
    });
    return attempt;
  }

  /** Whether an attempt for the host is under way. */
  isBringingBack(hostId: HostId): boolean {
    return this.attempts.has(hostId);
  }

  /** Ends every attempt as cancelled and refuses new ones. */
  dispose(): void {
    this.disposed = true;
    for (const cancel of [...this.cancels]) cancel();
  }

  private run(descriptor: HostDescriptor): Promise<HostBringBackAnswer> {
    const deps = this.deps;
    const now = deps.now ?? Date.now;
    const hostId = descriptor.id;
    const startedAt = now();
    const ssh = descriptor.connection.kind === "ssh";
    let wake: HostWakeResult = "not_needed";
    let reached = false;
    let startRequested = false;
    let started = false;
    let observed: string | null = null;
    let dialing = false;
    let settled = false;
    const abort = new AbortController();
    const cleanups: Array<() => void> = [];

    return new Promise<HostBringBackAnswer>((resolve) => {
      const finish = (status: HostBringBackStatus): void => {
        if (settled) return;
        settled = true;
        abort.abort();
        for (const cleanup of cleanups.splice(0).reverse()) {
          try {
            cleanup();
          } catch (error) {
            console.error("[HostBringBack] Cleanup failed:", error);
          }
        }
        resolve({
          status,
          wake,
          reached,
          startRequested,
          observed: clip(observed),
          elapsedMs: Math.max(0, now() - startedAt),
        });
      };
      const cancel = () => finish("cancelled");
      this.cancels.add(cancel);
      cleanups.push(() => this.cancels.delete(cancel));

      if (linkUp(deps.linkState(hostId))) {
        reached = true;
        finish("connected");
        return;
      }
      const deadline = setTimeout(() => finish("timed_out"), deps.deadlineMs ?? BRING_BACK_DEADLINE_MS);
      cleanups.push(() => clearTimeout(deadline));
      cleanups.push(deps.hold(hostId));
      cleanups.push(deps.allowStart(hostId));

      const onLink = (state: HostConnectionState): void => {
        if (settled) return;
        switch (state.status) {
          case "connected":
          case "driven-elsewhere":
            reached = true;
            finish(started ? "started" : wake === "sent" ? "woken" : "connected");
            return;
          case "connecting":
            dialing = true;
            return;
          case "version-mismatch":
            if (!dialing) return;
            reached = true;
            finish("version_mismatch");
            return;
          case "disconnected":
            // Disconnected, removed or re-pointed while being brought back.
            if (dialing) finish("cancelled");
            return;
          case "unreachable":
            if (!dialing) return;
            if (state.detail) observed = state.detail;
            if (state.hostModeOff === true) {
              reached = true;
              if (state.stoppedRetrying === true) finish("not_startable");
              return;
            }
            if (state.stoppedRetrying === true) {
              finish("unreachable");
              return;
            }
            // Nothing more to try: no wake went, and the dial didn't get in.
            if (!reached && wake !== "sent") finish(ssh ? "not_wakeable" : "unreachable");
            return;
          case "local":
            return;
        }
      };

      const onStart = (event: HostStartEvent): void => {
        if (settled) return;
        switch (event.kind) {
          case "checking":
            reached = true;
            return;
          case "start-requested":
            startRequested = true;
            return;
          case "running":
            if (event.started) started = true;
            return;
          case "refused": {
            const text = REFUSALS[event.refusal];
            if (text === null) return;
            observed = text;
            finish("not_startable");
            return;
          }
          case "failed":
            observed = event.reason;
            finish("not_startable");
            return;
        }
      };

      const dial = (): void => {
        if (settled) return;
        if (!deps.host(hostId)) {
          finish("cancelled");
          return;
        }
        cleanups.push(deps.onLinkState((id, state) => id === hostId && onLink(state)));
        cleanups.push(deps.observeStarts(hostId, onStart));
        try {
          deps.redial(hostId);
        } catch {
          finish("cancelled");
          return;
        }
        const state = deps.linkState(hostId);
        // A dial always reports connecting first; anything else means none started.
        if (state.status !== "connecting" && !linkUp(state)) {
          finish("cancelled");
          return;
        }
        onLink(state);
        if (settled) return;
        const nudge = setInterval(() => {
          const current = deps.linkState(hostId);
          if (current.status === "unreachable" && current.stoppedRetrying !== true) {
            deps.nudge(hostId);
          }
        }, deps.nudgeMs ?? BRING_BACK_NUDGE_MS);
        cleanups.push(() => clearInterval(nudge));
      };

      const setup = ssh ? descriptor.wake : undefined;
      if (!ssh) {
        dial();
        return;
      }
      if (!setup) {
        wake = "not_set_up";
        dial();
        return;
      }
      const route = deps.wakeRoute(setup);
      if (route.kind === "not_on_lan") {
        wake = "not_on_lan";
        dial();
        return;
      }
      void deps.sendWake(setup.mac, route, abort.signal).then(
        () => {
          wake = "sent";
          dial();
        },
        (error: unknown) => {
          if (settled) return;
          wake = "failed";
          observed = formatErrorMessage(error, "The wake couldn't be sent");
          dial();
        }
      );
    });
  }
}
