import { useEffect, useState } from "react";
import { AlertCircle, Clock, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  ActiveGrantState,
  GrantEndReason,
  GrantEndedState,
  LaunchErrorKind,
  LaunchErrorState,
  SessionRevokedState,
  TierMismatchState,
} from "@/controllers/HelpSessionController";

// Body copy keyed off how the grant ended (#10042). The tool id is the
// sentence subject, prepended by the caller — kept jargon-free per the
// microcopy rules (no "MCP" / "grant" / "tier").
const GRANT_ENDED_BODY: Record<GrantEndReason, string> = {
  expired: "access expired. The next call will ask to approve it again.",
  "grant-ceiling": "hit its 30-minute limit. The next call will ask to approve it again.",
};

// The countdown re-derives from `expiresAt` once a second — the tick only
// drives a re-render, it isn't the source of truth, so a missed beat can't
// drift the displayed value.
const COUNTDOWN_TICK_MS = 1000;

function formatRemaining(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function computeRemainingSeconds(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

/**
 * Ambient countdown for a live per-tool grant (#10042), minted by the
 * tier-mismatch banner's "Allow this tool". Tier 1 — a non-blocking
 * pane-chrome state, not a toast. The countdown derives from the
 * grant's `expiresAt` with a component-local 1s tick; the timestamp is the
 * source of truth, so a missed tick can't drift the displayed value (and the
 * interval is keyed on `expiresAt`, restarting cleanly under StrictMode's
 * double-mount). The grant is sliding-TTL: the countdown is "time left if the
 * tool isn't used again," matching the issue's "countdown without polling".
 */
function GrantActiveBanner({
  grant,
  isRevoking,
  onRevoke,
}: {
  grant: ActiveGrantState;
  isRevoking: boolean;
  onRevoke: () => void;
}) {
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    computeRemainingSeconds(grant.expiresAt)
  );
  useEffect(() => {
    setRemainingSeconds(computeRemainingSeconds(grant.expiresAt));
    const id = setInterval(() => {
      setRemainingSeconds(computeRemainingSeconds(grant.expiresAt));
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [grant.expiresAt]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 px-3 py-2 mx-3 mt-3 mb-1",
        "rounded-[var(--radius-md)] bg-overlay-subtle border border-border-default",
        "text-xs text-text-primary"
      )}
      data-testid="help-grant-active-banner"
    >
      <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-daintree-text/60" aria-hidden="true" />
      <span className="flex-1 min-w-0 select-text">
        <span className="font-mono text-text-primary">{grant.toolId}</span> approved ·{" "}
        {/* The countdown re-derives every second; keep it out of the parent's
            polite live region (`aria-live="off"`) so screen readers announce
            the "<tool> approved" message once instead of the ticking time. */}
        <span aria-live="off" className="tabular-nums">
          {formatRemaining(remainingSeconds)}
        </span>{" "}
        left
      </span>
      <button
        type="button"
        onClick={onRevoke}
        disabled={isRevoking}
        className={cn(
          "px-2 py-1 rounded-[var(--radius-sm)] text-xs",
          "text-text-secondary hover:text-text-primary",
          "disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        )}
      >
        Revoke access
      </button>
    </div>
  );
}

/**
 * Brief notice that a watched grant lapsed (#10042). Neutral ambient surface,
 * not an error tint — nothing failed; the user's approval simply timed out and
 * the next call re-prompts. Auto-dismisses on a controller timer; also
 * manually dismissible.
 */
function GrantEndedBanner({
  grantEnded,
  onDismiss,
}: {
  grantEnded: GrantEndedState;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-start gap-2 px-3 py-2 mx-3 mt-3 mb-1",
        "rounded-[var(--radius-md)] bg-overlay-subtle border border-border-default",
        "text-xs text-text-primary"
      )}
      data-testid="help-grant-ended-banner"
    >
      <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-daintree-text/60" aria-hidden="true" />
      <span className="flex-1 min-w-0 select-text">
        <span className="font-mono text-text-primary">{grantEnded.toolId}</span>{" "}
        {GRANT_ENDED_BODY[grantEnded.reason]}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss approval notice"
        className="text-daintree-text/50 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// Recovery copy keyed off the failure kind so the banner never leaks the
// underlying "MCP" / "token" / "bearer" jargon the controller catches.
const LAUNCH_ERROR_BODY: Record<LaunchErrorKind, string> = {
  "mcp-server-not-started":
    "Daintree's assistant services didn't start. Check assistant settings, then try again.",
  "mcp-probe-failed": "Daintree's assistant services didn't respond in time. Try again.",
  "skills-sync-failed":
    "Daintree couldn't refresh this project's assistant commands and skills, so the session didn't start. Retry, or check the logs if it keeps failing.",
  "spawn-failed": "The agent didn't start. Try again.",
  "folder-unavailable":
    "Daintree's bundled assistant files are missing. Reinstall Daintree or check the logs.",
};

// Per-kind recovery surface. `folder-unavailable` is non-retryable: the
// resolver's module-scope cache returns the same null on retry, so the only
// honest affordances are the installer page and the error log. `Retry` is
// kept for the transient kinds (spawn/probe/server). `skills-sync-failed`
// pairs both: some causes clear on retry, but a corrupt manifest or an
// unremovable stale file fails identically forever, so the log — which names
// the session dir to clear — is the only way out. The CTA handler is
// resolved in the component from this discriminator — no callbacks in the
// data, so the data stays serializable and easy to assert against.
type LaunchErrorCtaHandler = "retry" | "settings" | "logs" | "installer";

interface LaunchErrorCta {
  label: string;
  handler: LaunchErrorCtaHandler;
  variant: "primary" | "secondary";
}

const LAUNCH_ERROR_CTAS: Record<LaunchErrorKind, LaunchErrorCta[]> = {
  "mcp-server-not-started": [
    { label: "Retry", handler: "retry", variant: "primary" },
    { label: "Open settings", handler: "settings", variant: "secondary" },
  ],
  "mcp-probe-failed": [
    { label: "Retry", handler: "retry", variant: "primary" },
    { label: "Open settings", handler: "settings", variant: "secondary" },
  ],
  "skills-sync-failed": [
    { label: "Retry", handler: "retry", variant: "primary" },
    { label: "Open logs", handler: "logs", variant: "secondary" },
  ],
  "spawn-failed": [{ label: "Retry", handler: "retry", variant: "primary" }],
  "folder-unavailable": [
    { label: "Open logs", handler: "logs", variant: "secondary" },
    { label: "Open installer page", handler: "installer", variant: "primary" },
  ],
};

interface HelpPanelBannersProps {
  showResumeBanner: boolean;
  tierMismatch: TierMismatchState | null;
  launchError: LaunchErrorState | null;
  sessionRevoked: SessionRevokedState | null;
  isApprovingTier: boolean;
  activeGrant: ActiveGrantState | null;
  grantEnded: GrantEndedState | null;
  isRevokingGrant: boolean;
  onDismissResume: () => void;
  onDismissTierMismatch: () => void;
  onApproveOnce: () => void;
  onAlwaysAllow: () => void;
  onRevokeGrant: () => void;
  onDismissGrantEnded: () => void;
  onRetryLaunch: () => void;
  onDismissLaunchError: () => void;
  onOpenAssistantSettings: () => void;
  onOpenLogs: () => void;
  onOpenInstallerPage: () => void;
  onStartNewSession: () => void;
  onDismissSessionRevoked: () => void;
}

export function HelpPanelBanners({
  showResumeBanner,
  tierMismatch,
  launchError,
  sessionRevoked,
  isApprovingTier,
  activeGrant,
  grantEnded,
  isRevokingGrant,
  onDismissResume,
  onDismissTierMismatch,
  onApproveOnce,
  onAlwaysAllow,
  onRevokeGrant,
  onDismissGrantEnded,
  onRetryLaunch,
  onDismissLaunchError,
  onOpenAssistantSettings,
  onOpenLogs,
  onOpenInstallerPage,
  onStartNewSession,
  onDismissSessionRevoked,
}: HelpPanelBannersProps) {
  return (
    <>
      {showResumeBanner && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "flex items-start gap-2 px-3 py-2 mx-3 mt-3 mb-1",
            "rounded-[var(--radius-md)] bg-overlay-subtle border border-border-default",
            "text-xs text-text-primary"
          )}
          data-testid="help-resume-banner"
        >
          <span className="flex-1 select-text">Resumed your previous session.</span>
          <button
            type="button"
            onClick={onDismissResume}
            aria-label="Dismiss resume notice"
            className="text-daintree-text/50 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
      {activeGrant && (
        <GrantActiveBanner
          grant={activeGrant}
          isRevoking={isRevokingGrant}
          onRevoke={onRevokeGrant}
        />
      )}
      {grantEnded && <GrantEndedBanner grantEnded={grantEnded} onDismiss={onDismissGrantEnded} />}
      {tierMismatch && (
        <div
          role="alert"
          className={cn(
            "flex flex-col gap-2 px-3 py-2.5 mx-3 mt-3 mb-1",
            "rounded-[var(--radius-md)]",
            "bg-status-warning/10 border border-status-warning/20",
            "text-xs text-text-primary"
          )}
          data-testid="help-tier-mismatch-banner"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert
              className="w-3.5 h-3.5 shrink-0 mt-0.5 text-status-warning"
              aria-hidden="true"
            />
            <div className="flex-1 select-text">
              <p className="font-medium text-text-primary">Tool not permitted</p>
              <p className="mt-0.5 text-text-secondary">
                {tierMismatch.targetTier
                  ? `${tierMismatch.toolId} needs ${tierMismatch.targetTier} tier access.`
                  : `${tierMismatch.toolId} isn't available at any project tier.`}
              </p>
              {tierMismatch.targetTier && (
                <p className="mt-1 text-text-secondary">
                  Allowing the tool covers repeat calls for 15 minutes after the last one, 30 at
                  most. The project default applies to agents launched in this project, and raises
                  this session for 30 minutes.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onDismissTierMismatch}
              aria-label="Dismiss tier mismatch notice"
              className="text-daintree-text/50 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {tierMismatch.targetTier && (
            // Labels name the scope; the body above carries the windows. These
            // read "Approve once" and "Always allow for this project" before
            // #12119 and both overstated their mechanism. `onApproveOnce` mints
            // a *reusable* per-tool grant (15min sliding, 30min ceiling), so it
            // was never once. `onAlwaysAllow` does persist a project default for
            // new sessions, but lifts *this* session for only 30min of awake
            // time, so it was never always. Handler names and the main-process
            // comments keep the original spelling as the flow names (#8442,
            // #10042); this is the anchor that maps them to the shipped labels.
            <div className="flex items-center gap-2 flex-wrap pl-5">
              <button
                type="button"
                onClick={onApproveOnce}
                disabled={isApprovingTier}
                className={cn(
                  "px-2 py-1 rounded-[var(--radius-sm)] text-xs font-medium",
                  "bg-daintree-text/10 hover:bg-daintree-text/15 text-text-primary",
                  "disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                )}
              >
                Allow this tool
              </button>
              <button
                type="button"
                onClick={onAlwaysAllow}
                disabled={isApprovingTier}
                className={cn(
                  "px-2 py-1 rounded-[var(--radius-sm)] text-xs font-medium",
                  "bg-daintree-text/5 hover:bg-daintree-text/10 text-text-primary",
                  "disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                )}
              >
                Set project default
              </button>
              <button
                type="button"
                onClick={onDismissTierMismatch}
                disabled={isApprovingTier}
                className={cn(
                  "px-2 py-1 rounded-[var(--radius-sm)] text-xs",
                  "text-text-secondary hover:text-text-primary",
                  "disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                )}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {launchError && (
        <div
          role="alert"
          className={cn(
            "flex flex-col gap-2 px-3 py-2.5 mx-3 mt-3 mb-1",
            "rounded-[var(--radius-md)]",
            "bg-status-error/10 border border-status-error/20",
            "text-xs text-text-primary"
          )}
          data-testid="help-launch-error-banner"
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              className="w-3.5 h-3.5 shrink-0 mt-0.5 text-status-error"
              aria-hidden="true"
            />
            <div className="flex-1 select-text">
              <p className="font-medium text-text-primary">Assistant couldn't start</p>
              <p className="mt-0.5 text-text-secondary">{LAUNCH_ERROR_BODY[launchError.kind]}</p>
            </div>
            <button
              type="button"
              onClick={onDismissLaunchError}
              aria-label="Dismiss launch error"
              className="text-daintree-text/50 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap pl-5">
            {LAUNCH_ERROR_CTAS[launchError.kind].map((cta) => {
              const onClick =
                cta.handler === "retry"
                  ? onRetryLaunch
                  : cta.handler === "settings"
                    ? onOpenAssistantSettings
                    : cta.handler === "logs"
                      ? onOpenLogs
                      : onOpenInstallerPage;
              return (
                <button
                  key={cta.label}
                  type="button"
                  onClick={onClick}
                  className={cn(
                    "px-2 py-1 rounded-[var(--radius-sm)] text-xs",
                    cta.variant === "primary"
                      ? "font-medium bg-daintree-text/10 hover:bg-daintree-text/15 text-text-primary"
                      : "text-text-secondary hover:text-text-primary",
                    "transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                  )}
                >
                  {cta.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {sessionRevoked && (
        <div
          role="alert"
          className={cn(
            "flex flex-col gap-2 px-3 py-2.5 mx-3 mt-3 mb-1",
            "rounded-[var(--radius-md)]",
            "bg-status-error/10 border border-status-error/20",
            "text-xs text-text-primary"
          )}
          data-testid="help-session-revoked-banner"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert
              className="w-3.5 h-3.5 shrink-0 mt-0.5 text-status-error"
              aria-hidden="true"
            />
            <div className="flex-1 select-text">
              <p className="font-medium text-text-primary">Session ended</p>
              <p className="mt-0.5 text-text-secondary">
                This assistant session was stopped after too many blocked requests. Start a new
                session to continue.
              </p>
            </div>
            <button
              type="button"
              onClick={onDismissSessionRevoked}
              aria-label="Dismiss session ended notice"
              className="text-daintree-text/50 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap pl-5">
            <button
              type="button"
              onClick={onStartNewSession}
              className={cn(
                "px-2 py-1 rounded-[var(--radius-sm)] text-xs font-medium",
                "bg-daintree-text/10 hover:bg-daintree-text/15 text-text-primary",
                "transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
              )}
            >
              Start new session
            </button>
          </div>
        </div>
      )}
    </>
  );
}
