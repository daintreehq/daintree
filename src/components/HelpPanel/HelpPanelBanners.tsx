import { useState } from "react";
import { formatCountdown } from "@/utils/formatCountdown";
import { grantDeadline } from "@/utils/grantDeadline";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { pluralize } from "@/lib/pluralize";
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

// The countdowns re-derive from each grant's deadline once a second — the
// tick only drives a re-render, it isn't the source of truth, so a missed beat
// can't drift the displayed value.
const COUNTDOWN_TICK_MS = 1000;

function ToolId({ id }: { id: string }) {
  return <span className="font-mono text-text-primary wrap-anywhere">{id}</span>;
}

/** What a grant approves: its tool, or the tools a native automation grant covers. */
function grantSubject(grant: ActiveGrantState): string {
  if (grant.grantId === undefined) return grant.toolId;
  return grant.allowedTools?.length ? grant.allowedTools.join(", ") : "Automation grant";
}

/**
 * "4m 59s left", against the earlier of the sliding expiry and the 30-minute
 * ceiling. The grant is sliding-TTL: the countdown is "time left if the tool
 * isn't used again," and each use's `grant.refreshed` push moves it (#14998).
 * Once the ceiling ends the grant first, no use can, so the countdown says so.
 * Kept out of the banner's polite live region (`aria-live="off"`) so screen
 * readers announce the approval once instead of the ticking time.
 */
function GrantTimeLeft({ grant, now }: { grant: ActiveGrantState; now: number }) {
  const { endsAt, atCeiling } = grantDeadline(grant.expiresAt, grant.maxExpiresAt);
  const remainingSeconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return (
    <span aria-live="off">
      <span className="tabular-nums">{formatCountdown(remainingSeconds)}</span> left
      {atCeiling && " · 30-minute limit"}
    </span>
  );
}

/**
 * Ambient countdown for the session's live grants (#10042), minted by the
 * tier-mismatch banner's "Allow this tool" or as automation grants in
 * Settings. Tier 1 — a non-blocking pane-chrome state, not a toast. A session
 * can hold several at once, so every one gets its own countdown and its own
 * revoke, which ends that grant alone (#14975). One tick drives every
 * countdown; each derives from its grant's deadline, so a missed tick can't
 * drift the displayed value.
 */
function GrantActiveBanner({
  grants,
  revokingKeys,
  onRevoke,
}: {
  grants: readonly ActiveGrantState[];
  revokingKeys: readonly string[];
  onRevoke: (key: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useVisibilityAwareInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);

  const [only] = grants;
  if (grants.length === 1 && only) {
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
            <ToolId id={grantSubject(only)} /> approved
          </>
        }
        description={<GrantTimeLeft grant={only} now={now} />}
        action={{
          id: "revoke",
          label: "Revoke access",
          variant: "primary",
          onClick: () => onRevoke(only.key),
          loading: revokingKeys.includes(only.key),
        }}
      />
    );
  }

  return (
    <InlineStatusBanner
      severity="neutral"
      layout="stacked"
      animated={false}
      icon={ShieldCheck}
      role="status"
      ariaLive="polite"
      data-testid="help-grant-active-banner"
      title={`${pluralize(grants.length, "approval")} active`}
      descriptionExtras={
        <ul className="mt-1 space-y-1">
          {grants.map((grant) => {
            const subject = grantSubject(grant);
            return (
              <li key={grant.key} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1">
                  <ToolId id={subject} />
                  <span className="text-text-secondary">
                    {" · "}
                    <GrantTimeLeft grant={grant} now={now} />
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0"
                  aria-label={`Revoke access to ${subject}`}
                  loading={revokingKeys.includes(grant.key)}
                  onClick={() => onRevoke(grant.key)}
                >
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      }
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
  // Same wording as the command/MCP path in `helpActions.impl.ts` — one refusal,
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
  activeGrants: readonly ActiveGrantState[];
  grantEnded: GrantEndedState | null;
  revokingGrantKeys: readonly string[];
  onDismissResume: () => void;
  onDismissTierMismatch: () => void;
  onApproveOnce: () => void;
  onAlwaysAllow: () => void;
  onRevokeGrant: (key: string) => void;
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
  activeGrants,
  grantEnded,
  revokingGrantKeys,
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
                The project default gives the {tierMismatch.targetTier} tool set to agents launched
                in this project that support Daintree tools, and raises this session for 30 minutes.
                New assistant sessions use the tool set in{" "}
                {/* Live while an approval is in flight: opening a settings tab
                    neither dismisses this banner nor races the approval. */}
                <Button variant="link" className="text-xs" onClick={onOpenAssistantSettings}>
                  Assistant settings
                </Button>
                .
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
      {activeGrants.length > 0 && (
        <GrantActiveBanner
          grants={activeGrants}
          revokingKeys={revokingGrantKeys}
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
