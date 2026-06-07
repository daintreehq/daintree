import { useEffect, useState } from "react";
import type { HelpSessionLiveStatus } from "@shared/types";
import { logError } from "@/utils/logger";

const DISCONNECTED: HelpSessionLiveStatus = {
  connected: false,
  tier: "workbench",
  activeGrants: [],
};

/**
 * Live tier + per-tool grants for the pinned help session, addressed by its
 * public help-session id (`helpPanelStore.sessionId`). Unlike the persisted
 * `HelpAssistantSettings.tier` (the configured default for new sessions), this
 * reflects what the session is *running at right now* — including a
 * renderer-approved "Always allow" elevation — plus the grants currently in
 * effect.
 *
 * Data flow: subscribe to the grant-lifecycle push BEFORE the first pull so an
 * event firing in the mount→pull gap can't be missed (subscribe-before-pull,
 * lesson #9490). The push is target-scoped to this WebContents and carries the
 * MCP transport sessionId (not the public id we hold) with no `tier` field, so
 * we never reconcile incrementally from its payload — instead any push means
 * "this session's state changed" and we re-pull the authoritative snapshot.
 * In-flight pulls coalesce a burst of events (e.g. a session revoke emits one
 * event per grant) into a single trailing refresh.
 *
 * Returns safe `connected: false` defaults when `sessionId` is null or no live
 * session is pinned to this renderer — callers render that as a quiet idle
 * state, never a spinner.
 */
export function useHelpSessionLiveStatus(sessionId: string | null): HelpSessionLiveStatus {
  const [status, setStatus] = useState<HelpSessionLiveStatus>(DISCONNECTED);

  useEffect(() => {
    if (!sessionId) {
      setStatus(DISCONNECTED);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let pendingRefresh = false;

    const pull = (): void => {
      inFlight = true;
      window.electron.helpAssistant
        .getLiveSessionStatus({ sessionId })
        .then((live) => {
          if (cancelled) return;
          setStatus(live);
        })
        .catch((err) => {
          if (cancelled) return;
          logError("Failed to load live help-session status", err);
          setStatus(DISCONNECTED);
        })
        .finally(() => {
          inFlight = false;
          if (cancelled || !pendingRefresh) return;
          // An event arrived mid-flight; fold it into exactly one trailing pull
          // so the final snapshot reflects every event without a thundering herd.
          pendingRefresh = false;
          pull();
        });
    };

    const requestRefresh = (): void => {
      if (inFlight) {
        pendingRefresh = true;
        return;
      }
      pull();
    };

    const unsubscribe = window.electron.mcpServer.onGrantLifecycle(() => {
      requestRefresh();
    });

    pull();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  return status;
}
