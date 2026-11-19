import { useCallback, useEffect, useState } from "react";
import { AlarmClock, AlarmClockCheck, TriangleAlert } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { useTerminalInputBlock } from "@/hooks/useHostConnection";
import {
  RATE_LIMIT_OBSERVATION_TTL_MS,
  isRateLimitObservationLive,
  useRateLimitObservationStore,
} from "@/store/rateLimitObservationStore";
import { useCodexLimitContinueStore } from "@/store/codexLimitContinueStore";
import { codexLimitContinueClient } from "@/clients/codexLimitContinueClient";
import { formatRateLimitCountdownCoarse } from "@/components/Layout/RateLimitDetails";
import { formatTimeAgo } from "@/utils/timeAgo";
import { isClientAppError } from "@/utils/clientAppError";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
  HEADER_CHIP_TRIGGER_CLASS,
} from "./terminalHeaderChip";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import type { CodexLimitContinueState } from "@shared/types/codexLimitContinuation";
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
import {
  canShowLimitContinue,
  describeLimitContinue,
  type LimitContinueChip,
} from "./limitContinueChipModel";

/**
 * Ambient header chip on a pane whose agent printed a rate-limit banner
 * (#12797). What was seen in this pane's output and when — not the account's
 * quota, which lives in Settings and is never inferred from this. When the
 * agent has other accounts (#16040) or presets (#13746), the chip opens a menu
 * to restart on one — the user's call, never made for them.
 *
 * For a pane armed to continue once its limit resets (#17909), the same chip
 * says when it will (#17911), for the whole wait, then how the wait ended,
 * as main recorded it; its menu turns the wait off.
 */
export function TerminalRateLimitBadge({ terminalId }: { terminalId: string }) {
  const observedAt = useRateLimitObservationStore((s) => s.observedAtByTerminalId[terminalId]);
  const continuation = useCodexLimitContinueStore((s) => s.panes[terminalId]);
  // Held here, above the chip: a confirm already asked outlives the chip, which
  // goes the moment its observation expires or is pruned, and the user's answer
  // still counts.
  const [request, setRequest] = useState<RestartOnPresetRequest | null>(null);
  const closeRequest = useCallback(() => setRequest(null), []);
  const [accountRequest, setAccountRequest] = useState<RestartOnAccountRequest | null>(null);
  const closeAccountRequest = useCallback(() => setAccountRequest(null), []);
  // Main keeps an outcome until the pane's next stop, the chip only for a
  // while: once everything it had to say has expired it stops reading the
  // clock, until a new observation or a new record of main's arrives. A record
  // is new by identity, not revision: a restarted host can repeat a revision.
  // A wait always shows.
  const [retired, setRetired] = useState<{
    observedAt: number | undefined;
    entry: typeof continuation;
  } | null>(null);
  const retire = useCallback(
    () => setRetired({ observedAt, entry: continuation }),
    [observedAt, continuation]
  );
  const isRetired =
    retired !== null &&
    retired.observedAt === observedAt &&
    retired.entry === continuation &&
    continuation?.state.status !== "waiting";
  const mounted =
    (observedAt !== undefined || canShowLimitContinue(continuation?.state)) && !isRetired;
  return (
    <>
      {mounted && (
        <RateLimitChip
          terminalId={terminalId}
          observedAt={observedAt}
          continuation={continuation?.state}
          onRetire={retire}
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

// Chosen at render, never at module load: tests mock the icon module with
// only the glyphs they render.
function continueGlyph(kind: LimitContinueChip["kind"] | undefined) {
  if (kind === "waiting") return AlarmClock;
  if (kind === "continued") return AlarmClockCheck;
  return TriangleAlert;
}

/**
 * Turn the pane's continuation off, straight to main and never an action, so
 * nothing here reaches MCP (#17909). A refusal is said out loud: an armed
 * pane with a fresh banner shows the same chip either way. Its Retry acts only
 * while main's record is still the one that was refused, so an old toast
 * never cancels a wait armed since.
 */
function turnOffContinue(terminalId: string): void {
  const record = useCodexLimitContinueStore.getState().panes[terminalId];
  if (!record) return;
  void codexLimitContinueClient.set(terminalId, false).catch((error: unknown) => {
    const title = usePanelStore.getState().panelsById[terminalId]?.title;
    const why =
      (isClientAppError(error) && error.userMessage) || "The change didn't reach the pane's host.";
    notify({
      type: "error",
      title: "Couldn't cancel resume",
      // "May": a reply lost on the way back can hide a cancel that took.
      message: `${why} ${title ? `'${title}'` : "The pane"} may still continue once its usage limit resets.`,
      action: {
        label: "Retry",
        variant: "primary",
        onClick: () => {
          if (useCodexLimitContinueStore.getState().panes[terminalId] === record) {
            turnOffContinue(terminalId);
          }
        },
      },
      context: { eventKind: "agent" },
    });
  });
}

// Split out so only a pane with something to say subscribes to the clock.
function RateLimitChip({
  terminalId,
  observedAt,
  continuation,
  onRetire,
  onPick,
  onPickAccount,
}: {
  terminalId: string;
  observedAt: number | undefined;
  /** Main's record while the pane is armed to continue at the reset (#17909). */
  continuation: CodexLimitContinueState | undefined;
  onRetire: () => void;
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
  const inputBlock = useTerminalInputBlock();
  const [menuOpen, setMenuOpen] = useState(false);
  const live = isRateLimitObservationLive(observedAt, now);
  const resume = describeLimitContinue(continuation, now);
  const visible = live || resume !== null;
  // The pane is still stopped on its limit while a wait is pending, or the
  // banner is fresh and the line wasn't sent, so a move elsewhere is still
  // worth offering; once the line went in, it isn't.
  const offersRestart = resume?.kind === "waiting" || (live && resume?.kind !== "continued");
  // A pane on an account keeps it across a preset switch, so a preset's own
  // home says nothing about the quota it would run on: no hints then.
  const choices = useRestartPresetChoices(
    agentId,
    presetId,
    menuOpen && offersRestart && !accountId
  );
  const accountChoices = useRestartAccountChoices(
    agentId,
    accountId,
    menuOpen && offersRestart,
    presetId
  );
  useEffect(() => {
    if (!visible) onRetire();
  }, [visible, onRetire]);

  const presetChoices = offersRestart ? choices : [];
  const accountMoves = offersRestart ? accountChoices : [];
  const hasRestart = Boolean(agentId) && (presetChoices.length > 0 || accountMoves.length > 0);
  // Main holds the pane armed: its menu can turn that off from here.
  const armed = continuation !== undefined;
  // A chip that expires or stops being a menu takes the menu with it, so the
  // quota stops being read too, and a chip that becomes one again never opens
  // by itself.
  if (menuOpen && (!visible || !(armed || hasRestart))) setMenuOpen(false);

  if (!visible) return null;

  const Glyph = continueGlyph(resume?.kind);
  const warns = resume === null || (resume.kind !== "waiting" && resume.kind !== "continued");

  const chipClass = cn(
    HEADER_CHIP_CLASS,
    HEADER_CHIP_SURFACE,
    HEADER_CHIP_FOCUS_CLASS,
    warns && "text-status-warning"
  );
  const chipContent = (
    <>
      {/* A 16px line box around the glyph, so the chip keeps the row's height
          when a narrow header takes the label out of flow. */}
      <span className="inline-flex h-4 shrink-0 items-center">
        <Glyph className="w-3 h-3" aria-hidden="true" />
      </span>
      {/* Warning ink stays on the glyph; the label takes the row's secondary
          ink like every other chip, which holds 4.5:1 where the warning hue
          would not, and never outweighs an unfocused pane's title. Yields
          first on a narrow header. */}
      <span className="text-text-secondary tabular-nums @max-[420px]/header:sr-only">
        {resume ? resume.label : "Rate limit reported"}
      </span>
    </>
  );
  const tooltipBody = (
    <TooltipContent side="bottom" className="max-w-xs">
      {resume ? (
        <div className="flex flex-col gap-0.5">
          {resume.lines.map((line, index) => (
            <span key={line} className={index === 0 ? "font-medium" : undefined}>
              {line}
            </span>
          ))}
          {resume.kind === "waiting" && (
            <span className="mt-0.5 text-text-secondary">Turn it off from this chip's menu</span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            Agent printed a rate-limit message {formatTimeAgo(observedAt ?? now, now)}
          </span>
          {/* The chip's own retention, never the provider's reset: nothing here
              reads when the limit lifts, so the user is pointed at the message. */}
          <span>Check that message for when the limit resets</span>
          <span>
            This chip clears in{" "}
            {formatRateLimitCountdownCoarse(
              (observedAt ?? now) + RATE_LIMIT_OBSERVATION_TTL_MS - now
            )}
          </span>
        </div>
      )}
    </TooltipContent>
  );

  if (armed || hasRestart) {
    return (
      <>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <Tooltip autoDismiss={false} disableHoverableContent={false}>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    chipClass,
                    HEADER_CHIP_TRIGGER_CLASS,
                    !warns && "hover:text-text-primary"
                  )}
                  aria-haspopup="menu"
                  data-testid="terminal-rate-limit-badge"
                  data-limit-continue={resume?.kind}
                  data-fit-priority="80"
                >
                  {chipContent}
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {tooltipBody}
          </Tooltip>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            {armed && (
              // Arming is the pane menu's; the chip only turns it off.
              <DropdownMenuCheckboxItem
                checked
                disabled={inputBlock !== null}
                onSelect={() => turnOffContinue(terminalId)}
              >
                Continue when usage limit resets
              </DropdownMenuCheckboxItem>
            )}
            {armed && hasRestart && <DropdownMenuSeparator />}
            {/* An account switch keeps the pane's preset (#16040), so it goes
                first: it's the move that changes only who pays. */}
            {agentId && accountMoves.length > 0 && (
              <>
                <DropdownMenuLabel>Switch account</DropdownMenuLabel>
                <RestartOnAccountDropdownItems
                  choices={accountMoves}
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
            {agentId && accountMoves.length > 0 && presetChoices.length > 0 && (
              <DropdownMenuSeparator />
            )}
            {agentId && presetChoices.length > 0 && (
              <>
                <DropdownMenuLabel>Restart on preset</DropdownMenuLabel>
                <RestartOnPresetDropdownItems
                  agentId={agentId}
                  choices={presetChoices}
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
          data-fit-priority="80"
        >
          {chipContent}
        </div>
      </TooltipTrigger>
      {tooltipBody}
    </Tooltip>
  );
}
