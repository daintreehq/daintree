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
 * document sends while its entry graph evaluates, and closes when the view
 * reports it hydrated or reached first-interactive. A reload's `app:boot`
 * replaces the old session, so an invoke the previous document left open
 * settles against a session nothing reads any more. Views that never report
 * either (the Canopy window, surface hosts) stop recording new invokes once
 * the session is past {@link TRACKING_WINDOW_MS}. Sessions of views destroyed
 * mid-startup are pruned on the next session start rather than through a
 * `destroyed` listener per view. Outside a session the wrapper is one map
 * lookup.
 */

import { CHANNELS } from "./channels.js";

const MAX_REPORTED_INVOKES = 20;

/**
 * How long after `app:boot` new invokes are still recorded. A stuck view's card
 * reports at six seconds, or when a hidden view is first shown; the invokes it
 * opened early stay listed either way.
 */
const TRACKING_WINDOW_MS = 2 * 60_000;

/** The handlers whose awaits {@link startupStepper} labels. */
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
  /** Whether this document asked for its boot payload. */
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
 * Run an invoke, recording it as open while its sender is starting up. The
 * invoke's own result (value, rejection or synchronous throw) passes through
 * untouched.
 */
export function trackStartupInvoke(
  sender: TrackedSender | undefined,
  channel: string,
  run: () => unknown
): unknown {
  if (!sender || typeof sender.id !== "number") return run();
  const now = Date.now();
  let session = sessions.get(sender.id);
  if (channel === CHANNELS.APP_BOOT) session = openSession(sender, now);
  if (!session) return run();
  if (session.bootAt !== null && now - session.bootAt > TRACKING_WINDOW_MS) return run();

  const entry: PendingInvoke = { channel, startedAt: now };
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

/**
 * A labeller for the boot payload invoke now running for this view, captured
 * when its handler starts (synchronously inside the invoke, so it is the
 * newest such entry). Labels land on that invoke alone, so a previous
 * document's hydration resuming late never relabels the current one's.
 */
export function startupStepper(webContentsId: number | undefined): (step: string) => void {
  if (webContentsId === undefined) return () => {};
  const session = sessions.get(webContentsId);
  let current: PendingInvoke | undefined;
  for (const entry of session?.pending ?? []) {
    if (BOOT_PAYLOAD_CHANNELS.has(entry.channel)) current = entry;
  }
  if (!current) return () => {};
  const entry = current;
  return (step) => {
    entry.step = step;
  };
}

/** The view hydrated or reached first-interactive: its startup is over. */
export function endStartupTracking(webContentsId: number): void {
  sessions.delete(webContentsId);
}

/**
 * Snapshot what the view is still waiting on, once per document. Returns null
 * when this document already reported, so a renderer cannot fill the log.
 * `excludeChannel` keeps the reporting invoke itself out of the list.
 *
 * `documentBooted` is the renderer's word on whether this document sent
 * `app:boot`. When it didn't, a session that did belongs to an earlier
 * document on the same view (a reload whose entry graph never ran), and its
 * invokes and its report are not this document's.
 */
export function claimStartupWaitSnapshot(
  sender: TrackedSender,
  excludeChannel: string,
  documentBooted: boolean
): StartupWaitSnapshot | null {
  let session = sessions.get(sender.id);
  if (!session || (!documentBooted && session.bootAt !== null)) {
    session = openSession(sender, null);
  }
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
