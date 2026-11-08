/**
 * What a booting view is still waiting on in main (#16401).
 *
 * The cold-start skeleton's stuck card appears when hydration hasn't finished
 * after six seconds, and hydration is almost entirely invokes into main. So the
 * record of where startup stopped is the set of invokes this view has open:
 * channel, age, and for the boot payload the step its handler is awaiting.
 * Channel names and step labels are fixed identifiers; no arguments or results
 * are kept.
 *
 * A session spans one document's startup: it opens at the `app:boot` every
 * document sends while its entry graph evaluates, and closes at that view's
 * first-interactive. A reload's `app:boot` replaces the old session, so an
 * invoke the previous document left open settles against a session nothing
 * reads any more. Sessions of views destroyed mid-startup are pruned on the
 * next session start rather than through a `destroyed` listener per view.
 * Outside a session the wrapper is one map lookup.
 */

import { CHANNELS } from "./channels.js";

const MAX_REPORTED_INVOKES = 20;

/** The handlers whose awaits {@link markStartupStep} labels. */
const BOOT_PAYLOAD_CHANNELS = new Set<string>([CHANNELS.APP_BOOT, CHANNELS.APP_HYDRATE]);

interface TrackedSender {
  readonly id: number;
  isDestroyed?(): boolean;
}

interface PendingInvoke {
  channel: string;
  startedAt: number;
  step?: string;
}

interface StartupSession {
  sender: TrackedSender;
  /** When this document's `app:boot` arrived; null when it never did. */
  bootAt: number | null;
  pending: Set<PendingInvoke>;
  reported: boolean;
}

export interface StartupWaitSnapshot {
  /** Whether this document ever asked for its boot payload. */
  bootRequested: boolean;
  sinceBootMs: number | null;
  pendingCount: number;
  /** Oldest first, capped at {@link MAX_REPORTED_INVOKES}. */
  pending: Array<{ channel: string; pendingMs: number; step?: string }>;
}

const sessions = new Map<number, StartupSession>();

function pruneDestroyed(): void {
  for (const [id, session] of sessions) {
    if (session.sender.isDestroyed?.() === true) sessions.delete(id);
  }
}

function openSession(sender: TrackedSender, bootAt: number | null): StartupSession {
  pruneDestroyed();
  const session: StartupSession = { sender, bootAt, pending: new Set(), reported: false };
  sessions.set(sender.id, session);
  return session;
}

/**
 * Run an invoke handler, recording it as open while its sender is starting up.
 * The handler's own result (value, rejection or synchronous throw) passes
 * through untouched.
 */
export function trackStartupInvoke(
  sender: TrackedSender | undefined,
  channel: string,
  run: () => unknown
): unknown {
  if (!sender || typeof sender.id !== "number") return run();
  let session = sessions.get(sender.id);
  if (channel === CHANNELS.APP_BOOT) session = openSession(sender, Date.now());
  if (!session) return run();

  const entry: PendingInvoke = { channel, startedAt: Date.now() };
  const owner = session;
  owner.pending.add(entry);
  const settle = (): void => {
    owner.pending.delete(entry);
  };

  let result: unknown;
  try {
    result = run();
  } catch (error) {
    settle();
    throw error;
  }
  if (result instanceof Promise) {
    result.then(settle, settle);
  } else {
    settle();
  }
  return result;
}

/** Label the step a starting view's boot payload handler is now awaiting. */
export function markStartupStep(webContentsId: number | undefined, step: string): void {
  if (webContentsId === undefined) return;
  const session = sessions.get(webContentsId);
  if (!session) return;
  for (const entry of session.pending) {
    if (BOOT_PAYLOAD_CHANNELS.has(entry.channel)) entry.step = step;
  }
}

/** The view reached first-interactive: its startup is over. */
export function endStartupTracking(webContentsId: number): void {
  sessions.delete(webContentsId);
}

/**
 * Snapshot what the view is still waiting on, once per document. Returns null
 * when this document already reported, so a renderer cannot fill the log.
 * `excludeChannel` keeps the reporting invoke itself out of the list.
 */
export function claimStartupWaitSnapshot(
  sender: TrackedSender,
  excludeChannel: string
): StartupWaitSnapshot | null {
  const session = sessions.get(sender.id) ?? openSession(sender, null);
  if (session.reported) return null;
  session.reported = true;

  const now = Date.now();
  const open = [...session.pending]
    .filter((entry) => entry.channel !== excludeChannel)
    .sort((a, b) => a.startedAt - b.startedAt);
  return {
    bootRequested: session.bootAt !== null,
    sinceBootMs: session.bootAt === null ? null : now - session.bootAt,
    pendingCount: open.length,
    pending: open.slice(0, MAX_REPORTED_INVOKES).map((entry) => ({
      channel: entry.channel,
      pendingMs: now - entry.startedAt,
      ...(entry.step ? { step: entry.step } : {}),
    })),
  };
}

export function _resetStartupInvokeTrackerForTesting(): void {
  sessions.clear();
}
