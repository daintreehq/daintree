import { createContext, useEffect, useState, startTransition, type ReactNode } from "react";
import {
  createWorktreeStore,
  setCurrentViewStore,
  compareVersion,
  type WorktreeViewStoreApi,
} from "@/store/createWorktreeStore";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import type { CIStatusState } from "@shared/types/forge";
import type { PluginWorktreeLinked } from "@shared/types/plugin";
import {
  useWorktreeSelectionStore,
  getDeletedWorktreeTerminalIds,
  createDeletedWorktreeRecord,
} from "@/store/worktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { startDeletedWorktreeCleanup } from "@/store/deletedWorktreeCleanup";
import { usePulseStore } from "@/store/pulseStore";
import { useProjectStore } from "@/store/projectStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import {
  repaintActiveWorktreeTerminals,
  wakeActiveWorktreeTerminals,
} from "@/store/wakeActiveWorktreeTerminals";
import { worktreeClient } from "@/clients/worktreeClient";
import { PERF_MARKS } from "@shared/perf/marks";
import { flushPendingPerfMarks } from "@/utils/performance";
import { markSwitch, setActiveSwitchTrace } from "@/utils/switchTrace";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";

// How long the topology watcher may stay dark before we escalate from the
// Tier-1 ambient pip to a Tier-3 low-priority inbox notification (#9908). The
// 90s host safety net usually reconciles first; this only fires when recovery
// genuinely stalls, per the CLAUDE.md runtime-signals promote-trigger.
const TOPOLOGY_DARK_ESCALATION_MS = 30_000;

// The first worktree fetch is triggered by the worktree port becoming ready,
// and nothing bounds that wait: when main never brokers a port, `isLoading`
// stays true and the sidebar renders its skeleton forever with no way to reach
// the error banner (#11818). Main now reports every no-port outcome it can see,
// but the report itself can still be lost (app view swapped mid-boot, renderer
// listener not yet wired), so this is the renderer's own floor under the hang.
// Longer than the 30s a single workspace-host command may take, so a slow but
// healthy packaged-Windows cold start is never cut short.
const INITIAL_PORT_READY_TIMEOUT_MS = 45_000;

// Owned by this file so the ready-after-timeout path can tell its own message
// apart from a newer one main pushed, and clear only the former.
const INITIAL_PORT_TIMEOUT_MESSAGE =
  "The workspace service didn't finish connecting, so worktrees couldn't load.";

export const WorktreeStoreContext = createContext<WorktreeViewStoreApi | null>(null);

interface WorktreeUpdateEvent {
  type: "worktree-update";
  worktree: WorktreeSnapshot;
  epoch: string;
  seq: number;
}

interface WorktreeRemovedEvent {
  type: "worktree-removed";
  worktreeId: string;
  epoch: string;
  seq: number;
  generation?: number;
}

interface PRDetectedEvent {
  type: "pr-detected";
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: "open" | "merged" | "closed";
  prCiStatus?: CIStatusState;
  prTitle?: string;
  issueNumber?: number;
  issueTitle?: string;
  prLastUpdatedAt?: number;
  issueLastUpdatedAt?: number;
  branchName?: string;
  providerId?: string;
  linked?: PluginWorktreeLinked | null;
}

interface PRClearedEvent {
  type: "pr-cleared";
  worktreeId: string;
  branchName?: string;
}

interface IssueDetectedEvent {
  type: "issue-detected";
  worktreeId: string;
  issueNumber: number;
  issueTitle: string;
  issueLastUpdatedAt?: number;
  branchName?: string;
  providerId?: string;
  linked?: PluginWorktreeLinked | null;
}

interface IssueNotFoundEvent {
  type: "issue-not-found";
  worktreeId: string;
  issueNumber: number;
}

// Drop overlays whose lookup branch no longer matches the worktree's current
// branch — they raced against a branch change and would corrupt the row.
// Treat undefined on either side as "allow" (older host code may omit the
// field, and detached HEAD has no branch to compare against).
function branchesMatch(
  eventBranch: string | undefined,
  currentBranch: string | undefined
): boolean {
  if (eventBranch === undefined || currentBranch === undefined) return true;
  return eventBranch === currentBranch;
}

// Overlay events (pr/issue detection) are renderer-synthesized — the host
// mints no `(epoch, seq)` for them. Reuse the CURRENT stamp rather than
// advancing the seq: the store accepts an equal same-epoch version (the guard
// rejects only strictly-older), so the targeted field merge lands without
// claiming a seq the host will later emit. Advancing it would shadow the real
// host event that lands on that exact seq (#8403 review finding #3). A later
// higher-seq host update or epoch transition still supersedes the overlay.
function overlayVersion(current: WorktreeEventVersion): WorktreeEventVersion {
  return { epoch: current.epoch, seq: current.seq };
}

interface WorktreeActivatedEvent {
  type: "worktree-activated";
  worktreeId: string;
}

export function WorktreeStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState<WorktreeViewStoreApi>(() => createWorktreeStore());

  // Register module-level store reference for non-React code (action definitions, services)
  useEffect(() => {
    setCurrentViewStore(store);
  }, [store]);

  useEffect(() => {
    const { worktreePort } = window.electron;
    const cleanups: Array<() => void> = [];
    let generation = 0;

    // Topology-watcher-dark escalation (#9908): the store flag (set on the live
    // event or hydration) drives the Tier-1 pip immediately; if the dark state
    // persists past TOPOLOGY_DARK_ESCALATION_MS without a reconcile clearing it,
    // escalate to a Tier-3 low-priority inbox notification with "Reconcile now".
    // Armed from both the live `topology-watcher-dark` event and the
    // get-all-states hydration (a view that mounts while already dark).
    let topologyEscalationTimer: ReturnType<typeof setTimeout> | null = null;
    function clearTopologyEscalation() {
      if (topologyEscalationTimer !== null) {
        clearTimeout(topologyEscalationTimer);
        topologyEscalationTimer = null;
      }
    }
    function armTopologyEscalation() {
      if (topologyEscalationTimer !== null) return;
      topologyEscalationTimer = setTimeout(() => {
        topologyEscalationTimer = null;
        // Re-check: a reconcile may have cleared the dark state in the window.
        if (!store.getState().topologyWatcherDark) return;
        const projectId = useProjectStore.getState().currentProject?.id;
        notify({
          type: "warning",
          priority: "low",
          title: "Worktree list may be stale",
          message:
            "The worktree watcher stopped reporting changes, so new or removed worktrees might be missing. Reconcile to refresh the list.",
          action: {
            label: "Reconcile now",
            actionId: "worktree.reconcileTopology",
            onClick: () => {
              void actionService.dispatch("worktree.reconcileTopology", undefined, {
                source: "user",
              });
            },
          },
          supersedeKey: projectId ? `topology-watcher-dark:${projectId}` : "topology-watcher-dark",
          context: { projectId, eventKind: "host" },
        });
      }, TOPOLOGY_DARK_ESCALATION_MS);
    }

    function fetchInitialState() {
      generation += 1;
      const thisGen = generation;
      // Only show loading spinner on cold start (no cached data).
      // Wake refreshes should be silent — users see existing cached data.
      const isWake = store.getState().isInitialized;
      if (!isWake) {
        store.getState().setLoading(true);
      }

      // Replay-on-wake: the circuit breaker is pushed via `pr-detection-state`,
      // but a view that wakes after it tripped would miss that push. Re-seed
      // from the request-response status. Fire-and-forget and non-critical —
      // on failure the store stays `false` and the next push corrects it.
      void worktreeClient
        .getPRStatus()
        .then((status) => {
          if (thisGen !== generation) return;
          usePRCircuitBreakerStore.getState().setTripped(status?.circuitBreakerTripped ?? false);
        })
        .catch(() => {
          /* non-critical — next pr-detection-state push corrects it */
        });

      // Manual issue associations live in the electron store, not the
      // workspace host — fetch them concurrently with the `get-all-states`
      // round-trip instead of serializing behind it. The `.catch` at creation
      // is load-bearing twice over: it preserves the #8079 "undefined = keep
      // cached associations" failure semantics, and it prevents an unhandled
      // rejection when the handler below returns early (generation/isReady
      // guards) and never awaits the promise.
      const associationsPromise = worktreeClient.getAllIssueAssociations().catch(() => undefined);

      worktreePort
        .request("get-all-states")
        .then(
          async (response: {
            states: WorktreeSnapshot[];
            epoch: string;
            seq: number;
            watcherDegraded: boolean;
            topologyWatcherDark: boolean;
            // Set of mutation IDs the host has already acknowledged this epoch
            // (#8405). Empty on a fresh host run — the renderer's outbox
            // entries from a prior epoch will have their targets reconciled
            // against the snapshot rather than matched against ack ids.
            lastAcknowledgedMutationIds?: string[];
          }) => {
            if (thisGen !== generation) return;

            // Hydrate the persistent watcher-degraded indicator from the
            // handshake so a late-mounting view reflects current state without
            // waiting for a live event. Set before the associations await so a
            // degradation/recovery event delivered during that await wins over
            // this now-stale snapshot value.
            store.getState().setWatcherDegraded(response.watcherDegraded ?? false);
            // Hydrate the parallel topology-watcher-dark indicator the same way
            // (#9908), before the await, for the same race reason. A view that
            // mounts while the host is already dark must also arm the 30s
            // escalation — the live event that would otherwise arm it already
            // fired before this view existed.
            const hydratedDark = response.topologyWatcherDark ?? false;
            store.getState().setTopologyWatcherDark(hydratedDark);
            if (hydratedDark) {
              armTopologyEscalation();
            } else {
              clearTopologyEscalation();
            }

            // Hydrate manual issue associations from electron store.
            // Auto-detected issues (from branch names) arrive in the snapshots,
            // but user-attached associations are stored separately and must
            // survive subsequent `worktree-update` events (#8079). The store
            // merges them (MANUAL_OVER_AUTO) and caches the map so later events
            // can re-merge without another IPC round-trip.
            const states = response.states;
            // The host stamps this response with its current `(epoch, seq)`
            // high-water mark, so the snapshot version is fixed at request time
            // — no renderer-side minting. A `worktree-update` delivered during
            // the association await carries a strictly higher host `seq` (same
            // epoch) and `applySnapshot`'s own compare guard rejects this older
            // snapshot, so the live update is never reverted (#8079, #8403).
            const snapshotVersion: WorktreeEventVersion = {
              epoch: response.epoch,
              seq: response.seq,
            };

            // `undefined` (not `{}`) means "couldn't load — keep whatever's
            // cached". An empty object means "authoritatively no associations".
            // Defaulting to `{}` on failure would wipe cached manual
            // associations on a transient IPC error (#8079 review).
            const associations = await associationsPromise;
            if (thisGen !== generation) return;

            // If the host crashed during the associations fetch (a separate IPC
            // that port-close cannot reject), skip applySnapshot so it does not
            // spuriously clear the Reconnecting… indicator.  The next onReady
            // cycle will deliver fresh data.
            if (!worktreePort.isReady()) return;

            // A `worktree-update` raced ahead during the association fetch and
            // advanced the store STRICTLY past this snapshot (same epoch, higher
            // seq). Don't revert it. An equal seq is the host's authoritative
            // state at the same boundary (`get-all-states` reports the high-water
            // seq without advancing), so it must still apply — otherwise cold
            // start never initializes and an epoch-change re-hydrate is silently
            // swallowed (#8403 review findings #1, #2). A differing epoch means
            // the host restarted and always wins. On cold start we still must
            // hydrate, so retry (the generation guard prevents stale overlaps).
            if (compareVersion(snapshotVersion, store.getState().version) < 0) {
              if (!store.getState().isInitialized) fetchInitialState();
              return;
            }

            // Wrap the wholesale Map replacement in a transition so the
            // cascade of `useSyncExternalStore` worktree subscribers re-renders
            // at non-urgent priority instead of synchronously blocking the
            // event that delivered the snapshot (#8403).
            startTransition(() => {
              store.getState().applySnapshot(states, snapshotVersion, associations);
            });

            // Mutation-outbox reconcile + replay (#8405). Order matters: prune
            // FIRST so an ack the renderer missed (host crashed between
            // `git worktree remove` and the result ack) doesn't get replayed.
            // Then replay the survivors when either (a) this is a wake
            // reconnect (epoch transition with a previously-initialized store)
            // OR (b) there are outbox entries to replay — the second condition
            // is critical for the manual-restart-after-fatal-error path, where
            // `setFatalError` reset `isInitialized` to false so `isWake` is
            // false on the post-restart fetch (#8405 review finding #2). Pure
            // cold starts can't have outbox entries from this session anyway,
            // so the `mutationOutbox.size > 0` check costs nothing in that
            // case. Both calls run outside the startTransition above so they
            // aren't batched into the non-urgent render priority.
            store.getState().pruneAcknowledgedMutations(response.lastAcknowledgedMutationIds ?? []);
            if (isWake || store.getState().mutationOutbox.size > 0) {
              store.getState().replayOutboxAfterReconnect();
            }

            // Mirror the per-event resolve below: a snapshot delivered after a
            // host crash / port reconnect may carry the freshly created worktree
            // without firing the per-id `worktree-update` event the placeholder
            // normally listens for. Without this, the skeleton row would stay
            // stuck in "creating" indefinitely. resolvePendingCreation is a
            // no-op when no entry matches, so iterating every state is cheap.
            const selectionStore = useWorktreeSelectionStore.getState();
            for (const snap of states) {
              selectionStore.resolvePendingCreation(snap.id);
            }
          }
        )
        .catch((err: Error) => {
          if (thisGen !== generation) return;
          // On wake, preserve existing data — don't show error screen
          if (!isWake) {
            store.getState().setError(err.message);
            store.getState().setLoading(false);
          }
        });
    }

    cleanups.push(
      worktreePort.onEvent("worktree-update", (data) => {
        const event = data as WorktreeUpdateEvent;
        const prevEpoch = store.getState().version.epoch;
        // A differing epoch means the workspace host restarted. The event
        // carries valid state and is applied (a new epoch always wins the
        // compare), then we re-hydrate from a fresh snapshot to recover
        // anything the restart's seq reset would otherwise have hidden.
        // prevEpoch === "" is the pre-hydration baseline, not a restart.
        const epochChanged = event.epoch !== prevEpoch && prevEpoch !== "";
        const applied = store
          .getState()
          .applyUpdate(event.worktree, { epoch: event.epoch, seq: event.seq });
        if (epochChanged) fetchInitialState();

        // A rejected event describes a worktree that is NOT in the map — a
        // stale stamp, a superseded monitor incarnation, or an active removal
        // tombstone. Resolving the placeholder and running the pending
        // selection policy anyway is what made the swallowed create silent:
        // the "Creating…" row vanished with no worktree and no error (#11994).
        if (!applied) return;

        // Side effect: sync pending worktree selection
        const selectionStore = useWorktreeSelectionStore.getState();
        if (selectionStore.pendingWorktreeId === event.worktree.id) {
          selectionStore.applyPendingWorktreeSelection(event.worktree.id);
        }

        // Side effect: clear sidebar placeholder once the real worktree arrives.
        // Idempotent — the action is a no-op when no entry matches the id, so
        // unrelated worktree-update events cost nothing.
        selectionStore.resolvePendingCreation(event.worktree.id);
      })
    );

    cleanups.push(
      worktreePort.onEvent("worktree-removed", (data) => {
        const event = data as WorktreeRemovedEvent;
        const prevEpoch = store.getState().version.epoch;
        const epochChanged = event.epoch !== prevEpoch && prevEpoch !== "";
        const { worktrees } = store.getState();
        const worktree = worktrees.get(event.worktreeId);

        // Block removal of main worktree (but still re-hydrate on a host
        // restart so the rest of the tree converges on fresh state).
        if (worktree?.isMainWorktree) {
          console.warn("[WorktreeStore] Attempted to remove main worktree - blocked", {
            worktreeId: event.worktreeId,
            branch: worktree.branch,
          });
          if (epochChanged) fetchInitialState();
          return;
        }

        store
          .getState()
          .applyRemove(event.worktreeId, { epoch: event.epoch, seq: event.seq }, event.generation);
        if (epochChanged) fetchInitialState();

        // applyRemove version-gates internally but returns void: a stale
        // same-epoch replay leaves the worktree in the map. Selection and
        // ghost side effects must not run on a rejected event — a replay
        // would otherwise demote the restore target or clear the selection
        // for a worktree that still exists. Cross-epoch events keep the old
        // behavior: the refetch reconciles the map, and the ghost row must
        // still be recorded for survivors of a removal across a host restart.
        if (!epochChanged && store.getState().worktrees.has(event.worktreeId)) {
          return;
        }

        // Side effect: invalidate pulse cache
        usePulseStore.getState().invalidate(event.worktreeId);

        // Side effect: selection handling for the removed worktree. When
        // terminals survive, the id lives on as a ghost row and the user may
        // be mid-cleanup on it — deleting must NOT yank them away, so the
        // selection stays put and useActiveWorktreeSync falls back to main
        // only once the ghost row itself is gone (last terminal closed, row
        // dismissed, or auto-cleanup fired). Only the durable restore target
        // is demoted (below) — a deleted id must never persist across
        // restarts. With no survivors there is nothing left to look at, so
        // the selection clears immediately as before.
        const selectionStore = useWorktreeSelectionStore.getState();
        const willBecomeGhost =
          !!worktree && getDeletedWorktreeTerminalIds(event.worktreeId).length > 0;
        // A removed id must never remain the durable restore target — ghost
        // or not, it can't be restored after a restart. No-ops unless the id
        // IS the restore target (or its fleet-parked snapshot).
        selectionStore.clearRestoreTarget(event.worktreeId);
        // `deletedWorktrees.has` guards a duplicate removal event for an id
        // that is already a ghost (snapshot lookup misses → willBecomeGhost
        // false): the live ghost row must not lose the selection to a replay.
        if (
          selectionStore.activeWorktreeId === event.worktreeId &&
          !willBecomeGhost &&
          !selectionStore.deletedWorktrees.has(event.worktreeId)
        ) {
          selectionStore.setActiveWorktree(null);
        }

        // Side effect: hand surviving terminals to a deleted-worktree row (#11232).
        //
        // Removing the worktree used to remove every panel that belonged to
        // it, which destroyed live agent sessions — worst of all when an agent
        // deleted its own worktree mid-conversation via `worktree.delete` and
        // killed itself. "Worktree gone" and "PTY dead" are independent facts
        // with independent owners (#11083), so the panels are left completely
        // untouched here: their processes keep running, and the deleted-worktree row only
        // gives them somewhere to live in the sidebar until the user drags
        // them to another worktree, dismisses the row, or its auto-cleanup
        // countdown moves them to trash (deletedWorktreeCleanup.ts).
        //
        // Metadata is snapshotted from `worktree`, read above *before*
        // `applyRemove` dropped it from the live map. Both delete entry points
        // (the delete dialog and the `worktree.delete` action) funnel through
        // this event, so they get identical behaviour from this one change.
        // Ordinarily a no-op by the time it runs: `applyRemove` above fires the
        // map-diff subscription synchronously, and that backstop has already
        // recorded this row from the outgoing snapshot. It still matters for
        // the removals the backstop cannot see — an id already absent from the
        // map, which is how an externally-removed worktree usually arrives —
        // and `createDeletedWorktreeRecord` keeps the two records identical, so
        // `addDeletedWorktree`'s first-write-wins never loses a field (#11911).
        if (willBecomeGhost) {
          selectionStore.addDeletedWorktree(
            createDeletedWorktreeRecord(event.worktreeId, {
              // Detached-HEAD worktrees have no branch; the helper falls back
              // to the folder name so the row always carries a recognisable
              // last-known title.
              title: worktree.branch,
              path: worktree.path,
              gitDir: worktree.gitDir,
            })
          );
        }
      })
    );

    // Deleted-worktree rows are derived state: they exist only while at least one panel
    // still points at the dead worktree. Watching the panel store (rather than
    // terminal lifecycle events) means every exit route prunes the row —
    // moved, trashed, killed, or exited alike. `agent:exited` notably never
    // fires for a killed terminal (#11110), so an event-driven version of this
    // would strand a deleted-worktree row holding zero terminals.
    cleanups.push(
      usePanelStore.subscribe((state, prevState) => {
        if (
          state.panelIdsByWorktreeId === prevState.panelIdsByWorktreeId &&
          state.panelsById === prevState.panelsById
        ) {
          return;
        }
        if (useWorktreeSelectionStore.getState().deletedWorktrees.size === 0) return;
        useWorktreeSelectionStore
          .getState()
          .pruneDeletedWorktrees(new Set(store.getState().worktrees.keys()));
      })
    );

    // Age-based auto-cleanup for deleted-worktree rows: arms/defers/fires each
    // row's countdown per the user's preference (see deletedWorktreeCleanup.ts).
    cleanups.push(startDeletedWorktreeCleanup());

    // Pulse-cache pruning backstop: the `worktree-removed` event invalidates a
    // single worktree, but `applySnapshot` on a host restart can replace the
    // whole `worktrees` Map with a smaller set WITHOUT firing per-id removal
    // events — leaving stale entries in pulseStore's worktree-keyed maps
    // (pulses/loading/errors/retry). Diff the Map on every state change and
    // invalidate any key that disappeared. `applyRemove`/`applySnapshot` always
    // build a fresh `new Map(...)` on real changes (the value-equality fast path
    // preserves the same ref), so the ref-equality guard reliably skips
    // unrelated-slice updates. `invalidate` is synchronous and functionally
    // idempotent — it clears whatever is present and corrupts nothing on an
    // already-clean key — so on a normal single removal the `worktree-removed`
    // event path and this subscription each fire it once for the same id
    // (the second call re-publishes correct state, nothing more) (#9536).
    //
    // The last topology the host actually reported, held so a not-ready `[]`
    // can't erase the baseline the removal diff below depends on. Scoped to
    // this effect, so a remount starts from the store's own state again.
    let lastReadyWorktrees: ReadonlyMap<string, WorktreeSnapshot> | null = null;
    cleanups.push(
      store.subscribe((state, prevState) => {
        if (state.worktrees === prevState.worktrees) return;
        // An empty incoming map is never a removal: a successful `git worktree
        // list` always reports at least the main worktree, so [] only ever
        // means the host isn't ready (#11235). Pulse invalidation is harmless
        // either way, but adopting off a not-ready read would ghost every live
        // worktree in the project at once.
        const removalsAreAuthoritative = state.worktrees.size > 0;
        for (const id of prevState.worktrees.keys()) {
          if (!state.worktrees.has(id)) usePulseStore.getState().invalidate(id);
        }
        if (!removalsAreAuthoritative) return;

        // Diff against the last READY topology, not simply the previous state.
        // A not-ready `[]` still replaces the live map, so comparing with
        // `prevState` would let a `[a, b] → [] → [a]` sequence lose `b`
        // entirely: the first step declines to adopt (correctly) and the second
        // compares against nothing. The removal would then never be observed
        // again, which is the bug this backstop exists to close.
        const baseline = lastReadyWorktrees ?? prevState.worktrees;
        lastReadyWorktrees = state.worktrees;

        // A worktree that merely moved reappears under a new path-derived id
        // while keeping its `.git/worktrees/<name>` handle (#11388) — and ids
        // can differ by spelling alone, since creation resolves symlinks and
        // enumeration does not. Ghosting one of those would hand a LIVE
        // worktree's agents to the cleanup sweep, which trashes them and lets
        // the trash TTL kill the PTYs. Absence of an id is not proof of
        // removal; a handle nothing claims is.
        const incomingGitDirs = new Set<string>();
        for (const worktree of state.worktrees.values()) {
          if (worktree.gitDir) incomingGitDirs.add(worktree.gitDir);
        }

        for (const id of baseline.keys()) {
          if (state.worktrees.has(id)) continue;

          // Same backstop, second symptom (#11911). A worktree that leaves the
          // map without a `worktree-removed` event strands every panel still
          // pointing at it: the sidebar groups by live worktree, so those
          // panels render nowhere, while their PTYs stay alive and keep
          // counting toward the project's attention tally. Adopting them onto
          // a deleted-worktree row is what gives them a home again — and what
          // lets `deletedWorktreeCleanup` eventually retire them, which it
          // could never do for a row that was never recorded.
          //
          // Also covers the event path's own blind spot: its ghost branch is
          // gated on the worktree still being in the live map, so an external
          // removal that reconciles the map first (topology watcher →
          // `applySnapshot`) reaches the handler with nothing left to read.
          //
          // The main worktree is exempt for the same reason the event handler
          // blocks it: it cannot legitimately be deleted, so its absence here
          // is a host restart mid-hydration, not a removal.
          const removed = baseline.get(id);
          if (removed?.isMainWorktree) continue;
          if (removed?.gitDir && incomingGitDirs.has(removed.gitDir)) continue;
          const selectionStore = useWorktreeSelectionStore.getState();
          if (selectionStore.deletedWorktrees.has(id)) continue;
          if (getDeletedWorktreeTerminalIds(id).length === 0) continue;
          // A deleted id must never survive as the durable restore target —
          // `deletedWorktrees` is in-memory, so it would resolve to nothing
          // after a restart. No-ops unless the id IS the target.
          selectionStore.clearRestoreTarget(id);
          // Branch and path come off the outgoing snapshot, which still holds
          // them here — so this record is identical to the one the event
          // handler would build, and first-write-wins costs nothing.
          selectionStore.addDeletedWorktree(
            createDeletedWorktreeRecord(id, {
              title: removed?.branch,
              path: removed?.path,
              gitDir: removed?.gitDir,
            })
          );
        }
        // A host restart can re-hydrate a worktree we had already deleted
        // (#11232). The real row wins — its terminals were never detached, so
        // the row would otherwise render a duplicate row for the same id.
        if (useWorktreeSelectionStore.getState().deletedWorktrees.size > 0) {
          useWorktreeSelectionStore
            .getState()
            .pruneDeletedWorktrees(new Set(state.worktrees.keys()), incomingGitDirs);
        }
      })
    );

    cleanups.push(
      worktreePort.onEvent("worktree-activated", (data) => {
        const event = data as WorktreeActivatedEvent;
        const selectionStore = useWorktreeSelectionStore.getState();
        // Skip the worktree-activated handler if the active id already
        // matches the event's id. The host's MessagePort echoes
        // `worktree-activated` for both Main-originated and host-originated
        // activations, and a redundant call into `selectWorktree(id)` (with
        // default source: "user") would update `restoreWorktreeId` and
        // persist the active id — breaking the focus-promotion invariant
        // (#9512) by pinning a focus-promoted id as the durable restore
        // target. The early-return preserves the already-active path; the
        // host-originated auto-switch case (the #9945 fix) is unaffected
        // because the active id has just been cleared to null by the
        // preceding `worktree-removed` event.
        if (selectionStore.activeWorktreeId === event.worktreeId) {
          return;
        }
        // Deleting the active worktree makes the host auto-switch to main and
        // echo that switch here — but a user standing on a worktree whose
        // terminals survive must stay on its ghost row, not get yanked to
        // main mid-cleanup. Two orderings exist: UI deletes emit
        // activated(main) BEFORE worktree-removed (the active worktree is
        // then mid-delete: `deletingIds`); external removals emit it AFTER
        // (the active id is then already a ghost row). Both suppress only
        // while terminals actually survive — a deletion with nothing left
        // follows the auto-switch as before.
        const activeId = selectionStore.activeWorktreeId;
        if (activeId !== null) {
          const isActiveGhost = selectionStore.deletedWorktrees.has(activeId);
          const isActiveDeleting = store.getState().deletingIds.has(activeId);
          if (
            (isActiveGhost || isActiveDeleting) &&
            getDeletedWorktreeTerminalIds(activeId).length > 0
          ) {
            return;
          }
        }
        selectionStore.setPendingWorktree(event.worktreeId);
        selectionStore.selectWorktree(event.worktreeId);
        if (store.getState().worktrees.has(event.worktreeId)) {
          selectionStore.applyPendingWorktreeSelection(event.worktreeId);
        }
      })
    );

    cleanups.push(
      worktreePort.onEvent("pr-detected", (data) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const event = data as PRDetectedEvent;
        const { worktrees } = store.getState();
        const existing = worktrees.get(event.worktreeId);
        if (!existing) return;
        if (!branchesMatch(event.branchName, existing.branch)) return;
        // Full-replace semantics for prCiStatus mirror the backend
        // (WorktreeMonitor.setPRInfo): undefined means "no checks", not
        // "preserve prior value." Merging with ?? would let stale CI rollups
        // linger after checks disappear. The transient phase-1 "no CI yet"
        // case is handled in the workspace host (it preserves the prior rollup
        // before emitting), so the renderer never sees a flicker-inducing
        // undefined here — see WorkspaceService.onPRDetected (#9551).
        store.getState().applyUpdate(
          {
            ...existing,
            prNumber: event.prNumber,
            prUrl: event.prUrl,
            prState: event.prState,
            prCiStatus: event.prCiStatus,
            prTitle: event.prTitle ?? existing.prTitle,
            issueNumber: event.issueNumber ?? existing.issueNumber,
            issueTitle: event.issueTitle ?? existing.issueTitle,
            prLastUpdatedAt: event.prLastUpdatedAt ?? existing.prLastUpdatedAt,
            issueLastUpdatedAt: event.issueLastUpdatedAt ?? existing.issueLastUpdatedAt,
            linked: event.linked ?? existing.linked,
          },
          overlayVersion(store.getState().version)
        );

        // No dropdown-cache patch here on purpose. This handler used to
        // one-way-write the renderer's forgeResourceCache to stop the sidebar
        // badge and the dropdown row drifting, but it never reached main's
        // forgePRListCache, so the next revalidate overwrote it with the coarse
        // rollup and the two surfaces disagreed again. Both now derive CI
        // status from one place — `listPRsImpl` enriches through the same
        // `getCIStatusesImpl`/`prRequiredStatusCache` this event's status comes
        // from — so the dropdown's own fetch already agrees (#11251).
      })
    );

    cleanups.push(
      worktreePort.onEvent("pr-cleared", (data) => {
        const event = data as PRClearedEvent;
        const { worktrees } = store.getState();
        const existing = worktrees.get(event.worktreeId);
        if (!existing) return;
        if (!branchesMatch(event.branchName, existing.branch)) return;
        // Mirror the host: clearing the PR drops the CI rollup too. Without
        // this, an early-startup window where monitor.hasInitialStatus is
        // false would skip the worktree-update path and leave prCiStatus
        // hanging without an associated PR.
        store.getState().applyUpdate(
          {
            ...existing,
            prNumber: undefined,
            prUrl: undefined,
            prState: undefined,
            prCiStatus: undefined,
            prTitle: undefined,
            prLastUpdatedAt: undefined,
            issueLastUpdatedAt: undefined,
            linked: existing.linked?.issue
              ? { providerId: existing.linked.providerId, issue: existing.linked.issue }
              : null,
          },
          overlayVersion(store.getState().version)
        );
      })
    );

    cleanups.push(
      worktreePort.onEvent("pr-detection-state", (data) => {
        // Service-wide ambient signal — not keyed to a worktree. Use
        // `.getState()` (not a captured ref) since this callback fires async.
        usePRCircuitBreakerStore.getState().setTripped((data as { tripped: boolean }).tripped);
      })
    );

    cleanups.push(
      worktreePort.onEvent("issue-detected", (data) => {
        const event = data as IssueDetectedEvent;
        const { worktrees } = store.getState();
        const existing = worktrees.get(event.worktreeId);
        if (!existing) return;
        if (!branchesMatch(event.branchName, existing.branch)) return;
        // `linked` is the source of truth — pass through the host-built
        // projection (carrying canonical providerId/owner/repo) rather than
        // re-synthesizing it with empty owner/repo (#8452). Full-replace, so
        // the host's preserved PR linkage isn't lost.
        store.getState().applyUpdate(
          {
            ...existing,
            issueNumber: event.issueNumber,
            issueTitle: event.issueTitle,
            issueLastUpdatedAt: event.issueLastUpdatedAt ?? existing.issueLastUpdatedAt,
            linked: event.linked ?? existing.linked,
          },
          overlayVersion(store.getState().version)
        );
      })
    );

    cleanups.push(
      worktreePort.onEvent("issue-not-found", (data) => {
        const event = data as IssueNotFoundEvent;
        // `applyIssueNotFound` bypasses `mergeIssueState`'s title-restoration
        // rule (which would resurrect the old title because issueNumber stays
        // unchanged) and preserves the branch-parsed issueNumber + the
        // `branchDerivedTitle` fallback alongside clearing linked.issue (#8851).
        store.getState().applyIssueNotFound(event.worktreeId, event.issueNumber);
      })
    );

    // Watcher degradation/recovery — service-wide ambient signals, not keyed
    // to a worktree. Use `.getState()` (not a captured ref) since these fire
    // async; the store action's functional updater keeps them race-safe
    // against the get-all-states hydration.
    cleanups.push(
      worktreePort.onEvent("inotify-limit-reached", () => {
        store.getState().setWatcherDegraded(true);
      })
    );
    cleanups.push(
      worktreePort.onEvent("emfile-limit-reached", () => {
        store.getState().setWatcherDegraded(true);
      })
    );
    cleanups.push(
      worktreePort.onEvent("watcher-recovered", () => {
        store.getState().setWatcherDegraded(false);
      })
    );

    // Confirmed forge-auth failure — a background fetch's credential is
    // genuinely broken (it survived several auto-retries). The host emits this
    // once per repo instead of flagging every worktree card, so we raise a
    // single escalation toast pointing at the forge settings. Transient blips
    // during the retry window never reach here (they show the softer
    // per-card "couldn't reach origin" tooltip instead).
    cleanups.push(
      worktreePort.onEvent("fetch-auth-failure-confirmed", () => {
        notify({
          type: "error",
          title: "Forge authentication failed",
          message:
            "Background fetches are paused because your code forge credentials were rejected. Sign in again to resume.",
          action: {
            label: "Open settings",
            actionId: "app.settings.openTab",
            onClick: () => {
              void actionService.dispatch(
                "app.settings.openTab",
                { tab: "code-forge" },
                { source: "user" }
              );
            },
          },
          supersedeKey: "forge-auth-failure-confirmed",
          context: { eventKind: "git" },
        });
      })
    );

    // Topology-watcher-dark/recovered — the worktree list may have silently
    // drifted. The store flag drives the Tier-1 pip; arming/clearing the 30s
    // Tier-3 escalation is shared with the hydration path (#9908).
    cleanups.push(
      worktreePort.onEvent("topology-watcher-dark", () => {
        store.getState().setTopologyWatcherDark(true);
        armTopologyEscalation();
      })
    );
    cleanups.push(
      worktreePort.onEvent("topology-watcher-recovered", () => {
        store.getState().setTopologyWatcherDark(false);
        clearTopologyEscalation();
      })
    );
    cleanups.push(clearTopologyEscalation);

    // Fetch on initial ready and on every port re-attach (host restart / re-broker)
    let initialPortReady = worktreePort.isReady();
    let initialPortTimer: ReturnType<typeof setTimeout> | null = null;

    function clearInitialPortTimer() {
      if (initialPortTimer !== null) {
        clearTimeout(initialPortTimer);
        initialPortTimer = null;
      }
    }

    // A load status can land before this effect runs at all — the IPC listener
    // that sets `worktreeLoadError` is installed at module scope, well before
    // React mounts the provider — and the subscription below only sees
    // *transitions*. Without settling it here, that pre-existing error would
    // leave the banner stacked on a skeleton that never ends.
    function settleForExistingLoadError(): boolean {
      if (useProjectStore.getState().worktreeLoadError === null) return false;
      clearInitialPortTimer();
      store.getState().setLoading(false);
      return true;
    }

    function armInitialPortTimer() {
      if (initialPortTimer !== null || initialPortReady) return;
      // Only a window bound to a project ever has a port brokered for it — an
      // unbound picker view legitimately never sees one, so arming there would
      // raise a banner for working software.
      if (!useProjectStore.getState().currentProject) return;
      if (settleForExistingLoadError()) return;
      initialPortTimer = setTimeout(() => {
        initialPortTimer = null;
        if (initialPortReady || worktreePort.isReady()) return;
        // A report from main describes the failure better than we can, but the
        // skeleton still has to end.
        if (settleForExistingLoadError()) return;
        useProjectStore.getState().setWorktreeLoadError(INITIAL_PORT_TIMEOUT_MESSAGE);
        // The banner renders *above* the skeleton, so the skeleton has to be
        // settled too or Retry ends up stacked on a still-spinning sidebar.
        store.getState().setLoading(false);
      }, INITIAL_PORT_READY_TIMEOUT_MS);
    }

    function handleInitialPortReady() {
      initialPortReady = true;
      clearInitialPortTimer();
      // Clear only the message this file owns: a newer error from main
      // describes something the refetch below won't resolve.
      if (useProjectStore.getState().worktreeLoadError === INITIAL_PORT_TIMEOUT_MESSAGE) {
        useProjectStore.getState().setWorktreeLoadError(null);
      }
      fetchInitialState();
    }

    if (initialPortReady) {
      fetchInitialState();
    } else {
      armInitialPortTimer();
    }
    cleanups.push(worktreePort.onReady(handleInitialPortReady));
    cleanups.push(clearInitialPortTimer);

    // `currentProject` can hydrate after this effect runs, so the arming
    // decision is re-taken on change rather than only at mount. Scoped to the
    // pre-ready window: once a port has arrived, the disconnect/fatal handlers
    // below own the sidebar's state.
    cleanups.push(
      useProjectStore.subscribe((state, prev) => {
        if (initialPortReady) return;
        if (
          state.worktreeLoadError !== prev.worktreeLoadError &&
          state.worktreeLoadError !== null
        ) {
          // Main reported a failed load, so no port is coming for it — settle
          // the skeleton rather than leaving the banner over a live spinner.
          clearInitialPortTimer();
          store.getState().setLoading(false);
          return;
        }
        if (state.currentProject !== prev.currentProject) armInitialPortTimer();
      })
    );

    // Surface a "Reconnecting…" state the moment the workspace host dies, so
    // the UI doesn't appear frozen while we wait (up to 2–4s) for the
    // replacement port.  Cleared by applySnapshot when the new port returns
    // data — this avoids flashing the indicator during normal port replacement
    // where a new port arrives within milliseconds.
    cleanups.push(
      worktreePort.onDisconnected(() => {
        store.getState().setReconnecting(true);
      })
    );

    // If the host exhausts its restart budget, no replacement port will
    // arrive — transition to a terminal error state instead of leaving the
    // spinner stuck indefinitely.  `setFatalError` also resets
    // `isInitialized` so a successful manual restart re-hydrates as a cold
    // fetch rather than a silent wake refresh.
    cleanups.push(
      worktreePort.onFatalDisconnect(() => {
        // A confirmed fatal disconnect is a better description than the
        // initial-connection watchdog's, so retire the watchdog rather than
        // letting it overwrite this later.
        clearInitialPortTimer();
        store
          .getState()
          .setFatalError(
            "Workspace service crashed and could not recover automatically. Restart the service to reconnect."
          );
      })
    );

    // Visibility flips drive per-terminal wake fan-out only: pulls the
    // missed range from the pty-host's headless mirror into each visible
    // xterm buffer (#7999). The worktree-state refresh path that used to
    // run alongside this fan-out was removed in #8066 — system sleep-wake
    // is now consolidated onto `useSystemWakeStore.wakeEpoch`, which the
    // workspace host's `refreshOnWake` already mirrors via `worktree-update`
    // push events. Re-entering this handler for short alt-tabs no longer
    // triggers redundant `get-all-states` fetches.
    // De-dupe guard: on warm reactivation Chromium fires the Page Lifecycle
    // `resume` event immediately before `visibilitychange` in the same turn
    // (#9702). Coalesce both into a single wake fan-out.
    // Double-rAF, not a microtask: a microtask runs before the unfrozen
    // renderer's first layout pass, so the wake's geometry reads and
    // terminal.refresh() execute while xterm's IntersectionObserver hasn't
    // re-fired and its render service is still paused — leaving agent
    // terminals garbled until a click re-fits them (#10362). The first rAF
    // fires before ResizeObserver/IntersectionObserver callbacks and paint;
    // the second is post-paint with settled layout (same idiom as
    // warmReactivationGate). Visibility is re-checked at execution time in
    // case the view was re-hidden between scheduling and the second frame.
    let wakePending = false;
    let wakeRafId: number | null = null;
    function scheduleWake() {
      if (wakePending) return;
      wakePending = true;
      wakeRafId = requestAnimationFrame(() => {
        wakeRafId = requestAnimationFrame(() => {
          wakeRafId = null;
          wakePending = false;
          if (document.visibilityState === "visible") {
            void wakeActiveWorktreeTerminals();
          }
        });
      });
    }
    cleanups.push(() => {
      if (wakeRafId !== null) cancelAnimationFrame(wakeRafId);
    });

    // Warm reactivation runs the fan-out NOW rather than through scheduleWake's
    // double-rAF settle. Main has just re-attached this view beneath the
    // outgoing one and is holding that bridge until the fan-out reports back;
    // an undrawn view's frames are throttled to ~2 Hz, so each deferred frame
    // cost ~500 ms and the gate (1.5 s hard) expired on every switch that had
    // panes to wake. The wake's repairs are synchronous and the post-reveal
    // repaint (#10362) redoes the paint at full rate once the view is on top.
    // A pending frame-deferred wake is folded in, and one frame of
    // `wakePending` absorbs the same-turn `resume`/`visibilitychange` echoes.
    function runWakeNow() {
      if (wakeRafId !== null) {
        cancelAnimationFrame(wakeRafId);
        wakeRafId = null;
      }
      wakePending = true;
      void wakeActiveWorktreeTerminals();
      if (typeof requestAnimationFrame !== "function") {
        wakePending = false;
        return;
      }
      wakeRafId = requestAnimationFrame(() => {
        wakeRafId = null;
        wakePending = false;
      });
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      scheduleWake();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    cleanups.push(() => document.removeEventListener("visibilitychange", handleVisibilityChange));

    // `resume` fires when a frozen renderer is thawed (CDP
    // Page.setWebLifecycleState("active")). On project switch-back the queued
    // `visibilitychange` can be processed while the renderer is still frozen
    // and the wake fan-out then runs in a lifecycle that can't execute it
    // (#9702). The `resume` event is the renderer's authoritative "now
    // executable" signal, so re-run the fan-out here too — coalesced with the
    // visibilitychange path above.
    function handleResume() {
      if (document.visibilityState !== "visible") return;
      scheduleWake();
    }
    document.addEventListener("resume", handleResume);
    cleanups.push(() => document.removeEventListener("resume", handleResume));

    // Post-reveal repaint (#10362): the wake fan-out above runs on
    // visibilitychange/resume — while this cached view is still occluded behind
    // the warm anti-flash bridge (#9679), where Chromium culls the paint, so the
    // redraw can fail to stick and agent terminals stay garbled until clicked.
    // Main fires `app:view-revealed` once it detaches the bridge and focuses the
    // now-foreground view; re-run the redraw then. Separate double-rAF gate from
    // scheduleWake so a repaint can't be coalesced away by an in-flight wake (and
    // vice versa); the repaint skips the byte-pull the wake already did.
    let repaintPending = false;
    let repaintRafId: number | null = null;
    // `pass` only labels the perf mark — it says which reveal-repaint pass
    // (initial or a timed backstop) actually landed, and changes nothing else.
    function scheduleRepaint(pass: "initial" | "backstop-1000" | "backstop-3000") {
      if (repaintPending) return;
      repaintPending = true;
      repaintRafId = requestAnimationFrame(() => {
        repaintRafId = requestAnimationFrame(() => {
          repaintRafId = null;
          repaintPending = false;
          if (document.visibilityState === "visible") {
            void repaintActiveWorktreeTerminals().then(() => {
              markSwitch(PERF_MARKS.PROJECT_SWITCH_REVEAL_REPAINT_DONE, { pass });
              flushPendingPerfMarks();
            });
          }
        });
      });
    }
    cleanups.push(() => {
      if (repaintRafId !== null) cancelAnimationFrame(repaintRafId);
    });

    // Timed redraw backstop: the single frame-sweep repaint above is bounded to
    // ~160ms (MAX_REVEAL_FRAMES) and then never retries. That window falls
    // before the compositor presents the now-foreground view, before xterm's
    // IntersectionObserver un-pauses the renderer as the view un-occludes, and
    // entirely inside the 5s project-switch resize lock — exactly when a repaint
    // can't stick. A manual Redraw works ONLY because the user clicks it seconds
    // later, after all three resolve. Replicate that without the click: re-run
    // the same cheap, idempotent, lock-exempt repaint on a fixed timer cadence so
    // a late-settling view is corrected on its own. Each pass is visibility- and
    // box-guarded down the stack (repaintForReveal / reconcileGeometryFresh), so
    // extra passes are near-no-ops — better too many redraws than a garbled pane.
    // Kept deliberately lean: 1s catches the common compositor/layout/observer
    // settle, 3s catches a late straggler. The hard guarantee past the 10s
    // project-switch resize suppression is owned by the service-side
    // suppression-clear redraw (suppressResizesDuringProjectSwitch), so the
    // cadence stops well before it rather than piling on redundant passes.
    const REVEAL_BACKSTOP_DELAYS_MS = [1000, 3000];
    let backstopTimers: ReturnType<typeof setTimeout>[] = [];
    function clearRevealBackstops() {
      for (const timer of backstopTimers) clearTimeout(timer);
      backstopTimers = [];
    }
    cleanups.push(clearRevealBackstops);

    // Deterministic warm-activation wake (#9679 hardening): main fires this the
    // moment it re-attaches this cached view behind the anti-flash bridge. The
    // visibilitychange/resume listeners above never fire for a plain
    // detach/reattach (no lifecycle event is emitted for a `setVisible(false)`
    // WebContentsView, and `resume` needs an actual freeze), so on most warm
    // switches the wake fan-out — whose completion releases main's warm paint
    // gate via notifyWarmViewPainted — had no trigger and the gate always ran
    // to its hard timeout. Runs the fan-out synchronously (see runWakeNow) and
    // deliberately has NO visibility guard: main asserts the activation and is
    // holding the bridge on the reply, so skipping the wake would only trade a
    // fan-out for a 1.5 s stall.
    const offViewWarmActivated = window.electron?.app?.onViewWarmActivated?.((payload) => {
      // First signal the incoming view gets on a warm switch: adopt the trace
      // so the wake fan-out marks below join it (`project:on-switch` fills in
      // the entry point later).
      if (payload?.switchId) setActiveSwitchTrace({ switchId: payload.switchId });
      markSwitch(PERF_MARKS.PROJECT_SWITCH_WARM_ACTIVATED_RECEIVED);
      runWakeNow();
    });
    if (offViewWarmActivated) cleanups.push(offViewWarmActivated);

    const offViewRevealed = window.electron?.app?.onViewRevealed?.((payload) => {
      markSwitch(PERF_MARKS.PROJECT_SWITCH_REVEALED_RECEIVED, {
        ...(payload?.switchId ? { switchId: payload.switchId } : {}),
      });
      if (document.visibilityState !== "visible") return;
      scheduleRepaint("initial");
      // Cancel any backstops still pending from a prior switch so rapid
      // back-and-forth switching can't stack passes, then arm this switch's.
      clearRevealBackstops();
      for (const delay of REVEAL_BACKSTOP_DELAYS_MS) {
        backstopTimers.push(
          setTimeout(() => {
            // Re-checked here AND inside scheduleRepaint's rAF: if the user
            // switched away again the view is hidden and this no-ops.
            if (document.visibilityState === "visible") {
              scheduleRepaint(delay === 1000 ? "backstop-1000" : "backstop-3000");
            }
          }, delay)
        );
      }
    });
    if (offViewRevealed) cleanups.push(offViewRevealed);

    const offViewCached = window.electron?.app?.onViewCached?.(() => {
      // Last chance to drain this view's outgoing-side marks before it is
      // parked (and possibly frozen) in the LRU cache.
      flushPendingPerfMarks();
      clearRevealBackstops();
      if (wakeRafId !== null) {
        cancelAnimationFrame(wakeRafId);
        wakeRafId = null;
        wakePending = false;
      }
      if (repaintRafId !== null) {
        cancelAnimationFrame(repaintRafId);
        repaintRafId = null;
        repaintPending = false;
      }
    });
    if (offViewCached) cleanups.push(offViewCached);

    // Missed-event guard: if the view is already visible by the time this
    // listener installs (fast cached reactivation), the visibilitychange
    // event has already fired (#4935). Worktree state is fetched via the
    // worktreePort.isReady() / onReady paths above, so only the wake fan-out
    // needs to run here. Route through scheduleWake (not a bare call) so it
    // inherits the same double-rAF settle the visibilitychange/resume paths use
    // and can't fire mid-frame before layout settles (#10362).
    if (document.visibilityState === "visible") {
      scheduleWake();
    }

    return () => {
      generation += 1;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [store]);

  return <WorktreeStoreContext value={store}>{children}</WorktreeStoreContext>;
}
