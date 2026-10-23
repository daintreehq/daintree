import type { CanopyMode, CanopySnapshot } from "@shared/types/ipc/canopy";
import type { HostId } from "@shared/types/remoteHosts";

export type BulkEnableOutcome =
  | "enabled"
  | "already-enabled"
  | "unsupported"
  | "inaccessible"
  | "refused"
  | "conflicted"
  | "uncertain";

/** A host named in the disclosure, frozen when the person opened it. */
export interface BulkTarget {
  hostId: HostId;
  name: string;
}

/** The last state of a host's mode this run saw: what a later attempt must still find. */
export interface BulkSeen {
  hostEpoch: string;
  modeRevision: number;
}

export interface BulkResult {
  hostId: HostId;
  name: string;
  outcome: BulkEnableOutcome;
  detail: string;
  seen: BulkSeen | null;
}

/** What the run asks of one host's Canopy, and nothing else. */
export interface BulkTransport {
  getSnapshot(): Promise<CanopySnapshot>;
  setMode(
    mode: CanopyMode,
    expectRevision: number,
    expectHostEpoch: string
  ): Promise<CanopySnapshot>;
  /** Dials the host if it isn't up; false when it still isn't. Absent for the window's own host. */
  connect?(): Promise<boolean>;
  /** Hands back whatever the run opened on the host. Called once the target is done. */
  release(): void;
}

export interface BulkEnableDeps {
  transportFor(target: BulkTarget): BulkTransport;
  concurrency?: number;
  signal?: AbortSignal;
}

/** Outcomes a person can retry: nothing was decided against the host's own state. */
const RETRYABLE: ReadonlySet<BulkEnableOutcome> = new Set(["inaccessible", "uncertain", "refused"]);

export function isRetryable(result: BulkResult): boolean {
  return RETRYABLE.has(result.outcome);
}

export function isSettled(result: BulkResult): boolean {
  return result.outcome === "enabled" || result.outcome === "already-enabled";
}

const DEFAULT_CONCURRENCY = 3;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function done(
  target: BulkTarget,
  outcome: BulkEnableOutcome,
  detail: string,
  seen: BulkSeen | null
): BulkResult {
  return { hostId: target.hostId, name: target.name, outcome, detail, seen };
}

function seenOf(snapshot: CanopySnapshot): BulkSeen | null {
  return snapshot.hostEpoch !== undefined && snapshot.modeRevision !== undefined
    ? { hostEpoch: snapshot.hostEpoch, modeRevision: snapshot.modeRevision }
    : null;
}

/** A read, dialling the host once if it isn't up. Null when it can't be read. */
async function read(transport: BulkTransport): Promise<CanopySnapshot | null> {
  try {
    return await transport.getSnapshot();
  } catch {
    if (!transport.connect) return null;
  }
  try {
    if (!(await transport.connect())) return null;
    return await transport.getSnapshot();
  } catch {
    return null;
  }
}

async function enableOne(
  target: BulkTarget,
  transport: BulkTransport,
  before: BulkSeen | null,
  signal: AbortSignal | undefined
): Promise<BulkResult> {
  const first = await read(transport);
  if (!first) return done(target, "inaccessible", "Couldn't reach this host.", before);
  if (first.mode === "on") return done(target, "already-enabled", "Already on.", seenOf(first));

  const seen = seenOf(first);
  if (!seen) {
    return done(
      target,
      "unsupported",
      "This host's Daintree is too old to turn Canopy on from here.",
      null
    );
  }
  // An earlier attempt left this host in a state it didn't explain: only the
  // same host process at the same revision is still the state it was left in.
  if (before) {
    if (before.hostEpoch !== seen.hostEpoch) {
      return done(target, "conflicted", "The host restarted since. Left unchanged.", seen);
    }
    if (before.modeRevision !== seen.modeRevision) {
      return done(target, "conflicted", "Canopy was changed there since. Left unchanged.", seen);
    }
  }

  const steps: CanopyMode[] = first.mode === "hidden" ? ["unset", "on"] : ["on"];
  let revision = seen.modeRevision;
  let lastSeen = seen;
  for (const step of steps) {
    if (signal?.aborted) {
      return done(target, "uncertain", "Stopped before this host was finished.", lastSeen);
    }
    let reply: CanopySnapshot;
    try {
      reply = await transport.setMode(step, revision, seen.hostEpoch);
    } catch (error) {
      if (errorCode(error) === "PERMISSION") {
        return done(target, "refused", "The host wouldn't turn Canopy on.", lastSeen);
      }
      // No reply is not a verdict: the host's own state says whether it landed.
      const now = await read(transport);
      if (!now) {
        return done(target, "uncertain", "Lost contact before the host answered.", lastSeen);
      }
      if (now.hostEpoch !== seen.hostEpoch || now.modeRevision === undefined) {
        return done(target, "conflicted", "The host restarted. Left as it is.", seenOf(now));
      }
      lastSeen = { hostEpoch: seen.hostEpoch, modeRevision: now.modeRevision };
      if (now.mode === step) {
        reply = now;
      } else if (now.modeRevision === revision) {
        return done(
          target,
          "uncertain",
          "The host didn't confirm. Nothing changed there.",
          lastSeen
        );
      } else {
        return done(
          target,
          "conflicted",
          "Canopy was changed there meanwhile. Left as it is.",
          lastSeen
        );
      }
    }
    if (reply.hostEpoch !== seen.hostEpoch || reply.modeRevision === undefined) {
      return done(target, "conflicted", "The host restarted. Left as it is.", seenOf(reply));
    }
    lastSeen = { hostEpoch: seen.hostEpoch, modeRevision: reply.modeRevision };
    if (reply.mode !== step) {
      return done(
        target,
        "conflicted",
        "Canopy was changed there meanwhile. Left as it is.",
        lastSeen
      );
    }
    revision = reply.modeRevision;
  }
  return done(target, "enabled", "Turned on.", lastSeen);
}

/**
 * Turns Canopy on across the frozen targets, a few at a time, each through the
 * host's own conditional mode change. One host's failure never reaches
 * another. `before` carries what an earlier run saw on a target, for a retry.
 */
export async function enableCanopyOnHosts(
  targets: readonly BulkTarget[],
  deps: BulkEnableDeps,
  before: ReadonlyMap<HostId, BulkSeen | null> = new Map(),
  onResult?: (result: BulkResult) => void
): Promise<BulkResult[]> {
  const results: BulkResult[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index]!;
      const transport = deps.transportFor(target);
      let result: BulkResult;
      try {
        result = deps.signal?.aborted
          ? done(target, "uncertain", "Stopped before this host was started.", null)
          : await enableOne(target, transport, before.get(target.hostId) ?? null, deps.signal);
      } catch {
        result = done(target, "uncertain", "Something went wrong on this host.", null);
      } finally {
        transport.release();
      }
      results[index] = result;
      onResult?.(result);
    }
  };
  const width = Math.max(1, Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, targets.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

export interface BulkPreviewRow {
  hostId: HostId;
  /** What the host said now, or null when it wasn't asked or didn't answer. */
  mode: CanopyMode | null;
}

/** Reads each target without dialling and without changing anything. */
export async function previewCanopyModes(
  targets: readonly BulkTarget[],
  deps: Pick<BulkEnableDeps, "transportFor" | "concurrency">
): Promise<BulkPreviewRow[]> {
  const rows: BulkPreviewRow[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index]!;
      const transport = deps.transportFor(target);
      try {
        rows[index] = { hostId: target.hostId, mode: (await transport.getSnapshot()).mode };
      } catch {
        rows[index] = { hostId: target.hostId, mode: null };
      } finally {
        transport.release();
      }
    }
  };
  const width = Math.max(1, Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, targets.length));
  await Promise.all(Array.from({ length: width }, worker));
  return rows;
}
