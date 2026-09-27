import { useEffect, useState } from "react";
import { Clock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import type {
  ActiveGrantState,
  GrantEndReason,
  GrantEndedState,
  LaunchErrorKind,
  LaunchErrorState,
  SessionRevokedState,
  TierMismatchState,
} from "@/controllers/HelpSessionController";

// Title keyed off how the grant ended (#10042). The tool id is the sentence
// subject, prepended by the caller — kept jargon-free per the microcopy rules
// (no "MCP" / "grant" / "tier").
const GRANT_ENDED_TITLE: Record<GrantEndReason, string> = {
  expired: "access expired",
  "grant-ceiling": "hit its 30-minute limit",
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

function ToolId({ id }: { id: string }) {
  return <span className="font-mono text-text-primary wrap-anywhere">{id}</span>;
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
    <InlineStatusBanner
      severity="neutral"
      layout="inline"
      animated={false}
      icon={ShieldCheck}
      role="status"
      ariaLive="polite"
      data-testid="help-grant-active-banner"
      title={
        <>
          <ToolId id={grant.toolId} /> approved
        </>
      }
      description={
        // The countdown re-derives every second; keep it out of the banner's
        // polite live region (`aria-live="off"`) so screen readers announce
        // the "<tool> approved" message once instead of the ticking time.
        <span aria-live="off">
          <span className="tabular-nums">{formatRemaining(remainingSeconds)}</span> left
        </span>
      }
      action={{
        id: "revoke",
        label: "Revoke access",
        variant: "primary",
        onClick: onRevoke,
        loading: isRevoking,
      }}
    />
  );
}

// Recovery copy keyed off the failure kind so the banner never leaks the
// underlying "MCP" / "token" / "bearer" jargon the controller catches.
const LAUNCH_ERROR_BODY: Record<LaunchErrorKind, string> = {
  "mcp-server-not-started":
    "Daintree's assistant services didn't start. Check assistant settings, then try again.",
  "mcp-probe-failed": "Daintree's assistant services didn't respond in time. Try again.",
  "skills-sync-failed":
    "Daintree couldn't load this project's assistant folder, so the session didn't start. Retry, or check the logs if it keeps failing.",
  "spawn-failed": "The agent didn't start. Try again.",
  // Same wording as the command/MCP path in `helpActions.ts` — one refusal,
  // one sentence, whichever surface the user hit it from.
  "mixed-agent-lanes":
    "Another session in this project is running a different agent. Sessions of one project share a folder and use one agent, so stop that session first or open this one with the same agent.",
  "folder-unavailable":
    "Daintree's bundled assistant files are missing. Reinstall Daintree or check the logs.",
};

// Per-kind recovery surface: one primary recovery (the banner's `action`) and
// at most one demoted affordance beside it. `folder-unavailable` is
// non-retryable: the resolver's module-scope cache returns the same null on
// retry, so the only honest affordances are the installer page and the error
// log. `Retry` is kept for the transient kinds (spawn/probe/server).
// `skills-sync-failed` pairs both: some causes clear on retry, but a corrupt
// manifest or an unremovable stale file fails identically forever, so the log
// — which names the session dir to clear — is the only way out.
// `mixed-agent-lanes` carries no CTA at all: the one way out is stopping the
// sibling session, which lives in another lane's tab, and every button this
// banner can offer would either fail identically (Retry) or point somewhere
// irrelevant. The body names the action; the dismiss × is the only control.
// The CTA handler is resolved in the component from this discriminator — no
// callbacks in the data, so the data stays serializable and easy to assert
// against.
type LaunchErrorCtaHandler = "retry" | "settings" | "logs" | "installer";

interface LaunchErrorCta {
  label: string;
  handler: LaunchErrorCtaHandler;
}

interface LaunchErrorCtas {
  primary?: LaunchErrorCta;
  secondary?: LaunchErrorCta;
}

const RETRY: LaunchErrorCta = { label: "Retry", handler: "retry" };
const OPEN_SETTINGS: LaunchErrorCta = { label: "Open settings", handler: "settings" };
const OPEN_LOGS: LaunchErrorCta = { label: "Open logs", handler: "logs" };

const LAUNCH_ERROR_CTAS: Record<LaunchErrorKind, LaunchErrorCtas> = {
  "mcp-server-not-started": { primary: RETRY, secondary: OPEN_SETTINGS },
  "mcp-probe-failed": { primary: RETRY, secondary: OPEN_SETTINGS },
  "skills-sync-failed": { primary: RETRY, secondary: OPEN_LOGS },
  "spawn-failed": { primary: RETRY },
  "mixed-agent-lanes": {},
  "folder-unavailable": {
    primary: { label: "Open installer page", handler: "installer" },
    secondary: OPEN_LOGS,
  },
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

/**
 * The banners stack most-urgent first — a stopped session or a failed launch,
 * then a tool call waiting on the user, then the ambient grant state and the
 * advisories — so the first Tab stop into the stack is the thing that is
 * blocking the agent.
 */
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
  // `isApprovingTier` says a request is in flight but not which button sent
  // it; remember the click so only that one shows the spinner.
  const [approvalSource, setApprovalSource] = useState<"tool" | "project">("tool");

  const ctaHandler = (handler: LaunchErrorCtaHandler) =>
    handler === "retry"
      ? onRetryLaunch
      : handler === "settings"
        ? onOpenAssistantSettings
        : handler === "logs"
          ? onOpenLogs
          : onOpenInstallerPage;

  const launchCtas = launchError ? LAUNCH_ERROR_CTAS[launchError.kind] : {};

  // Labels name the scope; the body carries the windows. These read "Approve
  // once" and "Always allow for this project" before #12119 and both
  // overstated their mechanism. `onApproveOnce` mints a *reusable* per-tool
  // grant (15min sliding, 30min ceiling), so it was never once. `onAlwaysAllow`
  // does persist a project default for the project's own agent panes — never
  // for new help sessions, which provision from the global settings tier — but
  // lifts *this* session for only 30min of awake time, so it was never always.
  // Handler names and the main-process comments keep the original spelling as
  // the flow names (#8442, #10042); this is the anchor that maps them to the
  // shipped labels. The narrower grant leads; the project write is demoted.
  const tierActions: BannerAction[] = [
    {
      id: "allow-tool",
      label: "Allow this tool",
      variant: "primary",
      onClick: () => {
        setApprovalSource("tool");
        onApproveOnce();
      },
      loading: isApprovingTier && approvalSource === "tool",
      disabled: isApprovingTier,
    },
    {
      id: "project-default",
      label: "Set project default",
      variant: "dismiss",
      onClick: () => {
        setApprovalSource("project");
        onAlwaysAllow();
      },
      loading: isApprovingTier && approvalSource === "project",
      disabled: isApprovingTier,
    },
  ];

  // "Resumed your previous session" says nothing the user needs while
  // something is blocking the agent, and at the panel's minimum width it is
  // the row that pushes the terminal out of view. It waits, undismissed,
  // until the blocker clears.
  const isBlocked = !!sessionRevoked || !!launchError || !!tierMismatch;

  return (
    <>
      {sessionRevoked && (
        <InlineStatusBanner
          severity="error"
          animated={false}
          data-testid="help-session-revoked-banner"
          title="Session ended"
          description="This assistant session was stopped after too many blocked requests. Start a new session to continue."
          action={{
            id: "start-new-session",
            label: "Start new session",
            variant: "primary",
            onClick: onStartNewSession,
          }}
          onClose={onDismissSessionRevoked}
          closeAriaLabel="Dismiss session ended notice"
        />
      )}
      {launchError && (
        <InlineStatusBanner
          severity="error"
          animated={false}
          data-testid="help-launch-error-banner"
          title="Assistant couldn't start"
          description={LAUNCH_ERROR_BODY[launchError.kind]}
          action={
            launchCtas.primary && {
              id: launchCtas.primary.handler,
              label: launchCtas.primary.label,
              variant: "primary",
              onClick: ctaHandler(launchCtas.primary.handler),
            }
          }
          trailingSlot={
            launchCtas.secondary && (
              <Button variant="ghost" size="sm" onClick={ctaHandler(launchCtas.secondary.handler)}>
                {launchCtas.secondary.label}
              </Button>
            )
          }
          onClose={onDismissLaunchError}
          closeAriaLabel="Dismiss launch error"
        />
      )}
      {tierMismatch && (
        <InlineStatusBanner
          severity="warning"
          animated={false}
          data-testid="help-tier-mismatch-banner"
          title="Tool not permitted"
          description={
            tierMismatch.targetTier ? (
              <>
                <ToolId id={tierMismatch.toolId} /> needs the {tierMismatch.targetTier} tool set.
              </>
            ) : (
              <>
                <ToolId id={tierMismatch.toolId} /> isn't in either tool set.
              </>
            )
          }
          descriptionExtras={
            tierMismatch.targetTier && (
              <p className="text-xs mt-1 text-text-secondary">
                Allowing the tool covers repeat calls for 15 minutes after the last one, 30 at most.
                The project default applies to Claude Code and Daintree Assistant panes launched in
                this project, and raises this session for 30 minutes.
              </p>
            )
          }
          actions={tierMismatch.targetTier ? tierActions : undefined}
          onClose={onDismissTierMismatch}
          // The × is the decline: a Cancel beside it ran the same handler and
          // cost a row of its own at the panel's minimum width. Inert while an
          // approval is in flight, which would otherwise be stranded with no
          // banner to report its outcome.
          closeDisabled={isApprovingTier}
          closeAriaLabel="Dismiss tier mismatch notice"
        />
      )}
      {activeGrant && (
        <GrantActiveBanner
          grant={activeGrant}
          isRevoking={isRevokingGrant}
          onRevoke={onRevokeGrant}
        />
      )}
      {grantEnded && (
        // Neutral, not an error tint — nothing failed; the user's approval
        // simply timed out and the next call re-prompts. Auto-dismisses on a
        // controller timer; also manually dismissible.
        <InlineStatusBanner
          severity="neutral"
          layout="inline"
          animated={false}
          icon={Clock}
          role="status"
          ariaLive="polite"
          data-testid="help-grant-ended-banner"
          title={
            <>
              <ToolId id={grantEnded.toolId} /> {GRANT_ENDED_TITLE[grantEnded.reason]}
            </>
          }
          description="The next call will ask to approve it again."
          onClose={onDismissGrantEnded}
          closeAriaLabel="Dismiss approval notice"
        />
      )}
      {showResumeBanner && !isBlocked && (
        <InlineStatusBanner
          severity="neutral"
          layout="inline"
          animated={false}
          role="status"
          ariaLive="polite"
          data-testid="help-resume-banner"
          title="Resumed your previous session"
          onClose={onDismissResume}
          closeAriaLabel="Dismiss resume notice"
        />
      )}
    </>
  );
}
