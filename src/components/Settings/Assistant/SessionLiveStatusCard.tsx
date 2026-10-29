import { useState } from "react";
import { useHelpSessionLiveStatus } from "@/hooks";
import { useHelpPanelStore, selectActiveSlot } from "@/store/helpPanelStore";
import { Button } from "@/components/ui/button";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { HelpAssistantTier, HelpSessionActiveGrant } from "@shared/types";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";
import { StatusLine, TabError } from "./AssistantStatus";
import { GrantCountdown } from "./GrantCountdown";
import { NativeGrantsSection } from "./NativeGrantsSection";
import { TIER_RANK, TIER_SHORT_LABEL } from "./assistantTiers";

interface SessionLiveStatusCardProps {
  configuredTier: HelpAssistantTier;
}

// Live status of the *currently pinned* help session — distinct from the
// configured-default tier select above. Renders from safe `connected: false`
// defaults immediately (no spinner, per the settings-tab loading rule) and
// populates when the live-status bridge call resolves. Live-tier *change*
// events while this is open aren't pushed (the grant-lifecycle push carries no
// tier field — covered by #10027); the snapshot refreshes on mount and on any
// grant-lifecycle event for this session.
export function SessionLiveStatusCard({ configuredTier }: SessionLiveStatusCardProps) {
  const sessionId = useHelpPanelStore((s) => selectActiveSlot(s).sessionId);
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
    <SettingsGroup>
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
          connected ? (
            <StatusLine tone="ok">
              Running the{" "}
              <span className="text-text-primary">{TIER_SHORT_LABEL[tier].toLowerCase()}</span> tool
              set
              {tierComparisonCopy}
            </StatusLine>
          ) : (
            <StatusLine tone="idle">
              None. Open the assistant to start one; its live tool set and grants show here.
            </StatusLine>
          )
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
                  <PerToolGrantList grants={perToolGrants} />
                </div>
              ) : (
                <div className="text-2xs text-text-secondary">No per-tool grants active</div>
              )}
              {sessionId && <NativeGrantsSection helpSessionId={sessionId} grants={nativeGrants} />}
            </div>
          ) : undefined
        }
      />
    </SettingsGroup>
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
