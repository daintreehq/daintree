import { useHelpSessionLiveStatus } from "@/hooks";
import { useHelpPanelStore, selectActiveSlot } from "@/store/helpPanelStore";
import type { HelpAssistantTier } from "@shared/types";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";
import { StatusLine } from "./AssistantStatus";
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
                  <div className="space-y-1">
                    {perToolGrants.map((grant) => (
                      <div
                        key={grant.toolId}
                        className="flex items-center justify-between gap-2 text-2xs"
                      >
                        <span className="font-mono text-text-secondary break-all">
                          {grant.toolId}
                        </span>
                        <GrantCountdown expiresAt={grant.expiresAt} />
                      </div>
                    ))}
                  </div>
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
