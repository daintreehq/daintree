import { useState, useCallback } from "react";
import {
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Terminal,
  GitBranch,
  LayoutGrid,
  FolderOpen,
  Radio,
  Bot,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCall } from "./types";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getToolIcon(toolName: string | undefined) {
  if (!toolName) return Zap;
  const name = toolName.toLowerCase();

  // Terminal actions: terminal.list, terminal.getOutput, terminal.new, terminal.sendCommand, etc.
  if (name.startsWith("terminal")) {
    return Terminal;
  }

  // Worktree actions: worktree.list, worktree.getCurrent, worktree.setActive, etc.
  if (name.startsWith("worktree")) {
    return GitBranch;
  }

  // Panel actions: panel.list
  if (name.startsWith("panel")) {
    return LayoutGrid;
  }

  // Project actions: project.getCurrent
  if (name.startsWith("project")) {
    return FolderOpen;
  }

  // Agent actions: agent.launch
  if (name.startsWith("agent")) {
    return Bot;
  }

  // Sidecar actions: sidecar.toggle
  if (name.startsWith("sidecar")) {
    return PanelLeft;
  }

  // Navigation actions: nav.toggleSidebar
  if (name.startsWith("nav")) {
    return PanelLeftClose;
  }

  // Settings actions: app.settings, app.settings.openTab
  if (name.startsWith("app.settings") || name.includes("settings")) {
    return Settings;
  }

  // Event listener actions: register_listener, remove_listener, list_listeners
  if (name.includes("listener")) {
    return Radio;
  }

  // Default fallback
  return Zap;
}

function getResultSummary(toolCall: ToolCall): string | null {
  if (toolCall.status === "pending") return null;

  if (toolCall.status === "error" && toolCall.error) {
    const errorStr = String(toolCall.error);
    return errorStr.length > 30 ? errorStr.slice(0, 30) + "…" : errorStr;
  }

  if (toolCall.result !== undefined) {
    if (typeof toolCall.result === "string") {
      const str = toolCall.result.trim();
      if (str.length <= 30) return str;
      return str.slice(0, 30) + "…";
    }
    if (typeof toolCall.result === "object" && toolCall.result !== null) {
      const keys = Object.keys(toolCall.result);
      if (keys.length === 1) return String((toolCall.result as Record<string, unknown>)[keys[0]]);
      return `${keys.length} fields`;
    }
  }

  return null;
}

interface ToolCallBlockProps {
  toolCall: ToolCall;
  className?: string;
}

export function ToolCallBlock({ toolCall, className }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const Icon = getToolIcon(toolCall.name);
  const resultSummary = getResultSummary(toolCall);
  const isPending = toolCall.status === "pending";
  const isError = toolCall.status === "error";
  const isSuccess = toolCall.status === "success";

  return (
    <div className={cn("overflow-hidden", className)}>
      <button
        type="button"
        onClick={toggleExpanded}
        className={cn(
          "relative flex items-center justify-between gap-3 px-3 py-2 rounded-lg border w-full max-w-lg transition-all cursor-pointer group/tool",
          isPending
            ? "border-canopy-accent/20 bg-canopy-accent/[0.05] animate-pulse"
            : "border-white/[0.08] bg-white/[0.01] hover:bg-white/[0.03] hover:border-white/[0.12]",
          "focus:outline-none focus:ring-1 focus:ring-canopy-accent/30"
        )}
        aria-expanded={expanded}
        aria-controls={`tool-call-details-${toolCall.id}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              "w-5 h-5 rounded-md flex items-center justify-center shrink-0",
              isPending && "bg-canopy-accent/20 text-canopy-accent",
              isSuccess && "bg-canopy-accent/10 text-canopy-accent",
              isError && "bg-red-500/10 text-red-400",
              !isPending && !isSuccess && !isError && "bg-white/[0.05] text-canopy-text/50"
            )}
          >
            <Icon size={12} />
          </div>
          <div className="flex items-center gap-2 overflow-hidden">
            <span
              className={cn(
                "text-[12px] font-mono transition-colors truncate",
                isPending
                  ? "text-canopy-text/90"
                  : "text-canopy-text/50 group-hover/tool:text-canopy-text/70"
              )}
            >
              {toolCall.name}
            </span>
            {resultSummary && !isPending && (
              <span className="text-[12px] text-canopy-text/30 truncate">{resultSummary}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isPending && (
            <>
              <span className="text-[10px] uppercase tracking-wider font-semibold text-canopy-accent">
                Working
              </span>
              <Loader2 size={12} className="text-canopy-accent animate-spin" />
            </>
          )}
          {isSuccess && (
            <>
              <span className="text-[10px] uppercase tracking-wider font-semibold text-canopy-accent/80">
                Success
              </span>
              <CheckCircle2 size={12} className="text-canopy-accent/80" />
            </>
          )}
          {isError && (
            <>
              <span className="text-[10px] uppercase tracking-wider font-semibold text-red-400">
                Error
              </span>
              <XCircle size={12} className="text-red-400" />
            </>
          )}
          {!isPending &&
            (expanded ? (
              <ChevronDown className="w-3 h-3 text-canopy-text/40 shrink-0 ml-1" />
            ) : (
              <ChevronRight className="w-3 h-3 text-canopy-text/40 shrink-0 ml-1" />
            ))}
        </div>
      </button>

      {expanded && (
        <div
          id={`tool-call-details-${toolCall.id}`}
          className="px-3 py-3 mt-2 text-[13px] font-mono text-canopy-text/60 bg-white/[0.02] rounded-lg border border-white/[0.08] max-w-lg"
        >
          <div className="mb-1.5 text-canopy-text/40 text-[10px] uppercase tracking-wider font-semibold">
            Arguments
          </div>
          <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-canopy-bg/50 rounded p-2 text-[11px] leading-relaxed text-canopy-text/60">
            {safeStringify(toolCall.args)}
          </pre>

          {toolCall.status === "error" && toolCall.error && (
            <>
              <div className="mt-3 mb-1.5 text-canopy-text/40 text-[10px] uppercase tracking-wider font-semibold">
                Error
              </div>
              <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-red-500/10 border border-red-500/20 rounded p-2 text-[11px] leading-relaxed text-red-400">
                {toolCall.error}
              </pre>
            </>
          )}

          {toolCall.result !== undefined && (
            <>
              <div className="mt-3 mb-1.5 text-canopy-text/40 text-[10px] uppercase tracking-wider font-semibold">
                Result
              </div>
              <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-canopy-bg/50 rounded p-2 text-[11px] leading-relaxed text-canopy-text/60">
                {typeof toolCall.result === "string"
                  ? toolCall.result
                  : safeStringify(toolCall.result)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
