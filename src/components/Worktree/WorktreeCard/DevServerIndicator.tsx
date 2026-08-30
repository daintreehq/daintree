import { useMemo } from "react";
import { Globe, Loader2, CircleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

interface DevServerIndicatorProps {
  session: DevPreviewSessionState | undefined;
}

function extractPort(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).port || null;
  } catch {
    return null;
  }
}

/**
 * Secondary per-row dev-server signal in the worktree header's trailing icon
 * group. Renders nothing for `stopped`/`restored-stopped`/`stopping` (no live
 * server) — only `starting`/`installing`/`running`/`error` surface, mirroring
 * `isLiveDevServerStatus`. Deliberately ambient: a bare icon + tooltip, no row
 * tint, no banner, no accent color — the agent indicator stays the row's anchor.
 */
export function DevServerIndicator({ session }: DevServerIndicatorProps) {
  const status = session?.status;
  const isStartup = status === "starting" || status === "installing";
  // Doherty gate: a sub-400ms start should never flash a spinner.
  const showStartupSpinner = useDohertyGate(isStartup);
  const port = useMemo(() => extractPort(session?.url), [session?.url]);

  if (!session || !status) return null;

  if (status === "running") {
    const { url } = session;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="dev-server-indicator"
            data-dev-server-status="running"
            aria-label={url ? `Dev server running at ${url}` : "Dev server running"}
            className="inline-flex items-center gap-1 text-xs text-text-muted shrink-0"
          >
            <Globe className="w-3 h-3 shrink-0 text-activity-working" aria-hidden="true" />
            {port && <span className="tabular-nums">:{port}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{url ?? "Dev server running"}</TooltipContent>
      </Tooltip>
    );
  }

  if (status === "error") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="dev-server-indicator"
            data-dev-server-status="error"
            aria-label="Dev server error"
            className="inline-flex items-center text-status-error shrink-0"
          >
            <CircleAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{session.error?.message ?? "Dev server error"}</TooltipContent>
      </Tooltip>
    );
  }

  if (isStartup) {
    if (!showStartupSpinner) return null;
    const label = status === "installing" ? "Installing dependencies" : "Starting dev server";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="dev-server-indicator"
            data-dev-server-status={status}
            aria-label={label}
            className="inline-flex items-center text-text-muted shrink-0"
          >
            <Loader2 className="w-3 h-3 shrink-0 animate-spin" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return null;
}
