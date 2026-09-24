import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Check, Copy, ExternalLink, RotateCw } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "../Terminal/InlineStatusBanner";
import { BannerOverflowMenu } from "../Terminal/BannerOverflowMenu";
import { Spinner } from "@/components/ui/Spinner";
import { formatDialogOrigin, looksLikeOAuthUrl } from "@shared/utils/urlUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { SessionStorageEntry } from "./useDevPreviewLoadLifecycle";

type OAuthPhase =
  | "blocked"
  | "oauth-started"
  | "oauth-intercepting"
  | "oauth-completed"
  | "oauth-timed-out"
  | "oauth-error";

/**
 * Why a sign-in ended in `oauth-error`, when the renderer knows. `not-ready`
 * fails before the browser ever opens; anything else is a failure somewhere in
 * the round trip, reported by main with an optional raw message.
 */
type OAuthErrorCause = "not-ready" | "failed";

interface BlockedNavState {
  url: string;
  canOpenExternal: boolean;
  sessionStorageSnapshot: SessionStorageEntry[];
  isOAuth: boolean;
  phase: OAuthPhase;
  errorCause: OAuthErrorCause | null;
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
  | { type: "OAUTH_ERROR"; message: string | null; cause?: OAuthErrorCause }
  /**
   * The invoke result of a failed sign-in. Main normally reports the failure
   * first as a status event; this only lands when that event was dropped, so it
   * applies to the same attempt still in flight and never overwrites a terminal
   * phase or a newer notice.
   */
  | { type: "OAUTH_RESULT_FAILED"; url: string; timedOut: boolean; message?: string | null }
  | { type: "DISMISS" }
  /**
   * Dismiss once an action on `url` has settled — but only if the banner is
   * still about `url`. A block that arrived while the action was awaited is a
   * new notice, and a late result must not close it.
   */
  | { type: "DISMISS_IF_URL"; url: string };

// How long the "Copied" confirmation label lingers before reverting to "Copy URL".
const COPY_FEEDBACK_MS = 2000;
// "Signed in" is a confirmation, not a state: the banner says the round trip
// through the browser landed and then gets out of the way. Longer than the copy
// flash because the user is coming back from another app and has to catch it,
// short enough that it never becomes standing chrome (#12002).
const SIGN_IN_COMPLETED_DISMISS_MS = 6000;
// Mirrors OAuthLoopbackService's TIMEOUT_MS, which the waiting copy promises.
const SIGN_IN_TIMEOUT_MINUTES = 5;

function isInFlight(phase: OAuthPhase): boolean {
  return phase === "oauth-started" || phase === "oauth-intercepting";
}

/**
 * What the banner names as the destination. A web URL is named by its full host
 * — the part a user can check, clipped from the left if hostile-length — never a
 * guessed registrable domain, which reads `co.uk` for a British site. A custom
 * scheme has no host worth naming (`slack://open` would read as "open"), so it
 * is named by its scheme.
 */
type Destination = { kind: "web"; host: string } | { kind: "scheme"; scheme: string } | null;

function describeDestination(url: string): Destination {
  const host = formatDialogOrigin(url);
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return null;
  }
  if ((protocol === "http:" || protocol === "https:") && host) return { kind: "web", host };
  if (protocol === "http:" || protocol === "https:") return null;
  return { kind: "scheme", scheme: protocol };
}

function blockedNavReducer(
  state: BlockedNavState | null,
  action: BlockedNavAction
): BlockedNavState | null {
  switch (action.type) {
    case "BLOCKED": {
      // A sign-in in flight owns the banner: its URL and session snapshot are
      // what Retry and the loopback act on, so a later block cannot replace
      // them. Only in-flight phases — a terminal phase carried forward would let
      // its dismiss timer close a navigation blocked after it.
      if (state && isInFlight(state.phase)) return state;
      return {
        url: action.url,
        canOpenExternal: action.canOpenExternal,
        sessionStorageSnapshot: action.sessionStorageSnapshot,
        isOAuth: looksLikeOAuthUrl(action.url),
        phase: "blocked",
        errorCause: null,
        errorMessage: null,
      };
    }
    case "OAUTH_STARTED":
      return state
        ? { ...state, phase: "oauth-started", errorCause: null, errorMessage: null }
        : state;
    case "OAUTH_TOKEN_INTERCEPTED":
      return state ? { ...state, phase: "oauth-intercepting" } : state;
    case "OAUTH_COMPLETED":
      return state ? { ...state, phase: "oauth-completed" } : state;
    case "OAUTH_TIMED_OUT":
      return state ? { ...state, phase: "oauth-timed-out" } : state;
    case "OAUTH_ERROR":
      return state
        ? {
            ...state,
            phase: "oauth-error",
            errorCause: action.cause ?? "failed",
            errorMessage: action.message,
          }
        : state;
    case "OAUTH_RESULT_FAILED":
      if (!state || !isInFlight(state.phase) || state.url !== action.url) return state;
      return action.timedOut
        ? { ...state, phase: "oauth-timed-out" }
        : {
            ...state,
            phase: "oauth-error",
            errorCause: "failed",
            errorMessage: action.message ?? null,
          };
    case "DISMISS":
      return null;
    case "DISMISS_IF_URL":
      return state && state.url === action.url ? null : state;
  }
}

export interface BlockedNavBannerProps {
  state: BlockedNavState | null;
  panelId: string;
  webviewElement: Electron.WebviewTag | null;
  onDispatch: (action: BlockedNavAction) => void;
}

type CopyState = "idle" | "copied" | "failed";

/** Mirrors `canOpenExternal`'s allow-list: anything not web is handed to the OS. */
function schemeLabel(scheme: string, url: string): string {
  return url.startsWith(`${scheme}//`) ? `${scheme}//` : scheme;
}

export function BlockedNavBanner({
  state,
  panelId,
  webviewElement,
  onDispatch,
}: BlockedNavBannerProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [openFailed, setOpenFailed] = useState(false);
  const url = state?.url;

  const handleCopyUrl = useCallback(async () => {
    if (!url) return;
    try {
      await window.electron.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [url]);

  // Auto-reset the copy label after a beat. Driven by an effect rather than a
  // timer ref so no ref is reachable from render — the React Compiler flags
  // transitive ref reads from a render-phase call.
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copyState]);

  // Feedback belongs to the URL it was about, not to the next one.
  useEffect(() => {
    setCopyState("idle");
    setOpenFailed(false);
  }, [url]);

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
          onDispatch({ type: "OAUTH_ERROR", message: payload.message ?? null });
          break;
      }
    });
    return cleanup;
  }, [panelId, onDispatch]);

  const handleCancelOAuth = useCallback(() => {
    // Cancel may fail if already settled — harmless.
    window.electron.webview.cancelOAuthLoopback(panelId).catch(() => {});
    onDispatch({ type: "DISMISS" });
  }, [panelId, onDispatch]);

  const handleDismiss = useCallback(() => {
    onDispatch({ type: "DISMISS" });
  }, [onDispatch]);

  if (!state) return null;

  const handleStartOAuth = async () => {
    onDispatch({ type: "OAUTH_STARTED" });

    let wcId: number | undefined;
    try {
      wcId = (webviewElement as unknown as { getWebContentsId(): number })?.getWebContentsId();
    } catch {
      /* webview not ready */
    }

    if (wcId == null) {
      onDispatch({ type: "OAUTH_ERROR", message: null, cause: "not-ready" });
      return;
    }

    const attemptUrl = state.url;
    try {
      const result = await window.electron.webview.startOAuthLoopback(
        attemptUrl,
        panelId,
        wcId,
        state.sessionStorageSnapshot
      );
      if (!result.success && result.cause !== "cancelled") {
        onDispatch({
          type: "OAUTH_RESULT_FAILED",
          url: attemptUrl,
          timedOut: result.cause === "timed-out",
        });
      }
    } catch (err) {
      onDispatch({
        type: "OAUTH_RESULT_FAILED",
        url: attemptUrl,
        timedOut: false,
        // Empty fallback: with nothing observed, the detail line stays empty.
        message: formatErrorMessage(err, "") || null,
      });
    }
  };

  const handleOpenExternal = async () => {
    const target = state.url;
    setOpenFailed(false);
    try {
      await window.electron.system.openExternal(target);
      onDispatch({ type: "DISMISS_IF_URL", url: target });
    } catch {
      // The banner stays and says so: the link is still here to copy.
      setOpenFailed(true);
    }
  };

  const { phase } = state;
  const destination = describeDestination(state.url);
  const hostLabel = destination?.kind === "web" ? destination.host : null;

  const copyAction: BannerAction = {
    id: "copy-url",
    label:
      copyState === "copied" ? "Copied" : copyState === "failed" ? "Couldn't copy" : "Copy URL",
    icon: copyState === "copied" ? Check : Copy,
    onClick: handleCopyUrl,
    variant: "dismiss",
  };
  const retryAction: BannerAction = {
    id: "oauth-retry",
    label: "Retry",
    icon: RotateCw,
    onClick: handleStartOAuth,
    variant: "primary",
  };
  // The one control an in-flight sign-in offers, so it carries the button
  // treatment rather than reading as loose text.
  const cancelAction: BannerAction = {
    id: "oauth-cancel",
    label: "Cancel sign-in",
    onClick: handleCancelOAuth,
    variant: "primary",
  };

  switch (phase) {
    case "blocked": {
      const actions: BannerAction[] = [];
      let title: string;
      if (state.isOAuth) {
        title = hostLabel
          ? `Can't show the ${hostLabel} sign-in here`
          : "Can't show this sign-in page here";
        actions.push({
          id: "oauth-start",
          label: "Sign in via browser",
          icon: ExternalLink,
          onClick: handleStartOAuth,
          variant: "primary",
        });
      } else {
        title =
          destination?.kind === "web"
            ? `Can't open ${destination.host} here`
            : destination?.kind === "scheme"
              ? `Can't open ${schemeLabel(destination.scheme, state.url)} links here`
              : "Can't open this link here";
        if (state.canOpenExternal) {
          actions.push({
            id: "open-external",
            label: destination?.kind === "web" ? "Open in external browser" : "Open in default app",
            icon: ExternalLink,
            onClick: handleOpenExternal,
            variant: "primary",
          });
        }
      }
      // With nothing else to offer, copying is the way forward and keeps the
      // primary treatment; beside another action it steps back.
      actions.push(actions.length === 0 ? { ...copyAction, variant: "primary" } : copyAction);
      return (
        <InlineStatusBanner
          icon={ExternalLink}
          severity="warning"
          layout="pane"
          title={title}
          description={
            openFailed
              ? "Your system couldn't open this link. Copy it instead."
              : state.isOAuth
                ? "Sign in through your browser and the session comes back to the preview."
                : undefined
          }
          // The OAuth request's query string is noise once the title names the
          // host; an ordinary link's path is what tells the user which page.
          contextLine={state.isOAuth ? undefined : state.url}
          actions={actions}
          onClose={handleDismiss}
          role="status"
        />
      );
    }
    case "oauth-started":
      return (
        <InlineStatusBanner
          icon={ExternalLink}
          severity="info"
          layout="pane"
          title="Finish signing in from your browser"
          description={
            hostLabel
              ? `Waiting for ${hostLabel} to send you back. Stops after ${SIGN_IN_TIMEOUT_MINUTES} minutes.`
              : `Waiting for the browser to send you back. Stops after ${SIGN_IN_TIMEOUT_MINUTES} minutes.`
          }
          actions={[cancelAction, copyAction]}
          role="status"
        />
      );
    case "oauth-intercepting":
      return (
        <InlineStatusBanner
          icon={SpinnerGlyph}
          severity="info"
          layout="pane"
          title="Finishing sign-in"
          description="Bringing the session back into the preview."
          actions={[cancelAction]}
          role="status"
        />
      );
    case "oauth-completed":
      return (
        <InlineStatusBanner
          severity="success"
          layout="pane"
          title={hostLabel ? `Signed in to ${hostLabel}` : "Signed in"}
          onClose={handleDismiss}
          autoDismissAfter={SIGN_IN_COMPLETED_DISMISS_MS}
          role="status"
        />
      );
    case "oauth-timed-out":
    case "oauth-error": {
      const { title, description, detail } = describeFailure(state, hostLabel);
      return (
        <InlineStatusBanner
          severity="error"
          layout="pane"
          title={title}
          description={description}
          contextLine={detail}
          action={retryAction}
          // `end`: in the pane layout the trigger sits at the band's right edge.
          trailingSlot={<BannerOverflowMenu actions={[copyAction]} align="end" />}
          onClose={handleDismiss}
          role="alert"
        />
      );
    }
  }
}

/** The banner's glyph slot takes an icon; this lends it the shared spinner. */
function SpinnerGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span className={className} style={style} aria-hidden="true">
      <Spinner className="size-full" />
    </span>
  );
}

/**
 * Failure copy in the user's terms. A raw message from main is an observation
 * worth keeping, so it rides in the mono detail line rather than being dropped
 * or promoted into the sentence.
 */
function describeFailure(
  state: BlockedNavState,
  hostLabel: string | null
): { title: string; description: string; detail?: string } {
  if (state.phase === "oauth-timed-out") {
    return {
      title: "Sign-in timed out",
      description: `${hostLabel ?? "The browser"} didn't send you back within ${SIGN_IN_TIMEOUT_MINUTES} minutes.`,
    };
  }
  if (state.errorCause === "not-ready") {
    return {
      title: "Couldn't start sign-in",
      description: "The preview wasn't ready yet. Wait for the page to finish loading.",
    };
  }
  return {
    title: "Sign-in failed",
    description: "The session didn't make it back to the preview.",
    detail: state.errorMessage ?? undefined,
  };
}

export { blockedNavReducer, type BlockedNavState, type BlockedNavAction };
