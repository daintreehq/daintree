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
    }
  | { kind: "lease-unknown"; hostName: string };

type LeaseBlock = Extract<TerminalInputBlock, { kind: "driven-elsewhere" | "lease-unknown" }>;

let hostBlock: TerminalInputBlock | null = null;
let leaseBlock: LeaseBlock | null = null;
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
      a.driverName === b.driverName && a.projectId === b.projectId && a.hostLocal === b.hostLocal
    );
  }
  if (a.kind === "lease-unknown" && b.kind === "lease-unknown") return a.hostName === b.hostName;
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

export function getLeaseInputBlock(): LeaseBlock | null {
  return leaseBlock;
}

/** A lost link outranks a lease: nothing reaches the host either way, and reconnecting comes first. */
export function getTerminalInputBlock(): TerminalInputBlock | null {
  return hostBlock ?? leaseBlock;
}

export function isTerminalInputBlocked(): boolean {
  return hostBlock !== null || leaseBlock !== null;
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
      return `Read-only while ${block.driverName} is driving this project`;
    case "lease-unknown":
      return `Read-only until ${block.hostName} confirms who is driving this project`;
  }
}

/** The error a gated submit rejects with, so callers see a typed reason rather than a hang. */
export function terminalInputBlockedError(block: TerminalInputBlock): ClientAppError {
  const message = getTerminalInputBlockMessage(block);
  return block.kind === "driven-elsewhere"
    ? new ClientAppError("DRIVEN_ELSEWHERE", message, message)
    : new ClientAppError("HOST_DISCONNECTED", message, message);
}

export function _resetTerminalInputGateForTesting(): void {
  hostBlock = null;
  leaseBlock = null;
  listeners.clear();
  unblockListeners.clear();
}
