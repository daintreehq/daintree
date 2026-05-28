import { useEffect } from "react";
import { create } from "zustand";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { logError } from "@/utils/logger";

interface AllDevSessionsState {
  sessions: DevPreviewSessionState[];
  hydrated: boolean;
}

export const useAllDevSessionsStore = create<AllDevSessionsState>(() => ({
  sessions: [],
  hydrated: false,
}));

// Single shared IPC subscription guarded by a reference count. React 19
// StrictMode double-invokes effects, so a naive per-component subscription would
// register duplicate listeners that fire twice per event (lesson #4754). The
// ref count keeps exactly one live subscription regardless of how many dashboard
// instances mount, and tears it down once the last consumer unmounts.
let subscriberCount = 0;
let unsubscribe: (() => void) | null = null;
// Invalidates an in-flight hydrate so a snapshot that resolves after teardown
// (or after a restart) can't clobber fresher push state.
let hydrateToken = 0;

function startSubscription(): void {
  const token = ++hydrateToken;

  window.electron.devPreview
    .getAllSessions()
    .then((sessions) => {
      if (token !== hydrateToken) return;
      useAllDevSessionsStore.setState({ sessions, hydrated: true });
    })
    .catch((err) => {
      if (token !== hydrateToken) return;
      logError("Failed to load dev-server sessions", err);
      useAllDevSessionsStore.setState({ hydrated: true });
    });

  unsubscribe = window.electron.devPreview.onAllSessionsChanged((payload) => {
    // A push reflects a state transition newer than the initial hydrate
    // snapshot. Advance the token so a still-in-flight getAllSessions() that
    // resolves later can't overwrite this fresher state with stale data.
    hydrateToken++;
    useAllDevSessionsStore.setState({ sessions: payload.sessions, hydrated: true });
  });
}

function stopSubscription(): void {
  // Bump the token so a pending hydrate is dropped, then drop the listener and
  // reset cached state — nothing is watching, so stale data must not linger.
  hydrateToken++;
  unsubscribe?.();
  unsubscribe = null;
  useAllDevSessionsStore.setState({ sessions: [], hydrated: false });
}

/**
 * Register interest in the cross-worktree dev-session snapshot. Returns a
 * release function; the IPC subscription is created on the first acquire and
 * disposed on the last release. Exported for tests and non-hook callers.
 */
export function acquireAllDevSessions(): () => void {
  subscriberCount += 1;
  if (subscriberCount === 1) startSubscription();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount -= 1;
    if (subscriberCount === 0) stopSubscription();
  };
}

/**
 * Subscribe to the live snapshot of every dev-preview session across all
 * worktrees. Mounting drives the shared IPC subscription via the ref count.
 */
export function useAllDevSessions(): DevPreviewSessionState[] {
  useEffect(() => acquireAllDevSessions(), []);
  return useAllDevSessionsStore((s) => s.sessions);
}

// Test-only reset so suites can start from a clean module state.
export function _resetAllDevSessionsForTests(): void {
  subscriberCount = 0;
  hydrateToken = 0;
  unsubscribe?.();
  unsubscribe = null;
  useAllDevSessionsStore.setState({ sessions: [], hydrated: false });
}
