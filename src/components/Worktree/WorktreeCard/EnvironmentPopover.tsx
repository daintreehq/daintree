import { cn } from "@/lib/utils";
import {
  Cloud,
  Container,
  Cpu,
  Database,
  Globe,
  Layers,
  RefreshCw,
  Rocket,
  Server,
  Box,
  Terminal as TerminalIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";

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

interface EnvironmentPopoverProps {
  worktreeMode: string | undefined;
  environmentIcon: string | undefined;
  isLifecycleRunning: boolean | undefined;
  resourceStatusLabel: string | undefined;
  resourceStatusColor: "green" | "yellow" | "red" | "neutral" | undefined;
  resourceLastOutput: string | undefined;
  resourceEndpoint: string | undefined;
  resourceLastCheckedAt: number | undefined;
  onCheckResourceStatus: (() => void) | undefined;
}

export function EnvironmentPopover({
  worktreeMode,
  environmentIcon,
  isLifecycleRunning,
  resourceStatusLabel,
  resourceStatusColor,
  resourceLastOutput,
  resourceEndpoint,
  resourceLastCheckedAt,
  onCheckResourceStatus,
}: EnvironmentPopoverProps) {
  const EnvironmentIcon = (environmentIcon && ENVIRONMENT_ICONS[environmentIcon]) || Cloud;

  const iconClass = cn(
    "w-3 h-3 shrink-0",
    isLifecycleRunning
      ? "animate-pulse text-activity-working"
      : resourceStatusColor === "green"
        ? "text-terminal-bright-green"
        : resourceStatusColor === "yellow"
          ? "text-status-warning"
          : resourceStatusColor === "red"
            ? "text-status-error"
            : resourceStatusColor === "neutral" || resourceStatusLabel
              ? "text-status-info/70"
              : "text-daintree-text/30"
  );

  const hasDetails =
    resourceStatusLabel || resourceLastOutput || resourceEndpoint || resourceLastCheckedAt;

  if (!hasDetails && !onCheckResourceStatus) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <EnvironmentIcon
            className={cn(iconClass, "pointer-events-none")}
            aria-label={`${worktreeMode} environment`}
          />
        </TooltipTrigger>
        <TooltipContent side="top">{worktreeMode}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="shrink-0 rounded focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent"
          aria-label={`${worktreeMode} environment status`}
        >
          <EnvironmentIcon className={iconClass} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-3 text-xs">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="font-semibold text-text-primary">{worktreeMode}</span>
          {resourceStatusLabel && (
            <span
              className={cn(
                "font-medium",
                resourceStatusColor === "green" && "text-status-success",
                resourceStatusColor === "yellow" && "text-status-warning",
                resourceStatusColor === "red" && "text-status-error",
                (!resourceStatusColor || resourceStatusColor === "neutral") && "text-text-muted"
              )}
            >
              {resourceStatusLabel}
            </span>
          )}
        </div>
        {resourceEndpoint && (
          <div className="mb-2 font-mono text-[11px] text-text-secondary break-all">
            {resourceEndpoint}
          </div>
        )}
        {resourceLastOutput && (
          <pre className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-surface-panel-elevated p-2 font-mono text-[11px] text-text-secondary">
            {resourceLastOutput.trim()}
          </pre>
        )}
        <div className="flex items-center justify-between gap-2">
          {resourceLastCheckedAt ? (
            <span className="text-text-muted">
              checked{" "}
              {new Date(resourceLastCheckedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          ) : (
            <span />
          )}
          {onCheckResourceStatus && (
            <button
              onClick={onCheckResourceStatus}
              className="flex items-center gap-1 text-text-muted hover:text-text-primary transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Check Status
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
