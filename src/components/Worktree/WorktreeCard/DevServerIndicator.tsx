import { useMemo } from "react";
import { Globe, XCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { cn } from "@/lib/utils";
import { devServerSummaryText, portFromUrl, summarizeDevServer } from "@/lib/devServerPresentation";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

interface DevServerIndicatorProps {
  session: DevPreviewSessionState | undefined;
}

/**
 * Secondary per-row dev-server signal in the worktree header's trailing icon
 * group. Renders nothing for `stopped`/`restored-stopped`/`stopping` (no live
 * server) — only `starting`/`installing`/`running`/`error` surface, mirroring
 * `isLiveDevServerStatus`.
 *
 * One mark in three states, read the way the environment and attachment marks
 * beside it are: a neutral globe and its port once running, the same globe
 * pulsing beside "Starting" or "Installing" while it comes up, and `XCircle`
 * with a short failure word once it has failed.
 * Running stays neutral because the mark's presence already says a server is
 * up, and green at rest would sit beside the agent's working spinner and
 * outshout it — the agent indicator stays the row's anchor.
 */
export function DevServerIndicator({ session }: DevServerIndicatorProps) {
  const status = session?.status;
  const isStartup = status === "starting" || status === "installing";
  // Doherty gate: a sub-400ms start should never flash a pulse.
  const showStartup = useDohertyGate(isStartup);
  const port = useMemo(() => portFromUrl(session?.url), [session?.url]);

  if (!session || !status) return null;
  if (isStartup && !showStartup) return null;
  const summary = summarizeDevServer(session);
  if (!summary) return null;

  const isError = status === "error";
  // Every state names itself in words or a port, so none is told apart by its
  // colour or its pulse alone (the pulse stops under reduced motion).
  const label = isError
    ? session.error?.type === "port-conflict"
      ? "Port in use"
      : "Failed"
    : status === "starting"
      ? "Starting"
      : status === "installing"
        ? "Installing"
        : port
          ? `:${port}`
          : null;
  const Glyph = isError ? XCircle : Globe;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          data-testid="dev-server-indicator"
          data-dev-server-status={status}
          aria-label={devServerSummaryText(summary)}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-text-secondary"
        >
          {/* The tone sits on a wrapper, not the svg: forced colours repaint an
              inherited currentColor but keep a colour set on the svg itself,
              which left the globe at ~2.6:1 on the white canvas. */}
          <span
            className={cn(
              "inline-flex shrink-0",
              isError ? "text-status-error" : isStartup && "text-activity-working"
            )}
          >
            <Glyph
              className={cn("size-3.5", isStartup && "animate-activity-pulse")}
              aria-hidden="true"
            />
          </span>
          {label && <span className="tabular-nums">{label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <span className="block">{summary.title}</span>
        {summary.detail && (
          <span className="mt-0.5 block break-words text-text-secondary">{summary.detail}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
