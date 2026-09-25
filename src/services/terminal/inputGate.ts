import { ClientAppError } from "@/utils/clientAppError";

/**
 * Why this view's terminals take no input right now. Output keeps flowing;
 * only what the user types is held back, so nothing is queued behind a link
 * that is down or sent to a project another frontend is driving.
 */
export type TerminalInputBlock =
  { kind: "disconnected"; hostName: string } | { kind: "driven-elsewhere"; driverName: string };

let hostBlock: TerminalInputBlock | null = null;
let leaseBlock: TerminalInputBlock | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function sameBlock(a: TerminalInputBlock | null, b: TerminalInputBlock | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "disconnected" && b.kind === "disconnected") return a.hostName === b.hostName;
  if (a.kind === "driven-elsewhere" && b.kind === "driven-elsewhere") {
    return a.driverName === b.driverName;
  }
  return false;
}

/** The link to the window's host is down (null once it is back). */
export function setHostInputBlock(
  block: Extract<TerminalInputBlock, { kind: "disconnected" }> | null
) {
  if (sameBlock(hostBlock, block)) return;
  hostBlock = block;
  emit();
}

/** Another frontend holds this project's drive lease (null when this one may drive). */
export function setLeaseInputBlock(
  block: Extract<TerminalInputBlock, { kind: "driven-elsewhere" }> | null
) {
  if (sameBlock(leaseBlock, block)) return;
  leaseBlock = block;
  emit();
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

export function getTerminalInputBlockMessage(block: TerminalInputBlock): string {
  return block.kind === "disconnected"
    ? `Read-only until ${block.hostName} reconnects`
    : `Read-only while ${block.driverName} is driving this project`;
}

/** The error a gated submit rejects with, so callers see a typed reason rather than a hang. */
export function terminalInputBlockedError(block: TerminalInputBlock): ClientAppError {
  const message = getTerminalInputBlockMessage(block);
  return block.kind === "disconnected"
    ? new ClientAppError("HOST_DISCONNECTED", message, message)
    : new ClientAppError("DRIVEN_ELSEWHERE", message, message);
}

export function _resetTerminalInputGateForTesting(): void {
  hostBlock = null;
  leaseBlock = null;
  listeners.clear();
}
