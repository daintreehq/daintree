import { useCallback, useState } from "react";
import { TriangleAlert } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import {
  RATE_LIMIT_OBSERVATION_TTL_MS,
  isRateLimitObservationLive,
  useRateLimitObservationStore,
} from "@/store/rateLimitObservationStore";
import { formatRateLimitCountdownCoarse } from "@/components/Layout/RateLimitDetails";
import { formatTimeAgo } from "@/utils/timeAgo";
import { cn } from "@/lib/utils";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
} from "./terminalHeaderChip";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import type { ActionSource } from "@shared/types/actions";
import {
  RestartOnPresetConfirmDialog,
  RestartOnPresetDropdownItems,
  type RestartOnPresetRequest,
} from "./RestartOnPreset";
import { useRestartPresetChoices } from "./restartOnPresetChoices";

/**
 * Ambient header chip on a pane whose agent printed a rate-limit banner
 * (#12797). What was seen in this pane's output and when — not the account's
 * quota, which lives in Settings and is never inferred from this. When the
 * agent has other presets, the chip opens a menu to restart on one (#13746) —
 * the user's call, never made for them.
 */
export function TerminalRateLimitBadge({ terminalId }: { terminalId: string }) {
  const observedAt = useRateLimitObservationStore((s) => s.observedAtByTerminalId[terminalId]);
  if (observedAt === undefined) return null;
  return <RateLimitChip terminalId={terminalId} observedAt={observedAt} />;
}

const CHIP_SOURCE: { readonly current: ActionSource } = { current: "user" };

// Split out so only a pane that has an observation subscribes to the clock.
function RateLimitChip({ terminalId, observedAt }: { terminalId: string; observedAt: number }) {
  const now = useGlobalMinuteClock();
  const agentId = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) && !panel.restoreRecovery ? panel.launchAgentId : undefined;
  });
  const presetId = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) ? panel.agentPresetId : undefined;
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [request, setRequest] = useState<RestartOnPresetRequest | null>(null);
  const closeRequest = useCallback(() => setRequest(null), []);
  const live = isRateLimitObservationLive(observedAt, now);
  // An expired chip takes its menu with it, so the quota stops being read too,
  // and a later observation doesn't bring the chip back with the menu open.
  if (!live && menuOpen) setMenuOpen(false);
  const choices = useRestartPresetChoices(agentId, presetId, menuOpen && live);

  const confirmDialog = (
    <RestartOnPresetConfirmDialog
      request={request}
      onClose={closeRequest}
      sourceRef={CHIP_SOURCE}
    />
  );
  // A confirm already asked outlives the chip: the user's answer still counts.
  if (!live) return request ? confirmDialog : null;

  const chipClass = cn(
    HEADER_CHIP_CLASS,
    HEADER_CHIP_SURFACE,
    HEADER_CHIP_FOCUS_CLASS,
    "text-status-warning"
  );
  const chipContent = (
    <>
      <TriangleAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
      {/* Warning ink stays on the glyph; the label needs the primary ramp to
          hold 4.5:1 on the light themes. Yields first on a narrow header. */}
      <span className="text-text-primary @max-[420px]/header:sr-only">Rate limit reported</span>
    </>
  );
  const tooltipBody = (
    <TooltipContent side="bottom" className="max-w-xs">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">
          Agent printed a rate-limit message {formatTimeAgo(observedAt, now)}
        </span>
        {/* The chip's own retention, never the provider's reset: nothing here
            reads when the limit lifts, so the user is pointed at the message. */}
        <span>Check that message for when the limit resets</span>
        <span>
          This chip clears in{" "}
          {formatRateLimitCountdownCoarse(observedAt + RATE_LIMIT_OBSERVATION_TTL_MS - now)}
        </span>
      </div>
    </TooltipContent>
  );

  if (agentId && choices.length > 0) {
    return (
      <>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <Tooltip autoDismiss={false} disableHoverableContent={false}>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={chipClass}
                  aria-haspopup="menu"
                  data-testid="terminal-rate-limit-badge"
                >
                  {chipContent}
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {tooltipBody}
          </Tooltip>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            <DropdownMenuLabel>Restart on preset</DropdownMenuLabel>
            <RestartOnPresetDropdownItems
              agentId={agentId}
              choices={choices}
              onPick={(preset) => {
                const panel = usePanelStore.getState().panelsById[terminalId];
                setRequest({
                  terminalId,
                  terminalTitle: panel?.title,
                  agentWorking: terminalHasRunningAgentSession(panel),
                  preset,
                });
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        {confirmDialog}
      </>
    );
  }

  // The body is guidance to read, not a hint, so it stays while hovered.
  return (
    <Tooltip autoDismiss={false} disableHoverableContent={false}>
      <TooltipTrigger asChild>
        <div
          className={chipClass}
          role="status"
          aria-live="off"
          tabIndex={0}
          data-testid="terminal-rate-limit-badge"
        >
          {chipContent}
        </div>
      </TooltipTrigger>
      {tooltipBody}
    </Tooltip>
  );
}
