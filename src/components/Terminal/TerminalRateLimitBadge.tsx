import { useCallback, useState } from "react";
import { TriangleAlert } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
  HEADER_CHIP_TRIGGER_CLASS,
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
import {
  RestartOnAccountConfirmDialog,
  RestartOnAccountDropdownItems,
  useRestartAccountChoices,
  type RestartOnAccountRequest,
} from "./RestartOnAccount";
import { useRestartPresetChoices } from "./restartOnPresetChoices";

/**
 * Ambient header chip on a pane whose agent printed a rate-limit banner
 * (#12797). What was seen in this pane's output and when — not the account's
 * quota, which lives in Settings and is never inferred from this. When the
 * agent has other accounts (#16040) or presets (#13746), the chip opens a menu
 * to restart on one — the user's call, never made for them.
 */
export function TerminalRateLimitBadge({ terminalId }: { terminalId: string }) {
  const observedAt = useRateLimitObservationStore((s) => s.observedAtByTerminalId[terminalId]);
  // Held here, above the chip: a confirm already asked outlives the chip, which
  // goes the moment its observation expires or is pruned, and the user's answer
  // still counts.
  const [request, setRequest] = useState<RestartOnPresetRequest | null>(null);
  const closeRequest = useCallback(() => setRequest(null), []);
  const [accountRequest, setAccountRequest] = useState<RestartOnAccountRequest | null>(null);
  const closeAccountRequest = useCallback(() => setAccountRequest(null), []);
  return (
    <>
      {observedAt !== undefined && (
        <RateLimitChip
          terminalId={terminalId}
          observedAt={observedAt}
          onPick={setRequest}
          onPickAccount={setAccountRequest}
        />
      )}
      <RestartOnPresetConfirmDialog
        request={request}
        onClose={closeRequest}
        sourceRef={CHIP_SOURCE}
      />
      <RestartOnAccountConfirmDialog
        request={accountRequest}
        onClose={closeAccountRequest}
        sourceRef={CHIP_SOURCE}
      />
    </>
  );
}

const CHIP_SOURCE: { readonly current: ActionSource } = { current: "user" };

// Split out so only a pane that has an observation subscribes to the clock.
function RateLimitChip({
  terminalId,
  observedAt,
  onPick,
  onPickAccount,
}: {
  terminalId: string;
  observedAt: number;
  onPick: (request: RestartOnPresetRequest) => void;
  onPickAccount: (request: RestartOnAccountRequest) => void;
}) {
  const now = useGlobalMinuteClock();
  const agentId = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) && !panel.restoreRecovery ? panel.launchAgentId : undefined;
  });
  const presetId = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) ? panel.agentPresetId : undefined;
  });
  const accountId = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) ? panel.agentAccountId : undefined;
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const live = isRateLimitObservationLive(observedAt, now);
  // An expired chip takes its menu with it, so the quota stops being read too,
  // and a later observation doesn't bring the chip back with the menu open.
  if (!live && menuOpen) setMenuOpen(false);
  // A pane on an account keeps it across a preset switch, so a preset's own
  // home says nothing about the quota it would run on: no hints then.
  const choices = useRestartPresetChoices(agentId, presetId, menuOpen && live && !accountId);
  const accountChoices = useRestartAccountChoices(agentId, accountId);

  if (!live) return null;

  const chipClass = cn(
    HEADER_CHIP_CLASS,
    HEADER_CHIP_SURFACE,
    HEADER_CHIP_FOCUS_CLASS,
    "text-status-warning"
  );
  const chipContent = (
    <>
      {/* A 16px line box around the glyph, so the chip keeps the row's height
          when a narrow header takes the label out of flow. */}
      <span className="inline-flex h-4 shrink-0 items-center">
        <TriangleAlert className="w-3 h-3" aria-hidden="true" />
      </span>
      {/* Warning ink stays on the glyph; the label takes the row's secondary
          ink like every other chip, which holds 4.5:1 where the warning hue
          would not, and never outweighs an unfocused pane's title. Yields
          first on a narrow header. */}
      <span className="text-text-secondary @max-[420px]/header:sr-only">Rate limit reported</span>
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

  if (agentId && (choices.length > 0 || accountChoices.length > 0)) {
    return (
      <>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <Tooltip autoDismiss={false} disableHoverableContent={false}>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(chipClass, HEADER_CHIP_TRIGGER_CLASS)}
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
            {/* An account switch keeps the pane's preset (#16040), so it goes
                first: it's the move that changes only who pays. */}
            {accountChoices.length > 0 && (
              <>
                <DropdownMenuLabel>Switch account</DropdownMenuLabel>
                <RestartOnAccountDropdownItems
                  choices={accountChoices}
                  onPick={(account) => {
                    const panel = usePanelStore.getState().panelsById[terminalId];
                    onPickAccount({
                      terminalId,
                      terminalTitle: panel?.title,
                      agentWorking: terminalHasRunningAgentSession(panel),
                      account,
                    });
                  }}
                />
              </>
            )}
            {accountChoices.length > 0 && choices.length > 0 && <DropdownMenuSeparator />}
            {choices.length > 0 && (
              <>
                <DropdownMenuLabel>Restart on preset</DropdownMenuLabel>
                <RestartOnPresetDropdownItems
                  agentId={agentId}
                  choices={choices}
                  onPick={(preset) => {
                    const panel = usePanelStore.getState().panelsById[terminalId];
                    onPick({
                      terminalId,
                      terminalTitle: panel?.title,
                      agentWorking: terminalHasRunningAgentSession(panel),
                      preset,
                    });
                  }}
                />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
