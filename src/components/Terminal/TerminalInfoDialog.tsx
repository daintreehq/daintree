import { useState, useEffect } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TerminalInfoPayload } from "@/types/electron";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface TerminalInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  terminalId: string;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatTimestamp(timestamp: number): string {
  if (timestamp === 0) return "Never";
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function formatRelativeTime(timestamp: number): string {
  if (timestamp === 0) return "Never";
  const now = Date.now();
  const diff = now - timestamp;
  return `${formatDuration(diff)} ago`;
}

interface InfoSectionProps {
  title: string;
  children: React.ReactNode;
}

function InfoSection({ title, children }: InfoSectionProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-daintree-text/90 border-b border-daintree-border pb-2">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

interface InfoRowProps {
  label: string;
  value: string | number | undefined;
  mono?: boolean;
}

function InfoRow({ label, value, mono = false }: InfoRowProps) {
  const displayValue = value ?? "N/A";
  const valueElement = (
    <span
      className={`text-daintree-text text-right select-text ${mono ? "font-mono text-xs" : ""}`}
    >
      {displayValue}
    </span>
  );

  return (
    <div className="flex justify-between items-start gap-4 text-sm">
      <span className="text-daintree-text/70 shrink-0 select-none">{label}:</span>
      {typeof displayValue === "string" ? (
        <Tooltip>
          <TooltipTrigger asChild>{valueElement}</TooltipTrigger>
          <TooltipContent side="bottom">{displayValue}</TooltipContent>
        </Tooltip>
      ) : (
        valueElement
      )}
    </div>
  );
}

interface InfoListRowProps {
  label: string;
  items: string[] | undefined;
}

function InfoListRow({ label, items }: InfoListRowProps) {
  if (!items || items.length === 0) return null;

  return (
    <div className="flex justify-between items-start gap-4 text-sm">
      <span className="text-daintree-text/70 shrink-0 select-none">{label}:</span>
      <div className="flex flex-wrap gap-1 justify-end">
        {items.map((item, i) => (
          <code
            key={`${i}-${item}`}
            className="bg-daintree-bg/50 border border-daintree-border font-mono text-xs px-1.5 py-0.5 rounded select-text break-all"
          >
            {item}
          </code>
        ))}
      </div>
    </div>
  );
}

export function TerminalInfoDialog({ isOpen, onClose, terminalId }: TerminalInfoDialogProps) {
  const [info, setInfo] = useState<TerminalInfoPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setInfo(null);
      setError(null);
      setLoading(false);
      return;
    }

    let isMounted = true;

    const fetchInfo = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await actionService.dispatch(
          "terminal.info.get",
          { terminalId },
          { source: "user" }
        );
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        if (isMounted) {
          setInfo(result.result as TerminalInfoPayload);
        }
      } catch (err) {
        const message = formatErrorMessage(err, "Failed to load terminal info");
        if (isMounted) {
          setError(message);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchInfo();

    return () => {
      isMounted = false;
    };
  }, [isOpen, terminalId]);

  // "Launch Context" reflects how the panel was configured at spawn time.
  const showAgentLaunchSection = (info: TerminalInfoPayload): boolean =>
    !!(
      info.agentId ||
      (info.agentLaunchFlags && info.agentLaunchFlags.length > 0) ||
      info.agentModelId
    );
  // "Live State" reflects what's running right now. Shown for agent panels,
  // while a runtime agent is detected, or once an agent has ever been detected
  // in this session (so plain terminals that ran `claude` still show the exit).
  const showAgentLiveSection = (info: TerminalInfoPayload): boolean =>
    !!(info.isAgentTerminal || info.detectedAgentId || info.everDetectedAgent);

  const formatArgsForClipboard = (args: string[] | undefined): string => {
    if (args === undefined) return "N/A";
    if (args.length === 0) return "(none)";
    return args.join(" ");
  };

  const copyToClipboard = async () => {
    if (!info) return;

    const launchSection = showAgentLaunchSection(info)
      ? `

Agent — Launch Context:
  Agent ID: ${info.agentId ?? "N/A"}
  Launch Flags: ${formatArgsForClipboard(info.agentLaunchFlags)}
  Model: ${info.agentModelId ?? "N/A"}`
      : "";

    const liveSection = showAgentLiveSection(info)
      ? `

Agent — Live State:
  Detected Agent ID: ${info.detectedAgentId ?? "None — agent has exited"}
  Detected Agent Type: ${info.detectedAgentType ?? "N/A"}`
      : "";

    const agentSection = launchSection + liveSection;

    const diagnosticInfo = `Terminal Diagnostic Information
=====================================

Session Metadata:
  ID: ${info.id}
  Kind: ${info.kind || "terminal"}
  Type: ${info.type || "N/A"}
  Title: ${info.title || "N/A"}
  Project ID: ${info.projectId || "N/A"}
  Worktree ID: ${info.worktreeId || "N/A"}
  CWD: ${info.cwd}

Spawn Command:
  Shell: ${info.shell || "N/A"}
  Args: ${formatArgsForClipboard(info.spawnArgs)}${agentSection}

Terminal Classification:
  Agent Terminal: ${info.isAgentTerminal ? "Yes" : "No"}
  PTY Active: ${info.hasPty ? "Yes" : "No"}
  Analysis Enabled: ${info.analysisEnabled ? "Yes" : "No"}
  Resize Strategy: ${info.resizeStrategy || "default"}

PTY Diagnostics:
  Dimensions: ${info.ptyCols != null && info.ptyRows != null ? `${info.ptyCols} × ${info.ptyRows}` : "N/A"}
  Shell PID: ${info.ptyPid ?? "N/A"}
  TTY Device: ${info.ptyTty ?? "N/A"}
  Foreground Process: ${info.ptyForegroundProcess ?? "N/A"}
  Exit Code: ${info.exitCode != null ? info.exitCode : "N/A"}

Runtime Statistics:
  Running Time: ${formatDuration(Date.now() - info.spawnedAt)}
  Spawned At: ${formatTimestamp(info.spawnedAt)}
  Restart Count: ${info.restartCount}

Activity Metrics:
  Last Input: ${formatRelativeTime(info.lastInputTime)} (${formatTimestamp(info.lastInputTime)})
  Last Output: ${formatRelativeTime(info.lastOutputTime)} (${formatTimestamp(info.lastOutputTime)})
  Agent State: ${info.agentState || "N/A"}
  Last State Change: ${info.lastStateChange != null ? formatRelativeTime(info.lastStateChange) : "N/A"}
  Activity Tier: ${info.activityTier}

Performance & Diagnostics:
  Output Buffer Size: ${info.outputBufferSize} lines
  Semantic Buffer: ${info.semanticBufferLines} lines
`;

    try {
      await navigator.clipboard.writeText(diagnosticInfo);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg">
      <AppDialog.Header>
        <AppDialog.Title icon={<Info className="h-5 w-5" />}>Terminal Information</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {loading && (
          <div className="text-center text-daintree-text/70 py-8" role="status" aria-live="polite">
            Loading terminal info...
          </div>
        )}

        {error && (
          <div
            className="bg-status-error/10 border border-status-error/30 rounded-[var(--radius-lg)] p-4 text-status-error select-text"
            role="alert"
          >
            <p className="font-semibold mb-1">Failed to load terminal information</p>
            <p className="text-sm font-mono break-all">{error}</p>
          </div>
        )}

        {info && !loading && (
          <div className="space-y-6">
            <InfoSection title="Session Metadata">
              <InfoRow label="Terminal ID" value={info.id} mono />
              <InfoRow label="Kind" value={info.kind || "terminal"} />
              <InfoRow label="Type" value={info.type || "terminal"} />
              <InfoRow label="Title" value={info.title} />
              <InfoRow label="Project ID" value={info.projectId} mono />
              <InfoRow label="Worktree ID" value={info.worktreeId} mono />
              <InfoRow label="Current Directory" value={info.cwd} mono />
            </InfoSection>

            <InfoSection title="Spawn Command">
              <InfoRow label="Shell" value={info.shell} mono />
              <InfoListRow label="Args" items={info.spawnArgs} />
            </InfoSection>

            {showAgentLaunchSection(info) && (
              <InfoSection title="Agent — Launch Context">
                {info.agentId && <InfoRow label="Agent ID" value={info.agentId} />}
                <InfoListRow label="Launch Flags" items={info.agentLaunchFlags} />
                {info.agentModelId && <InfoRow label="Model" value={info.agentModelId} mono />}
              </InfoSection>
            )}

            {showAgentLiveSection(info) && (
              <InfoSection title="Agent — Live State">
                <InfoRow
                  label="Detected Agent"
                  value={info.detectedAgentId ?? "None — agent has exited"}
                />
              </InfoSection>
            )}

            <InfoSection title="Terminal Classification">
              <InfoRow label="Agent Terminal" value={info.isAgentTerminal ? "Yes" : "No"} />
              <InfoRow label="PTY Active" value={info.hasPty ? "Yes" : "No"} />
              <InfoRow label="Analysis Enabled" value={info.analysisEnabled ? "Yes" : "No"} />
              <InfoRow label="Resize Strategy" value={info.resizeStrategy || "default"} />
            </InfoSection>

            <InfoSection title="PTY Diagnostics">
              {info.ptyCols != null && info.ptyRows != null && (
                <InfoRow label="Dimensions" value={`${info.ptyCols} × ${info.ptyRows}`} />
              )}
              <InfoRow label="Shell PID" value={info.ptyPid} mono />
              {info.ptyTty != null && <InfoRow label="TTY Device" value={info.ptyTty} mono />}
              <InfoRow label="Foreground Process" value={info.ptyForegroundProcess} />
              {info.exitCode != null && <InfoRow label="Exit Code" value={info.exitCode} mono />}
            </InfoSection>

            <InfoSection title="Runtime Statistics">
              <InfoRow label="Running Time" value={formatDuration(Date.now() - info.spawnedAt)} />
              <InfoRow label="Spawned At" value={formatTimestamp(info.spawnedAt)} />
              <InfoRow label="Restart Count" value={info.restartCount} />
            </InfoSection>

            <InfoSection title="Activity Metrics">
              <InfoRow
                label="Last Input"
                value={`${formatRelativeTime(info.lastInputTime)} (${formatTimestamp(info.lastInputTime)})`}
              />
              <InfoRow
                label="Last Output"
                value={`${formatRelativeTime(info.lastOutputTime)} (${formatTimestamp(info.lastOutputTime)})`}
              />
              <InfoRow label="Agent State" value={info.agentState || "N/A"} />
              <InfoRow
                label="Last State Change"
                value={
                  info.lastStateChange != null
                    ? `${formatRelativeTime(info.lastStateChange)} (${formatTimestamp(info.lastStateChange)})`
                    : "N/A"
                }
              />
              <InfoRow label="Activity Tier" value={info.activityTier} />
            </InfoSection>

            <InfoSection title="Performance & Diagnostics">
              <InfoRow label="Output Buffer Size" value={`${info.outputBufferSize} lines`} />
              <InfoRow label="Semantic Buffer" value={`${info.semanticBufferLines} lines`} />
            </InfoSection>
          </div>
        )}
      </AppDialog.Body>

      {info && !loading && (
        <AppDialog.Footer>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={copyToClipboard}>Copy to Clipboard</Button>
        </AppDialog.Footer>
      )}
    </AppDialog>
  );
}
