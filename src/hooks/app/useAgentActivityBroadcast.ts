import { useEffect } from "react";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { NO_WORKTREE } from "@/store/slices/panelRegistry/worktreeIndex";

// Fleet launches start several agents within a beat of each other — a short
// leading debounce coalesces them into one port request.
const ACTIVATION_DEBOUNCE_MS = 250;
// Agents flap working ↔ waiting on permission prompts. Keeping a worktree
// elevated through short pauses avoids watcher teardown/re-arm churn in the
// host; the deactivation refresh (which lands the agent's final diff) is
// delayed by at most this settle.
const DEACTIVATION_SETTLE_MS = 5_000;

type PanelState = ReturnType<typeof usePanelStore.getState>;

function isBusyPanel(panel: PanelState["panelsById"][string] | undefined): boolean {
  if (!panel || !isPtyPanel(panel)) return false;
  if (panel.location === "trash") return false;
  return panel.agentState === "working" || panel.agentState === "directing";
}

interface BusySnapshot {
  panelsById: PanelState["panelsById"];
  panelIdsByWorktreeId: PanelState["panelIdsByWorktreeId"];
  // Every panel id the busy set can depend on, flattened once per index.
  indexedIds: string[];
  ids: string[];
  key: string;
}

function computeBusySnapshot(state: PanelState): BusySnapshot {
  const busy: string[] = [];
  const indexedIds: string[] = [];
  for (const [worktreeId, panelIds] of Object.entries(state.panelIdsByWorktreeId)) {
    if (worktreeId === NO_WORKTREE) continue;
    let isBusy = false;
    for (const id of panelIds) {
      indexedIds.push(id);
      if (!isBusy && isBusyPanel(state.panelsById[id])) isBusy = true;
    }
    if (isBusy) busy.push(worktreeId);
  }
  busy.sort();
  return {
    panelsById: state.panelsById,
    panelIdsByWorktreeId: state.panelIdsByWorktreeId,
    indexedIds,
    ids: busy,
    key: JSON.stringify(busy),
  };
}

// The busy set depends only on the worktree index and each indexed panel's
// busy bit, so a write that replaces panel records (headline, focus stamp)
// without flipping a bit keeps the previous set — and its key.
function busyInputsUnchanged(prev: BusySnapshot, state: PanelState): boolean {
  if (prev.panelIdsByWorktreeId !== state.panelIdsByWorktreeId) return false;
  const { panelsById } = state;
  if (prev.panelsById === panelsById) return true;
  for (const id of prev.indexedIds) {
    const panel = panelsById[id];
    const prevPanel = prev.panelsById[id];
    if (panel !== prevPanel && isBusyPanel(panel) !== isBusyPanel(prevPanel)) return false;
  }
  return true;
}

/**
 * Streams the set of worktrees with actively working agents to the
 * workspace-host (`set-agent-activity`). The host elevates those monitors to
 * the recursive file-watcher tier so their working-tree edits reach the
 * dashboard in near-real-time while backgrounded — without this, an agent's
 * uncommitted edits in a non-focused worktree are invisible to the `.git/`-
 * only watcher and can sit stale for minutes.
 *
 * Activations flush fast; deactivations settle so permission-prompt flaps
 * don't churn watchers. Re-sends after a host restart via `onReady`.
 *
 * Idle while the project view is cached: main closes the worktree port for a
 * cached view, so every send would fail and the retry would re-arm forever.
 * Warm reactivation re-evaluates; the re-brokered port's `onReady` covers the
 * host-side reset.
 */
export function useAgentActivityBroadcast(): void {
  useEffect(() => {
    // Keys are JSON-encoded sorted id arrays — collision-safe for any path
    // characters (a newline join would let pathological ids alias a set).
    const EMPTY_KEY = JSON.stringify([]);
    const keyToIds = (key: string): string[] => {
      const raw = key.startsWith("unsent:") ? key.slice("unsent:".length) : key;
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === "string")
          : [];
      } catch {
        return [];
      }
    };

    // The host starts every session/epoch with an empty set.
    let lastSentKey = EMPTY_KEY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerKind: "activation" | "deactivation" | null = null;
    // The busy-set key the pending timer was scheduled for. Re-evaluations
    // that land on the same key leave the timer alone — otherwise unrelated
    // panel-store churn (focus moves, pings) would keep resetting a pending
    // deactivation's settle window and starve the send.
    let pendingKey: string | null = null;
    let disposed = false;
    let busy: BusySnapshot | null = null;

    const readBusy = (): BusySnapshot => {
      const state = usePanelStore.getState();
      if (busy && busyInputsUnchanged(busy, state)) {
        busy.panelsById = state.panelsById;
        return busy;
      }
      busy = computeBusySnapshot(state);
      return busy;
    };

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timerKind = null;
      pendingKey = null;
    };

    const send = () => {
      clearTimer();
      if (disposed) return;
      const { ids, key } = readBusy();
      if (key === lastSentKey) return;
      lastSentKey = key;
      window.electron.worktreePort.request("set-agent-activity", { worktreeIds: ids }).catch(() => {
        if (disposed || lastSentKey !== key) return;
        // Host restarting or transiently unreachable. Mark unsent so the
        // comparison can't believe the host holds this state, and retry on
        // our own clock — a quiet store never re-evaluates otherwise.
        lastSentKey = `unsent:${key}`;
        // A cached view's port is closed; `active` re-evaluates instead.
        if (isProjectViewCached()) return;
        scheduleSend("deactivation", key);
      });
    };

    const scheduleSend = (kind: "activation" | "deactivation", key: string) => {
      if (timer) {
        // A pending activation timer is the soonest send possible and its
        // send() recomputes the full set, so it covers any later change.
        if (timerKind === "activation") return;
        // Pending deactivation: an activation upgrades it to the fast path;
        // a DIFFERENT deactivation resets the settle window so every removal
        // gets the full flap-absorption interval, not the tail of an
        // earlier removal's window.
        clearTimeout(timer);
      }
      timerKind = kind;
      pendingKey = key;
      timer = setTimeout(
        send,
        kind === "activation" ? ACTIVATION_DEBOUNCE_MS : DEACTIVATION_SETTLE_MS
      );
    };

    const evaluate = () => {
      // Nothing can reach the host while cached. `lastSentKey` is left as-is
      // so `active` diffs against what the host was last told — agents in a
      // cached project keep working, so there is no idle set to announce.
      if (isProjectViewCached()) {
        clearTimer();
        return;
      }
      const { ids, key } = readBusy();
      if (key === lastSentKey) {
        clearTimer();
        return;
      }
      // A live timer already targeting this exact state needs no reschedule.
      if (timer && pendingKey === key) {
        return;
      }
      const lastIds = new Set(keyToIds(lastSentKey));
      const hasActivation = ids.some((id) => !lastIds.has(id));
      scheduleSend(hasActivation ? "activation" : "deactivation", key);
    };

    const unsubscribe = usePanelStore.subscribe(evaluate);
    const offReady = window.electron.worktreePort.onReady(() => {
      // Fresh host epoch — its agent-activity set is empty again. Drop any
      // pending timer too: relative to the empty host, every still-busy
      // worktree is an activation and must go out on the fast path, not ride
      // out the tail of a pre-restart deactivation settle.
      lastSentKey = EMPTY_KEY;
      clearTimer();
      evaluate();
    });
    const offLifecycle = subscribeProjectViewLifecycle((phase) => {
      if (phase === "cached") clearTimer();
      else if (phase === "active") evaluate();
    });
    evaluate();

    return () => {
      disposed = true;
      clearTimer();
      unsubscribe();
      offReady();
      offLifecycle();
    };
  }, []);
}
