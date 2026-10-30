import { useEffect, useState } from "react";
import { useHelpSessionLiveStatus } from "@/hooks";
import { getViewHostId } from "@/hooks/useHostConnection";
import { getAgentConfig } from "@/config/agents";
import { useHelpPanelStore, selectActiveSlot } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { Button } from "@/components/ui/button";
import { trimSessionTabTitle } from "@/components/HelpPanel/sessionTabTitle";
import { getTerminalTaskTitle } from "@/utils/terminalTitleDisplay";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isPtyPanel } from "@shared/types/panel";
import { isSameAssistantRun } from "@shared/types/agentDirectory";
import type { GlobalAssistantView } from "@shared/types/ipc/help";
import type { HelpAssistantTier, HelpSessionActiveGrant } from "@shared/types";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";
import { StatusLine, TabError } from "./AssistantStatus";
import { GrantCountdown } from "./GrantCountdown";
import { NativeGrantsSection } from "./NativeGrantsSection";
import { TIER_RANK, TIER_SHORT_LABEL } from "./assistantTiers";

interface SessionLiveStatusCardProps {
  configuredTier: HelpAssistantTier;
}

function agentName(agentId: string): string {
  return getAgentConfig(agentId)?.name ?? agentId;
}

/**
 * Which conversation the card describes, in the dock's own words: its scope
 * switch ("Project", "Global"), the lane's tab label, and the agent running it.
 */
function SessionIdentity({
  scope,
  name,
  agentId,
}: {
  scope: "Project" | "Global";
  name?: string;
  agentId: string | null;
}) {
  return (
    <div data-testid="assistant-live-session-identity">
      {scope}
      {name && (
        <>
          {" · "}
          <span className="text-text-primary">{name}</span>
        </>
      )}
      {agentId && ` · ${agentName(agentId)}`}
    </div>
  );
}

// Live status of the conversation the Assistant panel is showing in this view —
// distinct from the configured-default tier select above. It names that
// conversation before anything else, because the panel can show one of several
// project lanes or the global assistant, and a grant approved here goes to
// exactly the one named.
export function SessionLiveStatusCard({ configuredTier }: SessionLiveStatusCardProps) {
  const globalSelected = useHelpPanelStore((s) => s.globalSelected);
  return (
    <SettingsGroup>
      {globalSelected ? <GlobalSessionRow /> : <ProjectLaneRow configuredTier={configuredTier} />}
    </SettingsGroup>
  );
}

// Renders from safe `connected: false` defaults immediately (no spinner, per the
// settings-tab loading rule) and populates when the live-status bridge call
// resolves. Live-tier *change* events while this is open aren't pushed (the
// grant-lifecycle push carries no tier field — covered by #10027); the snapshot
// refreshes on mount and on any grant-lifecycle event for this session.
function ProjectLaneRow({ configuredTier }: SessionLiveStatusCardProps) {
  const slot = useHelpPanelStore((s) => s.activeSlot);
  const sessionId = useHelpPanelStore((s) => selectActiveSlot(s).sessionId);
  const laneAgentId = useHelpPanelStore((s) => selectActiveSlot(s).agentId);
  const terminalId = useHelpPanelStore((s) => selectActiveSlot(s).terminalId);
  // The tab's name for the lane: its observed task title when the dock shows
  // one, otherwise `Session N` by slot, as useHelpSessionLanes labels it.
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);
  const taskTitle = usePanelStore((s) => {
    if (showAgentTaskTitles === false || !terminalId) return null;
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) ? getTerminalTaskTitle(panel) : null;
  });
  const task = trimSessionTabTitle(taskTitle);
  const laneName = task ? `'${task.fullTitle}'` : `Session ${slot + 1}`;

  const { connected, tier, activeGrants } = useHelpSessionLiveStatus(sessionId);
  const perToolGrants = activeGrants.filter((g) => g.kind !== "native");
  const nativeGrants = activeGrants.filter((g) => g.kind === "native");
  // Three-way relation to the configured default: a renderer-approved elevation
  // raises the live tier above it, but a session can also sit *below* it (e.g.
  // a per-session choice or a decayed elevation) — both must read truthfully,
  // not collapse to "matches".
  const tierDelta = TIER_RANK[tier] - TIER_RANK[configuredTier];
  const tierComparisonCopy =
    tierDelta > 0
      ? ` — elevated above the configured ${TIER_SHORT_LABEL[configuredTier].toLowerCase()} default`
      : tierDelta < 0
        ? ` — below the configured ${TIER_SHORT_LABEL[configuredTier].toLowerCase()} default`
        : " — matches the configured default";

  return (
    <SettingsRow
      label="Live session"
      accessory={
        connected ? (
          <span className="px-1.5 py-0.5 rounded-[var(--radius-sm)] text-3xs font-mono bg-surface-canvas border border-border-default text-text-secondary">
            {TIER_SHORT_LABEL[tier]}
          </span>
        ) : undefined
      }
      description={
        <div className="space-y-1">
          <SessionIdentity scope="Project" name={laneName} agentId={laneAgentId} />
          {connected ? (
            <StatusLine tone="ok">
              Running the{" "}
              <span className="text-text-primary">{TIER_SHORT_LABEL[tier].toLowerCase()}</span> tool
              set
              {tierComparisonCopy}
            </StatusLine>
          ) : sessionId || terminalId ? (
            // A lane with a session can be running without a live MCP transport
            // (still starting, or reconnecting): that is all the snapshot says.
            <StatusLine tone="idle">
              Not connected to Daintree's tools, so its live tool set and grants can't be shown
            </StatusLine>
          ) : (
            <StatusLine tone="idle">
              None. Open the assistant to start one; its live tool set and grants show here.
            </StatusLine>
          )}
        </div>
      }
      layout={connected ? "stacked" : "inline"}
      control={
        connected ? (
          <div className="space-y-2">
            {perToolGrants.length > 0 ? (
              <div className="space-y-1">
                <div className="text-xs text-text-secondary font-mono">
                  Active grants ({perToolGrants.length})
                </div>
                {/* Keyed by session so a pending revoke or its error never
                    carries over to another session's grants. */}
                <PerToolGrantList key={sessionId} grants={perToolGrants} />
              </div>
            ) : (
              <div className="text-2xs text-text-secondary">No per-tool grants active</div>
            )}
            {/* Keyed by session too: tools picked for one conversation must never
                be approved for the next one the card names, and an approval
                still in flight for the last one must not clear or fail this
                one's form. */}
            {sessionId && (
              <NativeGrantsSection
                key={sessionId}
                helpSessionId={sessionId}
                grants={nativeGrants}
              />
            )}
          </div>
        ) : undefined
      }
    />
  );
}

/**
 * The global assistant, when the dock shows it. It isn't a project lane and
 * isn't pinned to this view, so its tool set and grants can't be read or
 * approved from here; the card observes its run through main's broadcast and
 * never attaches a reader, which only the dock's pane does.
 */
function GlobalSessionRow() {
  const target = useHelpPanelStore((s) => s.globalTarget);
  // A window bound to another host reaches that host's assistants, not this one's.
  const boundElsewhere = getViewHostId() !== null;
  const [view, setView] = useState<GlobalAssistantView | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (boundElsewhere) return;
    const help = window.electron.help;
    let disposed = false;
    let pushed = false;
    // Subscribed before reading: a change pushed while the read is in flight is
    // at least as new as its answer, so the answer never overwrites it.
    const off = help.onGlobalAssistantChanged((state) => {
      if (disposed) return;
      pushed = true;
      setReadFailed(false);
      setView(state);
    });
    help.getGlobalAssistantState().then(
      (state) => {
        if (!disposed && !pushed) setView(state);
      },
      (err: unknown) => {
        if (disposed || pushed) return;
        logError("DaintreeAssistant: getGlobalAssistantState failed", err);
        setReadFailed(true);
      }
    );
    return () => {
      disposed = true;
      off();
    };
  }, [boundElsewhere, attempt]);

  const subject = view?.phase === "running" ? (view.subject ?? null) : null;
  // The run "Open in Assistant" chose, gone by now: said, as the dock says it,
  // and its successor's agent is never named in its place.
  const targetEnded = target !== null && view !== null && !isSameAssistantRun(subject, target);
  const agentId = !boundElsewhere && !targetEnded ? (view?.agentId ?? null) : null;

  return (
    <SettingsRow
      label="Live session"
      description={
        <div className="space-y-1">
          <SessionIdentity scope="Global" agentId={agentId} />
          {boundElsewhere ? (
            <StatusLine tone="idle">
              This window runs on another host. Open the global assistant from a window on this
              machine.
            </StatusLine>
          ) : readFailed ? (
            <TabError
              onRetry={() => {
                setReadFailed(false);
                setAttempt((n) => n + 1);
              }}
            >
              Couldn't read the global assistant's state
            </TabError>
          ) : view === null ? null : targetEnded ? (
            <StatusLine tone="idle">The global assistant session you opened has ended</StatusLine>
          ) : view.phase === "running" ? (
            <StatusLine tone="ok">
              Running. Its tool set and grants can't be shown or approved here.
            </StatusLine>
          ) : view.phase === "launching" ? (
            <StatusLine tone="idle">Starting…</StatusLine>
          ) : (
            <StatusLine tone="idle">
              Not running. Start it from Global in the assistant panel.
            </StatusLine>
          )}
        </div>
      }
    />
  );
}

// Each per-tool grant ends on its own, leaving the session's other grants live
// (#14975). One click, no confirm: re-approving is one tool call away. The
// grant-lifecycle push that follows a revoke re-pulls the snapshot, which is
// what removes the row; a failure leaves it up as its own retry.
function PerToolGrantList({ grants }: { grants: HelpSessionActiveGrant[] }) {
  const [revoking, setRevoking] = useState<readonly string[]>([]);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const revoke = (grant: HelpSessionActiveGrant) => {
    setRevoking((current) => [...current, grant.toolId]);
    setRevokeError(null);
    safeFireAndForget(
      window.electron.mcpServer
        .revokeGrant({ sessionId: grant.sessionId, toolId: grant.toolId })
        .then(() => undefined)
        .catch((err: unknown) => {
          setRevokeError(formatErrorMessage(err, "Couldn't revoke grant"));
          logError("DaintreeAssistant: revokeGrant failed", err);
        })
        .finally(() => {
          setRevoking((current) => current.filter((toolId) => toolId !== grant.toolId));
        }),
      { context: "DaintreeAssistant:revokeGrant" }
    );
  };

  return (
    <div className="space-y-1">
      {grants.map((grant) => (
        <div key={grant.toolId} className="flex items-center justify-between gap-2 text-2xs">
          <span className="font-mono text-text-secondary break-all">{grant.toolId}</span>
          <span className="flex shrink-0 items-center gap-2">
            <GrantCountdown expiresAt={grant.expiresAt} maxExpiresAt={grant.maxExpiresAt} />
            <Button
              variant="ghost-danger"
              size="xs"
              aria-label={`Revoke ${grant.toolId}`}
              loading={revoking.includes(grant.toolId)}
              onClick={() => revoke(grant)}
            >
              Revoke
            </Button>
          </span>
        </div>
      ))}
      {revokeError && <TabError>{revokeError}</TabError>}
    </div>
  );
}
