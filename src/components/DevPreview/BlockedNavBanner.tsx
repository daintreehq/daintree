import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, AlertTriangle, CircleCheck, Copy } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "../Terminal/InlineStatusBanner";
import { looksLikeOAuthUrl } from "@shared/utils/urlUtils";
import type { SessionStorageEntry } from "./useDevPreviewLoadLifecycle";

type OAuthPhase =
  | "blocked"
  | "oauth-started"
  | "oauth-intercepting"
  | "oauth-completed"
  | "oauth-timed-out"
  | "oauth-error";

interface BlockedNavState {
  url: string;
  canOpenExternal: boolean;
  sessionStorageSnapshot: SessionStorageEntry[];
  isOAuth: boolean;
  registrableDomain: string;
  phase: OAuthPhase;
  errorMessage: string | null;
}

type BlockedNavAction =
  | {
      type: "BLOCKED";
      url: string;
      canOpenExternal: boolean;
      sessionStorageSnapshot: SessionStorageEntry[];
    }
  | { type: "OAUTH_STARTED" }
  | { type: "OAUTH_TOKEN_INTERCEPTED" }
  | { type: "OAUTH_COMPLETED" }
  | { type: "OAUTH_TIMED_OUT" }
  | { type: "OAUTH_ERROR"; message: string }
  | { type: "DISMISS" };

function computeRegistrableDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const segments = hostname.split(".");
    return segments.length > 1 ? segments.slice(-2).join(".") : hostname;
  } catch {
    return url;
  }
}

function blockedNavReducer(
  state: BlockedNavState | null,
  action: BlockedNavAction
): BlockedNavState | null {
  switch (action.type) {
    case "BLOCKED": {
      const isOAuth = looksLikeOAuthUrl(action.url);
      // Coalesce: if OAuth is in-flight, update URL data but preserve the in-flight phase
      if (state && state.phase !== "blocked") {
        return {
          ...state,
          url: action.url,
          canOpenExternal: action.canOpenExternal,
          sessionStorageSnapshot: action.sessionStorageSnapshot,
          isOAuth,
          registrableDomain: computeRegistrableDomain(action.url),
        };
      }
      return {
        url: action.url,
        canOpenExternal: action.canOpenExternal,
        sessionStorageSnapshot: action.sessionStorageSnapshot,
        isOAuth,
        registrableDomain: computeRegistrableDomain(action.url),
        phase: "blocked",
        errorMessage: null,
      };
    }
    case "OAUTH_STARTED":
      return state ? { ...state, phase: "oauth-started", errorMessage: null } : state;
    case "OAUTH_TOKEN_INTERCEPTED":
      return state ? { ...state, phase: "oauth-intercepting" } : state;
    case "OAUTH_COMPLETED":
      return state ? { ...state, phase: "oauth-completed" } : state;
    case "OAUTH_TIMED_OUT":
      return state ? { ...state, phase: "oauth-timed-out" } : state;
    case "OAUTH_ERROR":
      return state ? { ...state, phase: "oauth-error", errorMessage: action.message } : state;
    case "DISMISS":
      return null;
  }
}

export interface BlockedNavBannerProps {
  state: BlockedNavState | null;
  panelId: string;
  webviewElement: Electron.WebviewTag | null;
  onDispatch: (action: BlockedNavAction) => void;
}

export function BlockedNavBanner({
  state,
  panelId,
  webviewElement,
  onDispatch,
}: BlockedNavBannerProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleCopyUrl = useCallback(async () => {
    if (!state) return;
    try {
      await window.electron.clipboard.writeText(state.url);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — silently ignore
    }
  }, [state]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Listen for OAuth loopback status events from main process
  useEffect(() => {
    const cleanup = window.electron.webview.onOAuthLoopbackStatus((payload) => {
      if (payload.panelId !== panelId) return;
      switch (payload.phase) {
        case "token-exchange-intercepted":
          onDispatch({ type: "OAUTH_TOKEN_INTERCEPTED" });
          break;
        case "completed":
          onDispatch({ type: "OAUTH_COMPLETED" });
          break;
        case "timed-out":
          onDispatch({ type: "OAUTH_TIMED_OUT" });
          break;
        case "error":
          onDispatch({ type: "OAUTH_ERROR", message: payload.message ?? "Sign-in failed" });
          break;
      }
    });
    return cleanup;
  }, [panelId, onDispatch]);

  const handleCancelOAuth = useCallback(async () => {
    try {
      await window.electron.webview.cancelOAuthLoopback(panelId);
    } catch {
      // cancel may fail if already settled — harmless
    }
  }, [panelId]);

  const handleDismiss = useCallback(() => {
    // Cancel any in-flight loopback when dismissing from an OAuth phase
    if (state && (state.phase === "oauth-started" || state.phase === "oauth-intercepting")) {
      window.electron.webview.cancelOAuthLoopback(panelId).catch(() => {});
    }
    onDispatch({ type: "DISMISS" });
  }, [state, panelId, onDispatch]);

  if (!state) return null;

  const handleStartOAuth = async () => {
    const url = state.url;
    onDispatch({ type: "OAUTH_STARTED" });

    let wcId: number | undefined;
    try {
      wcId = (webviewElement as unknown as { getWebContentsId(): number })?.getWebContentsId();
    } catch {
      /* webview not ready */
    }

    if (wcId == null) {
      onDispatch({ type: "OAUTH_ERROR", message: "WebView not ready" });
      return;
    }

    try {
      const result = await window.electron.webview.startOAuthLoopback(
        url,
        panelId,
        wcId,
        state.sessionStorageSnapshot
      );
      if (!result.success && result.cause !== "cancelled") {
        // Status events (onOAuthLoopbackStatus) fire first and carry the
        // typed failure cause. The invoke result is a fallback for cases
        // where the event is dropped; the reducer already reflects the
        // correct phase from the event.
      }
    } catch (err) {
      onDispatch({
        type: "OAUTH_ERROR",
        message: err instanceof Error ? err.message : "Sign-in failed",
      });
    }
  };

  const copyAction: BannerAction = {
    id: "copy-url",
    label: copied ? "Copied" : "Copy URL",
    icon: Copy,
    onClick: handleCopyUrl,
    disabled: copied,
  };

  const buildActions = (): BannerAction[] => {
    const actions: BannerAction[] = [copyAction];

    switch (state.phase) {
      case "blocked":
        if (state.isOAuth) {
          actions.push({
            id: "oauth-start",
            label: "Sign in via browser",
            icon: ExternalLink,
            onClick: handleStartOAuth,
            variant: "primary",
          });
        } else if (state.canOpenExternal) {
          actions.push({
            id: "open-external",
            label: "Open in external browser",
            icon: ExternalLink,
            onClick: () => {
              window.electron.system.openExternal(state.url);
              onDispatch({ type: "DISMISS" });
            },
          });
        }
        break;
      case "oauth-started":
        actions.push({
          id: "oauth-cancel",
          label: "Cancel",
          onClick: () => {
            handleCancelOAuth();
            onDispatch({ type: "DISMISS" });
          },
          variant: "danger",
        });
        break;
      case "oauth-intercepting":
        actions.push({
          id: "oauth-cancel",
          label: "Cancel",
          onClick: () => {
            handleCancelOAuth();
            onDispatch({ type: "DISMISS" });
          },
          variant: "danger",
        });
        break;
      case "oauth-timed-out":
      case "oauth-error":
        actions.push({
          id: "oauth-retry",
          label: "Try again",
          icon: ExternalLink,
          onClick: handleStartOAuth,
          variant: "primary",
        });
        break;
      case "oauth-completed":
        break;
    }

    return actions;
  };

  const { phase, registrableDomain, url, errorMessage } = state;

  let icon: React.ComponentType<{ className?: string }>;
  let title: string;
  let description: string | undefined;
  let severity: "error" | "warning" | "info" | "success";

  switch (phase) {
    case "blocked":
      icon = ExternalLink;
      title = `Navigation blocked: ${registrableDomain}`;
      severity = "warning";
      break;
    case "oauth-started":
      icon = ExternalLink;
      title = "Sign in via browser";
      severity = "warning";
      break;
    case "oauth-intercepting":
      icon = ExternalLink;
      title = "Sign in via browser";
      severity = "info";
      break;
    case "oauth-completed":
      icon = CircleCheck;
      title = "Sign in completed";
      severity = "success";
      break;
    case "oauth-timed-out":
      icon = AlertTriangle;
      title = "Sign in didn't complete";
      description = "The sign-in timed out. Try again.";
      severity = "error";
      break;
    case "oauth-error":
      icon = AlertTriangle;
      title = "Couldn't start sign-in";
      description = errorMessage ?? undefined;
      severity = "error";
      break;
  }

  return (
    <InlineStatusBanner
      icon={icon}
      title={title}
      description={description}
      contextLine={url}
      severity={severity}
      actions={buildActions()}
      onClose={handleDismiss}
      role={phase === "blocked" || phase === "oauth-started" ? "status" : "alert"}
    />
  );
}

export { blockedNavReducer, type BlockedNavState, type BlockedNavAction };
