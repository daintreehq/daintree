import {
  isReservedHostName,
  sameHostName,
  type HostId,
  type HostListEntry,
  type PendingHostPlacement,
} from "@shared/types/remoteHosts";
import {
  cloudMachineLabel,
  type CloudAccountSummary,
  type CloudHostCreateRequest,
  type CloudHostStatus,
  type CloudHostsSnapshot,
  type CloudOperationKind,
  type CloudProviderInfo,
} from "@shared/types/cloudHosts";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { notify } from "@/lib/notify";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import { getHostListSnapshot } from "./hostList";
import { isUsableConnection, noteAskedHere } from "./pendingPlacement";

/** The host list's own limit on a name (`HostRegistry`), and the machine's with it. */
const MAX_MACHINE_NAME_LENGTH = 64;

/** A connected account a new machine can come from, with its provider. */
export interface CloudMachineAccount {
  account: CloudAccountSummary;
  provider: CloudProviderInfo;
}

/**
 * A new machine can be made for a worktree only from a window on this
 * machine: the worktree is created here first, and only this machine's
 * views carry a waiting worktree on to its host.
 */
export function canOfferCloudMachine(): boolean {
  return isRemoteShellSupported() && getViewHostId() === null;
}

/** Every connected account on a provider this machine can use, in the snapshot's order. */
export function cloudMachineAccounts(snapshot: CloudHostsSnapshot): CloudMachineAccount[] {
  const out: CloudMachineAccount[] = [];
  for (const account of snapshot.accounts) {
    const provider = snapshot.providers.find((entry) => entry.id === account.providerId);
    if (provider && provider.unsupportedReason === null) out.push({ account, provider });
  }
  return out;
}

/**
 * The new machine's name, from its worktree's branch ("feature/login" is
 * "feature-login"), numbered past any host already called that.
 */
export function cloudMachineName(branch: string, hosts: readonly HostListEntry[]): string {
  const base =
    branch
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, MAX_MACHINE_NAME_LENGTH) || "worktree";
  const taken = (name: string) =>
    isReservedHostName(name) || hosts.some((entry) => sameHostName(entry.descriptor.name, name));
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_MACHINE_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

export interface CloudWorktreePlacementInput {
  projectId: string;
  /** The worktree just created here: its root path. */
  worktreeId: string;
  /** Its branch, as the create resolved it. */
  branch: string;
  /** The machine as the dialog's form stood when Create was pressed; its name comes from the branch. */
  machine: Omit<CloudHostCreateRequest, "name">;
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/**
 * Ask for a machine made for a worktree that now exists here. Main writes the
 * machine's mark and the worktree waiting on its host together, so from here
 * on the worktree's card shows the machine coming up; once it runs, this view
 * opens its setup (see {@link armCloudSetup}). A refusal before any machine
 * was asked for leaves the worktree here and says why, with Retry.
 */
export async function startCloudWorktreePlacement(
  input: CloudWorktreePlacementInput
): Promise<HostId | null> {
  const hosts = getHostListSnapshot().hosts;
  // One machine per worktree: a Retry after an answer that never came back
  // finds the machine that was made, rather than asking for a second.
  const waiting = hosts.find((host) => {
    const placement = host.descriptor.pendingPlacement;
    return (
      placement?.createdMachine === true &&
      placement.projectId === input.projectId &&
      placement.worktreeId === input.worktreeId
    );
  });
  if (waiting) return waiting.descriptor.id;
  if (asking.has(input.worktreeId)) return null;
  asking.add(input.worktreeId);
  const name = cloudMachineName(input.branch, hosts);
  try {
    const { hostId, requestedAt } = await cloudHostsClient.createHostForWorktree({
      machine: { ...input.machine, name },
      worktree: {
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        worktreeName: input.branch,
      },
    });
    noteAskedHere(hostId, requestedAt);
    armCloudSetup(hostId, requestedAt);
    return hostId;
  } catch (err) {
    notify({
      type: "error",
      title: "Couldn't create the machine",
      message: `${errorText(err, "The machine wasn't asked for.")} ${input.branch} was created on this machine.`,
      context: { worktreeId: input.worktreeId, eventKind: "host" },
      action: {
        label: "Retry",
        onClick: () => void startCloudWorktreePlacement(input),
      },
    });
    return null;
  } finally {
    asking.delete(input.worktreeId);
  }
}

/** Worktrees a machine is being asked for right now, so a second press doesn't ask twice. */
const asking = new Set<string>();

/**
 * Placements whose host this view opens setup for, once its machine runs.
 * `seen` once the host list has shown the host: only then does its absence
 * mean it went away, rather than that the list hasn't caught up yet.
 */
const armed = new Map<HostId, { requestedAt: number; seen: boolean }>();
const armedListeners = new Set<() => void>();
let armedVersion = 0;

function publishArmed(): void {
  armedVersion += 1;
  for (const listener of [...armedListeners]) listener();
}

/**
 * This view asked for the machine, so this view opens its setup when the
 * machine runs. Only for this run: after a restart, the worktree's card offers
 * Set up… instead of a dialog appearing by itself.
 */
export function armCloudSetup(hostId: HostId, requestedAt: number): void {
  armed.set(hostId, { requestedAt, seen: false });
  publishArmed();
}

/** Stop waiting to open setup for a host; true when it was waiting for this placement. */
export function disarmCloudSetup(hostId: HostId, requestedAt?: number): boolean {
  const held = armed.get(hostId);
  if (held === undefined || (requestedAt !== undefined && held.requestedAt !== requestedAt)) {
    return false;
  }
  armed.delete(hostId);
  publishArmed();
  return true;
}

export function hasArmedCloudSetup(): boolean {
  return armed.size > 0;
}

export function cloudSetupVersion(): number {
  return armedVersion;
}

export function subscribeCloudSetup(listener: () => void): () => void {
  armedListeners.add(listener);
  return () => {
    armedListeners.delete(listener);
  };
}

/**
 * The machine's own record says it was made for the worktree this placement
 * waits with: what deleting it from the placement rests on, rather than the
 * placement's own flag.
 */
export function isMadeForPlacement(
  status: CloudHostStatus | null,
  placement: Pick<PendingHostPlacement, "projectId" | "worktreeId">
): boolean {
  const mark = status?.createdFor;
  return (
    mark != null &&
    mark.hostId === null &&
    mark.projectId === placement.projectId &&
    mark.worktreeId === placement.worktreeId
  );
}

/** The machine is up with nothing running on it: setup can begin. */
export function isMachineReady(status: CloudHostStatus | null): boolean {
  return status !== null && status.machine === "running" && status.operation === null;
}

/**
 * The first armed placement of this project whose machine now runs and whose
 * host isn't usable yet, or null. `stale` collects armed hosts whose
 * placement is gone or replaced, for the caller to let go of. Nothing is
 * ready while any host's setup is open: opening another would replace it.
 */
export function cloudSetupReady(
  hosts: readonly HostListEntry[],
  snapshot: CloudHostsSnapshot,
  projectId: string,
  isSetupOpen: (hostId: HostId) => boolean,
  anySetupOpen = false
): { ready: { hostId: HostId; requestedAt: number } | null; stale: HostId[] } {
  const stale: HostId[] = [];
  let ready: { hostId: HostId; requestedAt: number } | null = null;
  for (const [hostId, arm] of armed) {
    const { requestedAt } = arm;
    const host = hosts.find((entry) => entry.descriptor.id === hostId);
    if (!host) {
      if (arm.seen) stale.push(hostId);
      continue;
    }
    arm.seen = true;
    const placement: PendingHostPlacement | undefined = host.descriptor.pendingPlacement;
    if (placement?.requestedAt !== requestedAt) {
      stale.push(hostId);
      continue;
    }
    // Usable already: the waiting worktree carries on without setup.
    if (isUsableConnection(host.connection)) {
      stale.push(hostId);
      continue;
    }
    if (ready || anySetupOpen || placement.projectId !== projectId || isSetupOpen(hostId)) continue;
    const status = snapshot.hosts.find((entry) => entry.hostId === hostId) ?? null;
    if (isMachineReady(status)) ready = { hostId, requestedAt };
  }
  return { ready, stale };
}

/**
 * Where a worktree waiting on its new machine stands, from the machine's
 * last observation and the placement's own record: what its card says, and
 * which ways on it offers.
 */
export type CloudPlacementStage =
  /** The cloud picture hasn't arrived yet. */
  | { kind: "waiting" }
  /** Something is under way on the machine: what, and its step in words. */
  | { kind: "busy"; operation: CloudOperationKind; step: string }
  /** No machine exists and nothing is asking for one: Retry asks again. */
  | { kind: "create-failed"; message: string }
  /** The machine exists but isn't running. */
  | { kind: "machine"; message: string }
  /** Setup, or the switch onto the machine, stopped; the placement still waits. */
  | { kind: "failed"; message: string }
  /** The machine runs and waits for Daintree's setup there. */
  | { kind: "setup" };

export function cloudPlacementStage(
  status: CloudHostStatus | null,
  placement: Pick<PendingHostPlacement, "failure">
): CloudPlacementStage {
  if (status === null) return { kind: "waiting" };
  if (status.operation) {
    return {
      kind: "busy",
      operation: status.operation.kind,
      step: status.operation.stage || cloudMachineLabel(status.machine),
    };
  }
  if (status.resourceId === null) {
    return {
      kind: "create-failed",
      message: status.lastError?.message ?? "Its machine hasn't been created.",
    };
  }
  if (status.machine !== "running") {
    return {
      kind: "machine",
      message:
        status.lastError?.message ??
        `Its machine is ${cloudMachineLabel(status.machine).toLowerCase()}.`,
    };
  }
  if (placement.failure) return { kind: "failed", message: placement.failure.message };
  return { kind: "setup" };
}

export function _resetCloudWorktreePlacementForTesting(): void {
  armed.clear();
  asking.clear();
  armedListeners.clear();
  armedVersion = 0;
}
