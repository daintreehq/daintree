import { useEffect, useRef, useState } from "react";
import { Clock, RefreshCw, WifiOff } from "lucide-react";
import type {
  PluginRefreshOverlayProps,
  PluginStaleIndicatorProps,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useNow } from "../../../packages/plugin-sdk/src/react/useNow";
import { pluginKitDates } from "./PluginKitDates";
import { useKitOverlayZClass } from "./kitScope";
import { fn, node, nonEmpty, oneOf, pickRootProps, positive, str } from "./kitProps";
import { toTimestamp } from "./kitTime";

/** `value`, but only once it has held for `delayMs`; it drops at once. */
function useHeldFor(value: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!value) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value && held;
}

// The content stays where it is and stays usable: the only marks are a thin
// bar along the top edge and a small note in the corner, both past the
// Doherty gate so a quick refresh never flickers.
export function KitRefreshOverlay({
  refreshing,
  children,
  label,
  className,
  ...rest
}: PluginRefreshOverlayProps) {
  const active = refreshing === true;
  const shown = useHeldFor(active, UI_DOHERTY_THRESHOLD);
  const words = nonEmpty(label) ?? "Updating…";
  return (
    <div
      {...pickRootProps(rest)}
      data-refreshing={active ? "true" : undefined}
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", str(className))}
    >
      {/* Busy is the content alone: a live region inside a busy subtree may
          be held back until it clears, which is after the news is over. */}
      <div aria-busy={active || undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {node(children)}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 transition-opacity duration-150 ease-out motion-reduce:transition-none",
          shown ? "opacity-100" : "opacity-0"
        )}
      >
        {shown ? <ProgressBar label={words} size="thin" className="rounded-none" /> : null}
        <div className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full border border-border-default bg-surface-panel-elevated px-2 py-0.5 text-2xs text-text-secondary shadow-[var(--theme-shadow-floating)]">
          <Spinner size="xs" />
          {words}
        </div>
      </div>
      <span role="status" className="sr-only">
        {shown ? words : ""}
      </span>
    </div>
  );
}

const STALE_TICK_MIN_MS = 1000;
const STALE_TICK_MAX_MS = 60_000;

export function KitStaleIndicator({
  updatedAt,
  staleAfterMs,
  stale,
  disconnected,
  refreshing,
  onRefresh,
  refreshLabel,
  detail,
  staleTint,
  announce,
  className,
  ...rest
}: PluginStaleIndicatorProps) {
  const overlayZ = useKitOverlayZClass();
  const timestamp = toTimestamp(updatedAt);
  const valid = !Number.isNaN(timestamp);
  const threshold = positive(staleAfterMs, Number.MAX_SAFE_INTEGER);
  const tick = threshold
    ? Math.min(STALE_TICK_MAX_MS, Math.max(STALE_TICK_MIN_MS, Math.round(threshold / 4)))
    : STALE_TICK_MAX_MS;
  const now = useNow({ intervalMs: tick });
  const aged = threshold !== undefined && valid && now - timestamp > threshold;
  const state = disconnected === true ? "disconnected" : stale === true || aged ? "stale" : "fresh";
  const busy = refreshing === true;
  const refresh = fn(onRefresh);
  const refreshName = nonEmpty(refreshLabel) ?? "Refresh";
  const TimeAgo = pluginKitDates.TimeAgo;
  // Connectivity changes are news; the age ticking over is not.
  const offline = state === "disconnected";
  const wasOffline = useRef<boolean | null>(null);
  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    const previous = wasOffline.current;
    wasOffline.current = offline;
    if (previous === null || previous === offline) return;
    setSpoken(offline ? "Disconnected" : "Reconnected");
  }, [offline]);
  // The host's announcer rather than the region above, so a result that lands
  // in the same commit as a reconnect is not overwritten by it.
  const result = nonEmpty(announce);
  const lastResult = useRef(result);
  useEffect(() => {
    if (result === lastResult.current) return;
    lastResult.current = result;
    if (result) useAnnouncerStore.getState().announce(result, "polite");
  }, [result]);
  const more = nonEmpty(detail);
  const tintWords = state === "stale" && oneOf(staleTint, ["glyph", "text"] as const) === "text";
  const reading = (
    <span
      // Focusable only to reach its tooltip from the keyboard.
      tabIndex={more ? 0 : undefined}
      className={cn(
        "min-w-0 truncate",
        tintWords && "text-status-warning",
        // The reading's tooltip stands in for the age's own, and its native
        // title would otherwise surface beside it.
        more && "[&_time]:pointer-events-none"
      )}
    >
      {valid ? (
        <TimeAgo value={timestamp} prefix="Updated " tooltip={more ? false : undefined} />
      ) : (
        "Not updated yet"
      )}
    </span>
  );
  const refreshButton = refresh ? (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={refreshName}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) refresh();
      }}
      className="-my-1 shrink-0 [&_svg]:size-3"
    >
      <SpinningIcon icon={RefreshCw} active={busy} aria-hidden="true" />
    </Button>
  ) : null;
  return (
    <span
      {...pickRootProps(rest)}
      data-stale-state={state}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-text-secondary", str(className))}
    >
      {state === "disconnected" ? (
        <>
          <WifiOff aria-hidden="true" className="h-3 w-3 shrink-0 text-status-warning" />
          <span className="shrink-0 text-text-primary">Disconnected</span>
          <span aria-hidden="true" className="text-text-muted">
            ·
          </span>
        </>
      ) : state === "stale" ? (
        <>
          <Clock aria-hidden="true" className="h-3 w-3 shrink-0 text-status-warning" />
          <span className="sr-only">Out of date:</span>
        </>
      ) : null}
      {more ? (
        <Tooltip>
          <TooltipTrigger asChild>{reading}</TooltipTrigger>
          <TooltipContent side="top" className={overlayZ}>
            {more}
          </TooltipContent>
        </Tooltip>
      ) : (
        reading
      )}
      {refreshButton ? (
        <Tooltip>
          <TooltipTrigger asChild>{refreshButton}</TooltipTrigger>
          <TooltipContent side="top" className={overlayZ}>
            {refreshName}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <span role="status" className="sr-only">
        {spoken}
      </span>
    </span>
  );
}
