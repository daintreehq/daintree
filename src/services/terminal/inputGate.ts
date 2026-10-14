import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { ClientAppError } from "@/utils/clientAppError";

/**
 * Why this view's terminals take no input right now. Output keeps flowing;
 * only what the user types is held back, so nothing is queued behind a link
 * that is down or sent to a project another frontend is driving.
 */
export type TerminalInputBlock =
  | { kind: "disconnected"; hostName: string }
  | {
      kind: "driven-elsewhere";
      driverName: string;
      /** The project whose lease is held, so the pane can ask for it back. */
      projectId?: string;
      /** This view is on the host's own screen, where taking over reads as taking back. */
      hostLocal?: boolean;
      /** A window on the host's own screen drives, and `driverName` is the host's. */
      driverIsHostScreen?: boolean;
    }
  | { kind: "lease-unknown"; hostName: string }
  /**
   * The window is on its way to another host. Until it lands, what the user
   * types would reach a terminal they are leaving, so it goes nowhere.
   */
  | { kind: "switching"; hostName: string };

type LeaseBlock = Extract<TerminalInputBlock, { kind: "driven-elsewhere" | "lease-unknown" }>;
type SwitchBlock = Extract<TerminalInputBlock, { kind: "switching" }>;

let hostBlock: TerminalInputBlock | null = null;
let leaseBlock: LeaseBlock | null = null;
let switchBlock: SwitchBlock | null = null;
const listeners = new Set<() => void>();
const unblockListeners = new Set<() => void>();

function emit(wasBlocked: boolean): void {
  for (const listener of [...listeners]) listener();
  if (!wasBlocked || isTerminalInputBlocked()) return;
  for (const listener of [...unblockListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("[inputGate] Unblock listener failed:", error);
    }
  }
}

function sameBlock(a: TerminalInputBlock | null, b: TerminalInputBlock | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "disconnected" && b.kind === "disconnected") return a.hostName === b.hostName;
  if (a.kind === "driven-elsewhere" && b.kind === "driven-elsewhere") {
    return (
      a.driverName === b.driverName &&
      a.projectId === b.projectId &&
      a.hostLocal === b.hostLocal &&
      a.driverIsHostScreen === b.driverIsHostScreen
    );
  }
  if (a.kind === "lease-unknown" && b.kind === "lease-unknown") return a.hostName === b.hostName;
  if (a.kind === "switching" && b.kind === "switching") return a.hostName === b.hostName;
  return false;
}

/** The link to the window's host is down (null once it is back). */
export function setHostInputBlock(
  block: Extract<TerminalInputBlock, { kind: "disconnected" }> | null
) {
  if (sameBlock(hostBlock, block)) return;
  const wasBlocked = isTerminalInputBlocked();
  hostBlock = block;
  emit(wasBlocked);
}

/**
 * Another frontend holds this project's drive lease, or a remote view doesn't
 * know yet who does (null when this one may drive).
 */
export function setLeaseInputBlock(block: LeaseBlock | null) {
  if (sameBlock(leaseBlock, block)) return;
  const wasBlocked = isTerminalInputBlocked();
  leaseBlock = block;
  emit(wasBlocked);
}

/**
 * This window's switch to another host, while one is pending (null once it
 * lands, fails or is cancelled). Type-ahead is dropped, never replayed: the
 * window it was meant for may not be the one it lands in.
 */
export function setSwitchInputBlock(block: SwitchBlock | null) {
  if (sameBlock(switchBlock, block)) return;
  const wasBlocked = isTerminalInputBlocked();
  switchBlock = block;
  emit(wasBlocked);
}

export function getLeaseInputBlock(): LeaseBlock | null {
  return leaseBlock;
}

/**
 * The lease answer the gate was last set from, kept whole so the drive-lease
 * banner and host chip show the same snapshot that blocks typing rather than
 * asking the host a second time.
 */
let leaseSnapshot: DriveLeaseView | null = null;
const leaseSnapshotListeners = new Set<() => void>();

export function setDriveLeaseSnapshot(view: DriveLeaseView | null): void {
  if (leaseSnapshot === view) return;
  leaseSnapshot = view;
  for (const listener of [...leaseSnapshotListeners]) listener();
}

export function getDriveLeaseSnapshot(): DriveLeaseView | null {
  return leaseSnapshot;
}

export function subscribeDriveLeaseSnapshot(listener: () => void): () => void {
  leaseSnapshotListeners.add(listener);
  return () => leaseSnapshotListeners.delete(listener);
}

/**
 * A lost link outranks a lease: nothing reaches the host either way, and
 * reconnecting comes first. A pending switch ranks last, as the one that ends
 * on its own.
 */
export function getTerminalInputBlock(): TerminalInputBlock | null {
  return hostBlock ?? leaseBlock ?? switchBlock;
}

/**
 * Whether the link or the lease holds input back, a pending switch aside: the
 * terminal still on screen during a switch keeps answering its program's
 * queries, which are not typing.
 */
export function isTerminalReplyBlocked(): boolean {
  return hostBlock !== null || leaseBlock !== null;
}

/** Whether this window is on its way to another host, whatever else blocks input. */
export function isHostSwitchPending(): boolean {
  return switchBlock !== null;
}

export function isTerminalInputBlocked(): boolean {
  return hostBlock !== null || leaseBlock !== null || switchBlock !== null;
}

export function subscribeTerminalInputGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Told each time input opens again after being blocked, so work held back by
 * the gate can go out without waiting for some unrelated event to retry it.
 */
export function onTerminalInputUnblocked(listener: () => void): () => void {
  unblockListeners.add(listener);
  return () => unblockListeners.delete(listener);
}

export function getTerminalInputBlockMessage(block: TerminalInputBlock): string {
  switch (block.kind) {
    case "disconnected":
      return `Read-only until ${block.hostName} reconnects`;
    case "driven-elsewhere":
      // Names the controller the way the window banner does.
      return block.driverIsHostScreen
        ? `Read-only · ${block.driverName}'s own screen has control`
        : `Read-only · ${block.driverName} has control`;
    case "lease-unknown":
      return `Read-only until ${block.hostName} confirms who has control of this project`;
    case "switching":
      return `Not sent: this window is switching to ${block.hostName}`;
  }
}

/** The error a gated submit rejects with, so callers see a typed reason rather than a hang. */
export function terminalInputBlockedError(block: TerminalInputBlock): ClientAppError {
  const message = getTerminalInputBlockMessage(block);
  if (block.kind === "driven-elsewhere") {
    return new ClientAppError("DRIVEN_ELSEWHERE", message, message);
  }
  // Refused here before anything left, so there is no outcome to look up.
  if (block.kind === "switching") return new ClientAppError("CANCELLED", message, message);
  return new ClientAppError("HOST_DISCONNECTED", message, message);
}

export function _resetTerminalInputGateForTesting(): void {
  hostBlock = null;
  leaseBlock = null;
  switchBlock = null;
  leaseSnapshot = null;
  listeners.clear();
  unblockListeners.clear();
  leaseSnapshotListeners.clear();
}
