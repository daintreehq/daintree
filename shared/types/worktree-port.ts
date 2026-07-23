/**
 * Typed RPC protocol for the dedicated worktree MessagePort transport.
 *
 * Each entry in `WorktreePortProtocol` defines the payload accepted and the
 * result returned for a single action. `WorktreePortRequest` is the derived
 * discriminated union consumed by the workspace-host dispatcher; the renderer
 * client (`WorktreePortClient.request<K>`) indexes the protocol map directly
 * to infer per-action payload and result types.
 *
 * The wire framing (`{ id, action, payload }` request, `{ id, result | error }`
 * response) is unchanged — these types are compile-time only.
 */

import type {
  CreateWorktreeOptions,
  WorktreeSnapshot,
  WorktreeEventVersion,
} from "./workspace-host.js";
import type { WorktreeChanges } from "./git.js";

export type WorktreePortResourceAction = "provision" | "teardown" | "resume" | "pause" | "status";

export interface WorktreePortProtocol {
  "get-all-states": {
    payload: Record<string, never>;
    // Carries the host's current version stamp so the renderer can anchor its
    // comparison baseline to the host's actual `(epoch, seq)` position rather
    // than a renderer-minted counter (#8403). `seq` is the high-water mark at
    // snapshot time — a state description, not a new event.
    // `watcherDegraded` hydrates the persistent watcher-degraded indicator on
    // late-mounting views without waiting for a live event (#8413).
    // `topologyWatcherDark` hydrates the parallel topology-watcher-dark
    // indicator the same way (#9908) — true when the topology watcher's
    // subscribe() failed or a safety valve expired and no reconcile has since
    // verified the worktree list.
    // `lastAcknowledgedMutationIds` carries the host's epoch-scoped set of
    // successfully acknowledged mutation IDs so the renderer's mutation outbox
    // can prune entries that landed before a host crash without replaying them
    // (#8405). Empty array on a fresh epoch — the host's ack map starts clean
    // because mutationIds are minted per-attempt and don't cross host restarts.
    result: {
      states: WorktreeSnapshot[];
      watcherDegraded: boolean;
      topologyWatcherDark: boolean;
      lastAcknowledgedMutationIds: string[];
    } & WorktreeEventVersion;
  };
  "set-active": {
    payload: { worktreeId: string };
    result: { ok: true };
  };
  // Full-replacement set of worktree IDs that currently have an agent
  // actively producing work (agentState working/directing). The host elevates
  // these monitors to the recursive watcher tier so their working-tree edits
  // stream to the dashboard while backgrounded. Sent debounced by the
  // renderer whenever the set changes, and re-sent after host restart.
  "set-agent-activity": {
    payload: { worktreeIds: string[] };
    result: { ok: true };
  };
  refresh: {
    payload: { worktreeId?: string };
    // `ok: false` (+ message) when the host's bounded refresh trips its overall
    // watchdog, so the renderer can surface a real failure instead of treating
    // every reply as success. The request still resolves (it only rejects on
    // transport timeout / host exit).
    result: { ok: boolean; error?: string };
  };
  "create-worktree": {
    payload: { rootPath: string; options: CreateWorktreeOptions };
    result: { ok: true };
  };
  "delete-worktree": {
    // `mutationId` is the renderer's stable identifier for a single user-intent
    // delete (#8405). Carrying it across retries lets the host dedupe replays
    // that arrive after a crash + reconnect — the host's ack map keys on it so
    // a second invocation with the same id is short-circuited to a success
    // ack without re-running `git worktree remove`. Optional so non-outbox
    // callers (e.g. integration tests) keep working without minting an id.
    payload: { worktreeId: string; force?: boolean; deleteBranch?: boolean; mutationId?: string };
    result: { ok: true };
  };
  "list-branches": {
    payload: { rootPath: string };
    result: { ok: true };
  };
  "get-recent-branches": {
    payload: { rootPath: string };
    result: { ok: true };
  };
  "refresh-prs": {
    payload: Record<string, never>;
    result: { ok: true };
  };
  // Forces an immediate topology reconcile (full worktree re-discovery),
  // independent of the watcher. Backs the "Reconcile now" recovery action for
  // the topology-watcher-dark state (#9908). `force` (user-initiated recovery)
  // bypasses the post-reconcile cooldown and the `pollingEnabled` gate so an
  // explicit request is never silently coalesced away.
  "reconcile-topology": {
    payload: { force?: boolean };
    result: { ok: true };
  };
  "resource-action": {
    payload: { worktreeId: string; action: WorktreePortResourceAction };
    result: { ok: true };
  };
  "run-lifecycle-setup": {
    payload: { worktreeId: string };
    result: { ok: true };
  };
  "switch-worktree-environment": {
    payload: { worktreeId: string; envKey: string };
    result: { ok: true };
  };
  "has-resource-config": {
    payload: { rootPath: string };
    result: { hasConfig: boolean };
  };
  // On-demand FRESH git-status read for a single worktree. Forces the monitor
  // to re-run `git status` (bypassing the adaptive-poll cache) and returns the
  // resulting change set directly in the response. Safety-critical for the
  // delete-confirm surfaces (#11343): the delete dialog and the MCP confirm
  // must decide the D2/D3 tier from live changes, not a snapshot that can be
  // ~30s stale for a backgrounded worktree. Returning the changes in the reply
  // (rather than relying on the broadcast → store round-trip, which crosses a
  // different channel and can land after the reply) keeps the read race-free.
  // `null` when no monitor exists for the id (already removed).
  "get-worktree-changes": {
    payload: { worktreeId: string };
    result: { changes: WorktreeChanges | null };
  };
}

export type WorktreePortAction = keyof WorktreePortProtocol;

export type WorktreePortPayload<K extends WorktreePortAction> = WorktreePortProtocol[K]["payload"];

export type WorktreePortResult<K extends WorktreePortAction> = WorktreePortProtocol[K]["result"];

export type WorktreePortRequest = {
  [K in WorktreePortAction]: {
    id: string;
    action: K;
    payload: WorktreePortPayload<K>;
  };
}[WorktreePortAction];

/**
 * Rest-args tuple that makes `payload` optional only when an empty object is
 * assignable to the action's payload (i.e. all fields optional, or
 * `Record<string, never>`). Required-field payloads (e.g. `set-active`) become
 * a compile error if omitted.
 */
export type WorktreePortRequestArgs<K extends WorktreePortAction> =
  Record<string, never> extends WorktreePortPayload<K>
    ? [payload?: WorktreePortPayload<K>]
    : [payload: WorktreePortPayload<K>];
