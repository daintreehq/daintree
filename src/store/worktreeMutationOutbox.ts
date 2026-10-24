import type { WorktreeSnapshot, AttachIssuePayload } from "@shared/types";
import { worktreeClient } from "@/clients";
import {
  captureWorktreeTerminalSnapshot,
  closeTerminalsForWorktree,
  restoreClosedTerminals,
  type WorktreeTerminalRestoreSnapshot,
} from "@/components/Worktree/worktreeDeleteHelper";
import { logErrorWithContext } from "@/utils/errorContext";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { NESTED_WORKTREE_DELETE_MARKER } from "@shared/utils/nestedWorktrees";
import { worktreeNameFromId } from "@/lib/notificationSourceLabel";
import { WORKTREE_BRANCH_KEPT_MARKER } from "@shared/utils/worktreeSummary";
import {
  mergeIssueState,
  pickIssueProvenance,
  type ManualIssueAssociation,
} from "./worktreeSnapshotReconciliation";

/**
 * Options carried alongside a delete-in-flight so the card's "Retry" button
 * can re-fire the original request without re-opening the dialog. The dialog
 * confirms once; the card retries with the same intent.
 */
export interface WorktreeDeleteOptions {
  force?: boolean;
  deleteBranch?: boolean;
  closeTerminals?: boolean;
}

/**
 * Maximum number of generic (unclassified) error retries for a single outbox
 * entry before it's marked `failed` and surfaced to the user. Connectivity
 * failures (port not ready, host exited) don't count — they're driven by the
 * port reconnect lifecycle, not by the entry itself. Permanent errors (e.g.
 * "uncommitted changes", "Cannot delete the main worktree") flip to `failed`
 * after a single attempt without burning the cap. The 3-attempt budget is the
 * standard transient-retry ceiling; past that the failure is almost certainly
 * deterministic and the user should be asked.
 */
export const OUTBOX_RETRY_CAP = 3;

/**
 * Fields shared by every mutation-outbox entry (#8405). One entry per
 * user-intent worktree mutation, keyed by `mutationId`. The outbox survives
 * `setFatalError` so a mutation that was in flight when the host crashed can be
 * replayed once the host comes back. For `delete-worktree` the stable
 * `mutationId` also lets the host dedupe a replay against its ack map; the
 * issue-association mutations route through the main-process IPC bridge (the
 * `worktreeIssueMap` Electron-store write is main-owned, not host-owned), so
 * for them `mutationId` is purely the renderer's outbox key.
 */
interface MutationOutboxEntryBase {
  mutationId: string;
  worktreeId: string;
  /** Number of generic (unclassified) attempts so far; counted toward {@link OUTBOX_RETRY_CAP}. */
  retryCount: number;
  /**
   * `pending` — eligible for the next replay sweep (initial or post-failure).
   * `in-flight` — IPC request currently outstanding; no replay until it settles.
   * `failed` — terminal state for this entry; will not replay automatically.
   *   The user can dismiss the entry or hit Retry, which resets to `pending`.
   */
  status: "pending" | "in-flight" | "failed";
  lastError?: string;
}

/** Delete-worktree outbox entry — acked by the `worktree-removed` host event. */
export interface DeleteWorktreeOutboxEntry extends MutationOutboxEntryBase {
  type: "delete-worktree";
  options: WorktreeDeleteOptions;
}

/**
 * Attach-issue outbox entry (#9163). Unlike delete there is no host-emitted ack
 * event — the main-process `worktreeIssueMap` write is synchronous, so the
 * resolved IPC promise IS the ack and the entry is pruned on resolve. The local
 * association is applied only on success (pessimistic), so a failed/abandoned
 * attach needs no rollback — the renderer never gets ahead of the store.
 */
export interface AttachIssueOutboxEntry extends MutationOutboxEntryBase {
  type: "attach-issue";
  payload: AttachIssuePayload;
}

/** Detach-issue outbox entry (#9163). Same ack/no-rollback semantics as attach. */
export interface DetachIssueOutboxEntry extends MutationOutboxEntryBase {
  type: "detach-issue";
}

export type MutationOutboxEntry =
  DeleteWorktreeOutboxEntry | AttachIssueOutboxEntry | DetachIssueOutboxEntry;

/** True for the issue-association mutation arms (#9163). */
export function isIssueMutation(
  entry: MutationOutboxEntry
): entry is AttachIssueOutboxEntry | DetachIssueOutboxEntry {
  return entry.type === "attach-issue" || entry.type === "detach-issue";
}

/** Per-worktree issue-mutation failure surfaced on the card banner (#9163). */
export interface IssueMutationError {
  message: string;
  type: "attach-issue" | "detach-issue";
  /** Outbox entry id so the banner's Retry/Dismiss can target it directly. */
  mutationId: string;
}

/**
 * The store fields the mutation runners read and write. The runners are handed
 * the store's own `get`/`set`, so each update still lands as one atomic commit;
 * this narrows what they can see to the outbox and the per-card state it drives.
 */
export interface WorktreeMutationState {
  worktrees: Map<string, WorktreeSnapshot>;
  manualAssociations: Map<string, ManualIssueAssociation>;
  deletingIds: Set<string>;
  deleteErrors: Map<string, string>;
  deleteErrorArgs: Map<string, WorktreeDeleteOptions>;
  issueMutatingIds: Set<string>;
  issueErrors: Map<string, IssueMutationError>;
  mutationOutbox: Map<string, MutationOutboxEntry>;
}

export type WorktreeMutationGet = () => WorktreeMutationState;
export type WorktreeMutationSet = (partial: Partial<WorktreeMutationState>) => void;

/**
 * Two things key off the branch-kept clause: the delete is permanent-failed
 * rather than retried (a retry can only find the worktree already gone), and
 * the toast reports a branch deliberately kept rather than a broken delete.
 */
function isBranchKeptError(message: string): boolean {
  return message.includes(WORKTREE_BRANCH_KEPT_MARKER);
}

/**
 * Error patterns that cannot be remedied by retrying — e.g. uncommitted
 * changes block the delete until the user resolves them. These flip the
 * outbox entry to `failed` after a single attempt rather than burning the
 * generic-retry budget on a deterministic failure. The strings are checked
 * via `includes` against the error message so wrapped/prefixed variants
 * still match. All patterns come from {@link WorkspaceService.deleteWorktree}
 * — they're our own error messages, not git's, so they're stable.
 */
const PERMANENT_ERROR_PATTERNS = [
  "uncommitted changes",
  "untracked files",
  "Cannot delete the main worktree",
  "Cannot delete active worktree",
  "Cannot delete branch:",
  WORKTREE_BRANCH_KEPT_MARKER,
  "(detached HEAD)",
  NESTED_WORKTREE_DELETE_MARKER,
];

function isPermanentDeleteError(message: string): boolean {
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (message.includes(pattern)) return true;
  }
  return false;
}

/**
 * Connectivity-class errors thrown by `WorktreePortClient` when the host has
 * gone away. The port client encodes these as `BrokerError("HOST_EXITED", ...)`
 * which surfaces in the renderer as a string prefix; the renderer also throws
 * its own "Worktree port not ready" when the port is null. These shouldn't
 * count toward the retry cap — the failure is the port being down, and the
 * port reconnect path drives the next attempt.
 */
function isConnectivityError(message: string): boolean {
  return (
    message.includes("HOST_EXITED") ||
    message.includes("port not ready") ||
    message.includes("port disconnected") ||
    message.includes("port replaced") ||
    message.includes("APP_SHUTDOWN")
  );
}

/** Every live outbox entry for a worktreeId — a worktree can now hold both a
 *  delete and an issue-mutation entry concurrently (#9163). Used by
 *  `applyRemove` to prune them all when the worktree is gone. */
export function findOutboxEntriesForWorktree(
  outbox: Map<string, MutationOutboxEntry>,
  worktreeId: string
): MutationOutboxEntry[] {
  const entries: MutationOutboxEntry[] = [];
  for (const entry of outbox.values()) {
    if (entry.worktreeId === worktreeId) entries.push(entry);
  }
  return entries;
}

/** Locate the live delete entry (if any) for a worktreeId. Used to reuse
 *  `mutationId` across user-initiated retries so the host's ack map dedupes. */
export function findDeleteOutboxEntryForWorktree(
  outbox: Map<string, MutationOutboxEntry>,
  worktreeId: string
): DeleteWorktreeOutboxEntry | undefined {
  for (const entry of outbox.values()) {
    if (entry.worktreeId === worktreeId && entry.type === "delete-worktree") return entry;
  }
  return undefined;
}

/** Locate the live issue-association entry (if any) for a worktreeId (#9163).
 *  Attach and detach share the slot — only one issue mutation per worktree. */
export function findIssueOutboxEntryForWorktree(
  outbox: Map<string, MutationOutboxEntry>,
  worktreeId: string
): AttachIssueOutboxEntry | DetachIssueOutboxEntry | undefined {
  for (const entry of outbox.values()) {
    if (entry.worktreeId === worktreeId && isIssueMutation(entry)) return entry;
  }
  return undefined;
}

/** Renderer-minted opaque id for a single user-intent mutation. UUIDv4 via
 *  `crypto.randomUUID` for cryptographic uniqueness across renderer sessions
 *  (the host ack map is global per-epoch and the renderer must not collide
 *  even across project switches that share a host process). */
export function mintMutationId(): string {
  return crypto.randomUUID();
}

/**
 * Terminals closed ahead of a `git worktree remove`, held by `mutationId` so
 * they can be relaunched if the delete is ultimately abandoned (#11344). Keyed
 * by mutationId — not worktreeId — so the snapshot survives the outbox retry
 * loop: a connectivity or generic failure leaves the delete `pending` and
 * replays `runDeleteAsync`, but the replay finds no live terminals to snapshot
 * (they're already dead), so the ORIGINAL capture must persist here until the
 * delete either succeeds (entry discarded) or is definitively abandoned (entry
 * consumed to restore). In-memory only: a host crash mid-delete loses the
 * snapshot, which is acceptable — the PTYs died with the host regardless.
 */
const pendingTerminalRestores = new Map<string, WorktreeTerminalRestoreSnapshot[]>();

/**
 * In-flight relaunch per worktree. A relaunch is a sequence of async `addPanel`
 * spawns; a fresh `runDeleteAsync` for the same worktree awaits this before
 * closing terminals, so a rapid retry can't interleave its close with spawns
 * still in flight (which would strand panels against the git remove or leak them
 * onto a deleted worktree).
 */
const restoreInFlight = new Map<string, Promise<void>>();

/** Relaunch the terminals closed for a delete that has been definitively
 *  abandoned (won't be auto-retried), then drop the snapshot. No-op when the
 *  delete closed no terminals or a prior branch already consumed it. Tracks the
 *  relaunch promise per worktree so a concurrent delete can await it. */
function consumeTerminalRestore(worktreeId: string, mutationId: string): void {
  const snapshot = pendingTerminalRestores.get(mutationId);
  if (!snapshot) return;
  pendingTerminalRestores.delete(mutationId);
  const done = restoreClosedTerminals(snapshot).finally(() => {
    if (restoreInFlight.get(worktreeId) === done) restoreInFlight.delete(worktreeId);
  });
  restoreInFlight.set(worktreeId, done);
}

/** The delete entry parked in the outbox for a worktree, if any. A worktree has
 *  at most one in flight — `startDelete` reuses the existing `mutationId`. */
function findDeleteMutationId(
  outbox: ReadonlyMap<string, MutationOutboxEntry>,
  worktreeId: string
): string | undefined {
  for (const entry of outbox.values()) {
    if (entry.type === "delete-worktree" && entry.worktreeId === worktreeId) {
      return entry.mutationId;
    }
  }
  return undefined;
}

/**
 * Abandon a failed delete: the banner, the stored retry args and the outbox
 * entry all go together.
 *
 * Clearing only the presentation state was a silent replay hazard (#12087). A
 * failure that isn't permanent and hasn't hit the retry cap — "cannot remove a
 * locked working tree", say — parks its entry at `pending`, and
 * `replayOutboxAfterReconnect` skips only `failed`/`in-flight`. So a dismissed
 * delete stayed queued and re-fired on the next reconnect.
 *
 * The terminals the delete closed are relaunched here for the same reason
 * `handleDeleteFailure` relaunches them once an entry goes `failed`: the
 * snapshot is held only while an automatic retry could still use it, and a
 * dismissed delete is definitively abandoned.
 */
export function abandonDelete(
  get: WorktreeMutationGet,
  set: WorktreeMutationSet,
  worktreeId: string,
  knownMutationId?: string
): void {
  const prev = get();
  const mutationId = knownMutationId ?? findDeleteMutationId(prev.mutationOutbox, worktreeId);
  const entry = mutationId === undefined ? undefined : prev.mutationOutbox.get(mutationId);
  const hadError = prev.deleteErrors.has(worktreeId);
  const hadArgs = prev.deleteErrorArgs.has(worktreeId);

  // An `in-flight` entry still has a live `runDeleteAsync` behind it, and the
  // banner can be showing over one: `replayOutboxAfterReconnect` flips entries
  // to `in-flight` without clearing `deleteErrors`, so a Dismiss can land on a
  // delete that is actively running. Pruning that entry would orphan a removal
  // still on its way to the host, and relaunching its terminals would race the
  // removal that is about to succeed. Drop the banner, leave the mutation to
  // settle on its own — `handleDeleteFailure` re-surfaces it if it fails again.
  const prunable = entry !== undefined && entry.status !== "in-flight";
  if (!hadError && !hadArgs && !prunable) return;

  const nextDeleteErrors = hadError ? new Map(prev.deleteErrors) : prev.deleteErrors;
  if (hadError) nextDeleteErrors.delete(worktreeId);
  const nextDeleteErrorArgs = hadArgs ? new Map(prev.deleteErrorArgs) : prev.deleteErrorArgs;
  if (hadArgs) nextDeleteErrorArgs.delete(worktreeId);
  const nextOutbox = prunable ? new Map(prev.mutationOutbox) : prev.mutationOutbox;
  if (prunable && mutationId !== undefined) nextOutbox.delete(mutationId);

  set({
    deleteErrors: nextDeleteErrors,
    deleteErrorArgs: nextDeleteErrorArgs,
    mutationOutbox: nextOutbox,
  });

  if (prunable && mutationId !== undefined) consumeTerminalRestore(worktreeId, mutationId);
}

/** Drop any pending/in-flight restore bookkeeping for a worktree. Called when
 *  the worktree is authoritatively gone (`applyRemove`) so the module maps don't
 *  leak a snapshot that will never be replayed. */
export function discardTerminalRestores(worktreeId: string, mutationIds: readonly string[]): void {
  for (const mutationId of mutationIds) pendingTerminalRestores.delete(mutationId);
  restoreInFlight.delete(worktreeId);
}

/**
 * Fire-and-forget delete async chain. The dialog dismisses immediately after
 * calling `startDelete`; this runs in the background driven by the store, so
 * `get()` / `set()` must never close over component state. The success cleanup
 * is handled by `applyRemove` (triggered by the `worktree-removed` IPC event),
 * not here — the only thing we own is the failure path.
 *
 * `mutationId` (#8405) is the renderer's stable identifier for this delete
 * intent and is threaded through to the host so a replay after a crash is
 * deduplicated against the host's ack map. On a connectivity failure (host
 * crashed mid-call) the entry is left as `pending` and the renderer's
 * `replayOutboxAfterReconnect` re-fires it once the port returns. On a
 * permanent error (uncommitted changes, etc.) the entry flips to `failed`
 * immediately. Generic errors increment the retry counter and flip to
 * `failed` once {@link OUTBOX_RETRY_CAP} is reached.
 */
export async function runDeleteAsync(
  get: WorktreeMutationGet,
  set: WorktreeMutationSet,
  worktreeId: string,
  options: WorktreeDeleteOptions,
  mutationId: string
): Promise<void> {
  // Which half of the flow a failure came from. `classifyError` reads the
  // message, and a branch name is part of that message — `feature/fetch` reads
  // as a network error, `fix/file-upload` as a filesystem one. Once the delete
  // call is in flight we know the category without having to guess at text.
  let reachedDelete = false;
  try {
    // A rapid retry after a prior attempt's restore must not start closing
    // terminals while that restore is still spawning panels (#11344) — wait it
    // out so this attempt sees the fully-restored set.
    const inFlightRestore = restoreInFlight.get(worktreeId);
    if (inFlightRestore) await inFlightRestore;

    if (options.closeTerminals) {
      // Capture BEFORE the destructive close so a close-wait timeout can't lose
      // the snapshot. Set only on the FIRST attempt that finds live terminals —
      // a retry replay finds none (already dead) and must not clobber it; a
      // later non-empty capture (e.g. the user opened new terminals mid-retry)
      // must not either.
      const snapshot = captureWorktreeTerminalSnapshot(worktreeId);
      if (snapshot.length > 0 && !pendingTerminalRestores.has(mutationId)) {
        pendingTerminalRestores.set(mutationId, snapshot);
      }
      await closeTerminalsForWorktree(worktreeId);
    }
    // Stop any running dev preview BEFORE `git worktree remove` (#9084). On
    // Windows the dev server holds a directory lock and the removal would
    // fail outright. Snapshot the worktree name first so a transient toast
    // can name it after `applyRemove` has already cleared the row.
    //
    // `getByWorktree` reflects only the worktreeId→session mapping's current
    // head, so when multiple panels share a worktreeId it may show one
    // session while another runs. `stopByWorktree` filters every session
    // itself and no-ops cleanly when nothing matches — call it
    // unconditionally and use `getByWorktree` only to decide whether to
    // surface a toast.
    const worktreeBefore = get().worktrees.get(worktreeId);
    const worktreeName =
      worktreeBefore?.name ?? worktreeBefore?.branch ?? worktreeNameFromId(worktreeId);
    const existingDevPreview = await window.electron.devPreview.getByWorktree({ worktreeId });
    const hadDevPreview = existingDevPreview !== null;
    await window.electron.devPreview.stopByWorktree({ worktreeId });
    reachedDelete = true;
    await worktreeClient.delete(worktreeId, {
      force: options.force,
      deleteBranch: options.deleteBranch,
      mutationId,
    });
    if (hadDevPreview) {
      notify({
        type: "success",
        title: "Dev server stopped",
        message: `${worktreeName} stopped before removing the worktree.`,
        transient: true,
        context: { worktreeId },
      });
    }
    // Success: the worktree is gone, so the closed terminals stay closed —
    // discard their restore snapshot. `worktree-removed` will fire
    // `applyRemove`, which clears `deletingIds` + delete-error maps. The outbox
    // entry is pruned either by `applyRemove` (success path) or by the next
    // `get-all-states` reply via `pruneAcknowledgedMutations` (post-crash replay
    // path). Either way, no post-success bookkeeping is owned here.
    pendingTerminalRestores.delete(mutationId);
    pruneOutboxEntry(get, set, mutationId);
  } catch (err) {
    const message = formatErrorMessage(err, "Failed to delete worktree");
    // Logged once here, before the routing split below, so the partial-success
    // path (card already gone, toast only) and the pre-IPC failures (dev-preview
    // stop, terminal close) land in `daintree.log` too — not just the failures
    // that still have a card to draw an error on.
    // Only the delete itself is known to be git. The terminal-close and
    // dev-preview failures ahead of it are not, so those are left to
    // `classifyError` and its structured props rather than forced to a
    // category the stage cannot support.
    logErrorWithContext(err, {
      operation: "delete_worktree",
      component: "createWorktreeStore",
      ...(reachedDelete ? { errorType: "git" as const } : {}),
      details: {
        worktreeId,
        mutationId,
        force: options.force,
        deleteBranch: options.deleteBranch,
        closeTerminals: options.closeTerminals,
      },
    });
    const prev = get();
    // Partial-success path: the backend removes the worktree and emits
    // `worktree-removed` BEFORE it touches the branch, so a branch-delete
    // failure arrives after `applyRemove` has already cleared the card. The
    // card surface is gone — fall back to a toast so the user learns the
    // branch was not cleaned up. Without this, the failure is silently
    // swallowed (the original race guard's bug).
    if (!prev.deletingIds.has(worktreeId) && !prev.worktrees.has(worktreeId)) {
      // The worktree directory is already gone (only the branch delete failed),
      // so the closed terminals have no home to come back to — drop the snapshot
      // rather than relaunch them against a deleted worktree.
      pendingTerminalRestores.delete(mutationId);
      pruneOutboxEntry(get, set, mutationId);
      if (isBranchKeptError(message)) {
        // Not a malfunction: the safe `branch -d` refused rather than discard
        // work Git does not consider merged. A warning keeps that legible as a
        // deliberate outcome instead of dressing a working safeguard as a fault
        // — and as a fault the user could fix by retrying, which they can't.
        notify({
          type: "warning",
          title: "Branch kept",
          message,
          priority: "high",
          context: { worktreeId, eventKind: "git" },
        });
      } else {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't delete branch",
          message,
          priority: "high",
          context: { worktreeId, eventKind: "git" },
        });
      }
      return;
    }
    handleDeleteFailure(get, set, worktreeId, options, mutationId, message);
  }
}

/** Remove an outbox entry by mutationId. Used on success and on partial
 *  success. No-op when the entry is already gone (a concurrent
 *  `pruneAcknowledgedMutations` may have removed it). */
function pruneOutboxEntry(
  get: WorktreeMutationGet,
  set: WorktreeMutationSet,
  mutationId: string
): void {
  const prev = get();
  if (!prev.mutationOutbox.has(mutationId)) return;
  const next = new Map(prev.mutationOutbox);
  next.delete(mutationId);
  set({ mutationOutbox: next });
}

/** Classify a delete failure and update the outbox entry accordingly.
 *
 *  Three branches:
 *   1. **Connectivity** — port not ready / host exited. Leave the entry as
 *      `pending` (no retry-cap charge) so the reconnect-driven replay fires.
 *      The card surface flips back to idle so the user isn't stuck looking at
 *      a spinner during the reconnect window; the persistent error indicator
 *      is the workspace-host reconnecting state itself, not the card.
 *   2. **Permanent** — uncommitted changes, main worktree, etc. Flip the
 *      entry to `failed` (no retry) and surface the error on the card.
 *   3. **Generic** — anything else. Increment the retry counter. If still
 *      under the cap, leave as `pending`; otherwise flip to `failed`. */
function handleDeleteFailure(
  get: WorktreeMutationGet,
  set: WorktreeMutationSet,
  worktreeId: string,
  options: WorktreeDeleteOptions,
  mutationId: string,
  message: string
): void {
  const prev = get();
  const entry = prev.mutationOutbox.get(mutationId);
  const isConnectivity = isConnectivityError(message);
  const isPermanent = !isConnectivity && isPermanentDeleteError(message);

  const nextDeletingIds = new Set(prev.deletingIds);
  nextDeletingIds.delete(worktreeId);

  if (isConnectivity) {
    // Card returns to idle; outbox entry stays `pending` for the reconnect
    // replay to pick up. Surface no per-card error — the global
    // workspace-host reconnect indicator covers it.
    const nextOutbox = entry ? new Map(prev.mutationOutbox) : prev.mutationOutbox;
    if (entry) {
      nextOutbox.set(mutationId, {
        ...entry,
        status: "pending",
        lastError: message,
      });
    }
    set({
      deletingIds: nextDeletingIds,
      mutationOutbox: nextOutbox,
    });
    return;
  }

  const nextDeleteErrors = new Map(prev.deleteErrors);
  nextDeleteErrors.set(worktreeId, message);
  const nextDeleteErrorArgs = new Map(prev.deleteErrorArgs);
  nextDeleteErrorArgs.set(worktreeId, options);

  if (!entry) {
    // No outbox entry — shouldn't happen since `startDelete` always creates
    // one, but defensive: still surface the error on the card. Nothing will
    // auto-retry this delete, so bring the closed terminals back (#11344).
    consumeTerminalRestore(worktreeId, mutationId);
    set({
      deletingIds: nextDeletingIds,
      deleteErrors: nextDeleteErrors,
      deleteErrorArgs: nextDeleteErrorArgs,
    });
    return;
  }

  const nextOutbox = new Map(prev.mutationOutbox);
  const nextRetryCount = isPermanent ? entry.retryCount : entry.retryCount + 1;
  const exceededCap = nextRetryCount >= OUTBOX_RETRY_CAP;
  const nextStatus: MutationOutboxEntry["status"] =
    isPermanent || exceededCap ? "failed" : "pending";
  nextOutbox.set(mutationId, {
    ...entry,
    status: nextStatus,
    retryCount: nextRetryCount,
    lastError: message,
  });

  // Only a `failed` delete is definitively abandoned; a `pending` one will be
  // replayed (reconnect or generic retry), so relaunching now would flicker the
  // terminals and re-close them on the next attempt. Restore solely on the
  // terminal transition (#11344).
  if (nextStatus === "failed") consumeTerminalRestore(worktreeId, mutationId);

  set({
    deletingIds: nextDeletingIds,
    deleteErrors: nextDeleteErrors,
    deleteErrorArgs: nextDeleteErrorArgs,
    mutationOutbox: nextOutbox,
  });
}

/**
 * Fire-and-forget attach/detach-issue async chain (#9163). Mirrors
 * `runDeleteAsync`'s store-driven shape so it survives a host crash via the
 * outbox, but differs in two ways grounded in where the data lives:
 *
 *  1. **No host ack event.** `worktreeIssueMap` is a main-process Electron-store
 *     write (not host-owned like `git worktree remove`), so there is no
 *     `worktree-removed`-style push to wait on. The resolved IPC promise IS the
 *     ack, so success applies the local association and prunes the entry here.
 *  2. **No rollback / partial-success path.** The local association is applied
 *     only on success (the renderer never gets ahead of the store), so a
 *     failed or abandoned mutation needs nothing unwound — eliminating the
 *     silent desync this fixes at the root.
 *
 * Uses `get()` at the point of use (never a captured closure) so a replay after
 * reconnect reads the freshest state (lesson #5087).
 */
export async function runIssueMutationAsync(
  get: WorktreeMutationGet,
  set: WorktreeMutationSet,
  entry: AttachIssueOutboxEntry | DetachIssueOutboxEntry
): Promise<void> {
  const { worktreeId, type } = entry;
  try {
    if (type === "attach-issue") {
      await worktreeClient.attachIssue(entry.payload);
    } else {
      await worktreeClient.detachIssue(worktreeId);
    }
    applyIssueMutationSuccess(get, set, entry);
  } catch (err) {
    const message = formatErrorMessage(
      err,
      type === "attach-issue" ? "Failed to attach issue" : "Failed to unlink issue"
    );
    handleIssueFailure(get, set, entry, message);
  }
}

/** Apply the authoritative local association now that the store write landed,
 *  then prune the outbox entry and clear the in-flight guard / any error. */
function applyIssueMutationSuccess(
  get: WorktreeMutationGet,
  set: WorktreeMutationSet,
  entry: AttachIssueOutboxEntry | DetachIssueOutboxEntry
): void {
  const prev = get();
  const { worktreeId, mutationId } = entry;
  // Superseded mid-flight: the entry was pruned (worktree removed, or the user
  // dismissed it) while the IPC was outstanding, so this result is moot. Don't
  // write a stale `manualAssociations` entry for a worktree that may be gone —
  // the pruning path already cleared the in-flight guard and any error.
  if (!prev.mutationOutbox.has(mutationId)) return;
  const existing = prev.worktrees.get(worktreeId);

  let nextManual = prev.manualAssociations;
  let nextWorktrees = prev.worktrees;
  if (entry.type === "attach-issue") {
    // Record the manual association + re-merge the snapshot so it survives the
    // next `worktree-update` (which carries only auto-detected issue state).
    const assoc: ManualIssueAssociation = {
      issueNumber: entry.payload.issueNumber,
      issueTitle: entry.payload.issueTitle,
      ...pickIssueProvenance(entry.payload),
    };
    nextManual = new Map(prev.manualAssociations);
    nextManual.set(worktreeId, assoc);
    if (existing) {
      nextWorktrees = new Map(prev.worktrees);
      nextWorktrees.set(worktreeId, mergeIssueState(existing, existing, assoc));
    }
  } else {
    if (prev.manualAssociations.has(worktreeId)) {
      nextManual = new Map(prev.manualAssociations);
      nextManual.delete(worktreeId);
    }
    if (existing && (existing.issueNumber !== undefined || existing.issueTitle !== undefined)) {
      nextWorktrees = new Map(prev.worktrees);
      nextWorktrees.set(worktreeId, {
        ...existing,
        issueNumber: undefined,
        issueTitle: undefined,
        issueProviderId: undefined,
        issueId: undefined,
        issueKey: undefined,
      });
    }
  }

  const nextOutbox = prev.mutationOutbox.has(mutationId)
    ? new Map(prev.mutationOutbox)
    : prev.mutationOutbox;
  if (prev.mutationOutbox.has(mutationId)) nextOutbox.delete(mutationId);
  const nextIssueMutatingIds = prev.issueMutatingIds.has(worktreeId)
    ? new Set(prev.issueMutatingIds)
    : prev.issueMutatingIds;
  if (prev.issueMutatingIds.has(worktreeId)) nextIssueMutatingIds.delete(worktreeId);
  const nextIssueErrors = prev.issueErrors.has(worktreeId)
    ? new Map(prev.issueErrors)
    : prev.issueErrors;
  if (prev.issueErrors.has(worktreeId)) nextIssueErrors.delete(worktreeId);

  set({
    manualAssociations: nextManual,
    worktrees: nextWorktrees,
    mutationOutbox: nextOutbox,
    issueMutatingIds: nextIssueMutatingIds,
    issueErrors: nextIssueErrors,
  });
}

/** Classify an attach/detach-issue failure (#9163).
 *
 *  - **Connectivity** — host exited / port down. Leave the entry `pending` for
 *    the reconnect replay; no banner (the global reconnect indicator covers it).
 *  - **Generic** — anything else. The issue-map write is a key-value store
 *    write with no deterministic "permanent" failure class (unlike delete's
 *    "uncommitted changes"), so every non-connectivity error retries up to the
 *    cap, then flips to `failed`. The banner is surfaced immediately so the
 *    user sees the failure even while the entry is still retry-eligible. */
function handleIssueFailure(
  get: WorktreeMutationGet,
  set: WorktreeMutationSet,
  entry: AttachIssueOutboxEntry | DetachIssueOutboxEntry,
  message: string
): void {
  const { worktreeId, mutationId, type } = entry;
  const prev = get();
  const current = prev.mutationOutbox.get(mutationId);
  // Superseded mid-flight (worktree removed, or the entry dismissed): the
  // failure is moot and the pruning path already cleared the in-flight guard
  // and any error. Don't resurrect a banner for a worktree that may be gone.
  if (!current) return;
  const isConnectivity = isConnectivityError(message);

  const nextIssueMutatingIds = new Set(prev.issueMutatingIds);
  nextIssueMutatingIds.delete(worktreeId);

  if (isConnectivity) {
    const nextOutbox = new Map(prev.mutationOutbox);
    nextOutbox.set(mutationId, { ...current, status: "pending", lastError: message });
    set({ issueMutatingIds: nextIssueMutatingIds, mutationOutbox: nextOutbox });
    return;
  }

  const nextIssueErrors = new Map(prev.issueErrors);
  nextIssueErrors.set(worktreeId, { message, type, mutationId });

  const nextRetryCount = current.retryCount + 1;
  const exceededCap = nextRetryCount >= OUTBOX_RETRY_CAP;
  const nextOutbox = new Map(prev.mutationOutbox);
  nextOutbox.set(mutationId, {
    ...current,
    status: exceededCap ? "failed" : "pending",
    retryCount: nextRetryCount,
    lastError: message,
  });
  set({
    issueMutatingIds: nextIssueMutatingIds,
    issueErrors: nextIssueErrors,
    mutationOutbox: nextOutbox,
  });
}
