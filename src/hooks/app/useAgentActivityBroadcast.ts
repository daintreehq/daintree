import { useEffect } from "react";
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

function computeBusyWorktreeIds(): string[] {
  const state = usePanelStore.getState();
  const busy: string[] = [];
  for (const [worktreeId, panelIds] of Object.entries(state.panelIdsByWorktreeId)) {
    if (worktreeId === NO_WORKTREE) continue;
    for (const id of panelIds) {
      const panel = state.panelsById[id];
      if (!panel || !isPtyPanel(panel)) continue;
      if (panel.location === "trash") continue;
      if (panel.agentState === "working" || panel.agentState === "directing") {
        busy.push(worktreeId);
        break;
      }
    }
  }
  return busy.sort();
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
      const ids = computeBusyWorktreeIds();
      const key = JSON.stringify(ids);
      if (key === lastSentKey) return;
      lastSentKey = key;
      window.electron.worktreePort.request("set-agent-activity", { worktreeIds: ids }).catch(() => {
        if (disposed || lastSentKey !== key) return;
        // Host restarting or transiently unreachable. Mark unsent so the
        // comparison can't believe the host holds this state, and retry on
        // our own clock — a quiet store never re-evaluates otherwise.
        lastSentKey = `unsent:${key}`;
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
      const ids = computeBusyWorktreeIds();
      const key = JSON.stringify(ids);
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
    evaluate();

    return () => {
      disposed = true;
      clearTimer();
      unsubscribe();
      offReady();
    };
  }, []);
}
