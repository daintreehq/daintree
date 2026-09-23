import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Check,
  Cloud,
  Container,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  Globe,
  Layers,
  RefreshCw,
  Rocket,
  Server,
  Box,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { WorktreeLifecycleStatus } from "@shared/types/worktree";
import { Hourglass, TriangleAlert } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/Spinner";
import { SpinningIcon } from "../../ui/SpinningIcon";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { systemClient } from "@/clients/systemClient";
import { formatTimeAgo } from "@/utils/timeAgo";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";
import { actionService } from "@/services/ActionService";
import {
  LIFECYCLE_PHASE_LABELS,
  resourceStatusColorFor,
  type ResourceStatusColor,
} from "./hooks/useWorktreeStatus";

const ENVIRONMENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Server,
  Cloud,
  Container,
  Cpu,
  Globe,
  Rocket,
  Database,
  Terminal: TerminalIcon,
  Box,
  Layers,
};

/**
 * Only failures and in-flight states earn colour, and they carry it on a glyph
 * beside the word: status hues fall short of 4.5:1 as text on some themes, but
 * clear 3:1 as a shape. Healthy stays neutral (#12002).
 */
const STATUS_GLYPHS: Partial<
  Record<
    ResourceStatusColor,
    { icon: React.ComponentType<{ className?: string }>; className: string }
  >
> = {
  yellow: { icon: Hourglass, className: "text-status-warning" },
  red: { icon: TriangleAlert, className: "text-status-error" },
};

const RELATIVE_TIME_REFRESH_MS = 30_000;

/**
 * A status command that prints only the status and endpoint as JSON has nothing
 * to say that the header and endpoint row don't already show.
 */
function isRedundantOutput(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.keys(parsed).every((key) => key === "status" || key === "endpoint");
  } catch {
    return false;
  }
}

function isOpenableUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

interface EnvironmentPopoverProps {
  worktreeMode: string | undefined;
  environmentIcon: string | undefined;
  isLifecycleRunning: boolean | undefined;
  lifecycle?: WorktreeLifecycleStatus;
  /** The status the trigger reflects — the last check, or the in-flight lifecycle phase. */
  resourceStatusLabel: string | undefined;
  resourceStatusColor: ResourceStatusColor | undefined;
  /** What the status command itself last reported, independent of any running phase. */
  reportedStatus?: string;
  resourceLastOutput: string | undefined;
  resourceEndpoint: string | undefined;
  resourceLastCheckedAt: number | undefined;
  onCheckResourceStatus: (() => void | Promise<unknown>) | undefined;
}

export function EnvironmentPopover({
  worktreeMode,
  environmentIcon,
  isLifecycleRunning,
  lifecycle,
  resourceStatusLabel,
  resourceStatusColor,
  reportedStatus,
  resourceLastOutput,
  resourceEndpoint,
  resourceLastCheckedAt,
  onCheckResourceStatus,
}: EnvironmentPopoverProps) {
  const [open, setOpen] = useState(false);
  const [checkRequested, setCheckRequested] = useState(false);
  const [checkLanded, setCheckLanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pendingAnnounceRef = useRef<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopyWithFeedback({ announcement: "Endpoint copied" });

  const EnvironmentIcon = (environmentIcon && ENVIRONMENT_ICONS[environmentIcon]) || Server;
  const environmentName = worktreeMode && worktreeMode !== "local" ? worktreeMode : "Local";

  const activity =
    isLifecycleRunning && lifecycle
      ? (LIFECYCLE_PHASE_LABELS[lifecycle.phase] ?? lifecycle.phase)
      : undefined;
  // The host keeps the `resource-status` phase after the check settles, so only
  // its running state means a check is in flight.
  const isCheckRunning =
    checkRequested || (lifecycle?.phase === "resource-status" && lifecycle.state === "running");
  // A fast phase never flashes a spinner; the trigger's pulse already covers it.
  const showActivity = useDohertyGate(!!activity);

  const output = resourceLastOutput?.trim();
  const showOutput = !!output && !isRedundantOutput(output);
  const reportedGlyph = reportedStatus
    ? STATUS_GLYPHS[resourceStatusColorFor(reportedStatus)]
    : undefined;
  const hasBody =
    (!!activity && showActivity) ||
    (!onCheckResourceStatus && !reportedStatus && !activity) ||
    showOutput ||
    !!resourceEndpoint;

  const triggerStatus = activity ?? resourceStatusLabel;
  const triggerLabel = triggerStatus
    ? `${environmentName} environment: ${triggerStatus}`
    : `${environmentName} environment`;

  const iconClass = cn(
    "w-3.5 h-3.5 shrink-0",
    isLifecycleRunning
      ? "animate-activity-pulse text-activity-working"
      : resourceStatusColor === "yellow"
        ? "text-status-warning"
        : resourceStatusColor === "red"
          ? "text-status-error"
          : "text-text-secondary"
  );

  // The relative time is read against a clock held in state, not `Date.now()` in
  // render, so it advances while the popover stays open.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), RELATIVE_TIME_REFRESH_MS);
    return () => clearInterval(id);
  }, [open, resourceLastCheckedAt]);

  // A check the user asked for is announced once its result lands, including an
  // unchanged one — otherwise a repeat of the same answer reads as an ignored click.
  useEffect(() => {
    const baseline = pendingAnnounceRef.current;
    if (baseline === undefined || !resourceLastCheckedAt || resourceLastCheckedAt === baseline) {
      return;
    }
    pendingAnnounceRef.current = undefined;
    // A visible cue that does not depend on the spin, which reduced motion removes,
    // or on the timestamp, which reads "just now" before and after a quick repeat.
    setCheckLanded(true);
    useAnnouncerStore
      .getState()
      .announce(`${environmentName} checked: ${reportedStatus ?? "no status"}`, "polite");
  }, [resourceLastCheckedAt, environmentName, reportedStatus]);

  useEffect(() => {
    if (!checkLanded) return;
    const id = setTimeout(() => setCheckLanded(false), UI_ACTION_SUCCESS_DWELL_MS);
    return () => clearTimeout(id);
  }, [checkLanded]);

  const handleCheck = async () => {
    if (!onCheckResourceStatus || isCheckRunning) return;
    pendingAnnounceRef.current = resourceLastCheckedAt ?? 0;
    setCheckLanded(false);
    setCheckRequested(true);
    try {
      await onCheckResourceStatus();
    } finally {
      setCheckRequested(false);
    }
  };

  const checkedAt = resourceLastCheckedAt ? new Date(resourceLastCheckedAt) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-no-dnd
              className="-m-[5px] inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
              aria-label={triggerLabel}
            >
              <EnvironmentIcon className={iconClass} aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {triggerStatus ? `${environmentName} · ${triggerStatus}` : environmentName}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] p-0 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-text-secondary"
        aria-label={`${environmentName} environment`}
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          // Land on the popover itself rather than its first control: focusing
          // the copy button would pop its tooltip over the endpoint on every
          // open and spend the first Escape closing that instead. Tab still
          // reaches every control in order.
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
      >
        <div
          className={cn("flex items-baseline justify-between gap-3 px-3 pt-3", !hasBody && "pb-3")}
        >
          <span className="min-w-0 truncate font-semibold text-text-primary">
            {environmentName}
          </span>
          {reportedStatus && (
            <span className="flex shrink-0 items-center gap-1 self-center font-medium text-text-secondary">
              {reportedGlyph && (
                <reportedGlyph.icon
                  className={cn("size-3.5 shrink-0", reportedGlyph.className)}
                  aria-hidden="true"
                />
              )}
              {reportedStatus}
            </span>
          )}
        </div>

        {hasBody && (
          <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
            {activity && showActivity && (
              <div className="flex items-center gap-1.5 text-text-secondary">
                <Spinner size="xs" />
                <span>{activity}…</span>
              </div>
            )}

            {!onCheckResourceStatus && !reportedStatus && !activity && (
              <div className="flex flex-col items-start gap-2">
                <p className="text-text-secondary">
                  Add a status command in Worktree setup to check this environment&apos;s health.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 focus-visible:-outline-offset-2"
                  onClick={() =>
                    void actionService.dispatch(
                      "app.settings.openTab",
                      { tab: "project:automation" },
                      { source: "user" }
                    )
                  }
                >
                  Open worktree setup
                </Button>
              </div>
            )}

            {showOutput && (
              <div className="flex flex-col gap-1">
                <span className="text-2xs text-text-secondary">Last check output</span>
                {/* The vertical padding sits outside the scroller: overflowing
                    text paints into a scroller's own padding, which would show
                    a sliver of the eleventh line under the tenth. */}
                <div className="rounded-[var(--radius-md)] border border-border-default bg-surface-canvas py-1.5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-primary">
                  <pre
                    tabIndex={0}
                    role="region"
                    aria-label="Last check output"
                    // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the well wrapper paints this region's focus ring via has-[:focus-visible]; a ring on the scroller would sit inside the wrapper's border and double it
                    className="max-h-[10lh] overflow-y-auto whitespace-pre-wrap break-words [text-indent:2ch_hanging_each-line] px-2 font-mono text-2xs leading-relaxed text-text-primary outline-hidden"
                  >
                    {output}
                  </pre>
                </div>
              </div>
            )}

            {resourceEndpoint && (
              <div className="flex flex-col gap-1">
                <span className="text-2xs text-text-secondary">Endpoint</span>
                {/* The icon buttons' own padding would pull the row's right edge in
                  from the status and Check status above and below it. */}
                <div className="-mr-1.5 flex min-w-0 items-center gap-1">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-2xs text-text-primary"
                    title={resourceEndpoint}
                  >
                    {resourceEndpoint}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Copy endpoint"
                        onClick={() => void copy(resourceEndpoint)}
                      >
                        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Copy endpoint</TooltipContent>
                  </Tooltip>
                  {isOpenableUrl(resourceEndpoint) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Open endpoint in browser"
                          onClick={() => void systemClient.openExternal(resourceEndpoint)}
                        >
                          <ExternalLink aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">Open in browser</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {(checkedAt || onCheckResourceStatus) && (
          <div className="flex items-center justify-between gap-2 border-t border-divider px-3 py-1.5">
            {checkedAt ? (
              <time
                dateTime={checkedAt.toISOString()}
                title={checkedAt.toLocaleString()}
                className="text-text-secondary tabular-nums"
              >
                Checked {formatTimeAgo(checkedAt.getTime(), Math.max(now, checkedAt.getTime()))}
              </time>
            ) : (
              <span className="text-text-secondary">Not checked yet</span>
            )}
            {onCheckResourceStatus && (
              <Button
                variant="ghost"
                size="sm"
                className="-mr-3 focus-visible:-outline-offset-2"
                aria-disabled={isCheckRunning || undefined}
                onClick={() => void handleCheck()}
              >
                {checkLanded && !isCheckRunning ? (
                  <Check aria-hidden="true" />
                ) : (
                  <SpinningIcon icon={RefreshCw} active={isCheckRunning} aria-hidden="true" />
                )}
                Check status
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
