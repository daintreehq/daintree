import { useState, useEffect } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react";
import { logError } from "@/utils/logger";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TerminalInfoPayload } from "@/types/electron";
import { actionService } from "@/services/ActionService";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";

const SYNC_MODE_POLL_MS = 250;

function formatSyncMode(value: boolean | null): string {
  if (value === null) return "Unavailable";
  return value ? "On" : "Off";
}

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
  const [syncMode, setSyncMode] = useState<boolean | null>(null);
  const panelRaw = usePanelStore((state) => state.panelsById[terminalId]);
  const panel = panelRaw && isPtyPanel(panelRaw) ? panelRaw : undefined;

  useEffect(() => {
    if (!isOpen) {
      setInfo(null);
      setError(null);
      setLoading(false);
      setSyncMode(null);
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

  useEffect(() => {
    if (!isOpen) return;
    // Immediate read on open so the dialog reflects the current sync-mode
    // before the first poll lands.
    setSyncMode(terminalInstanceService.getSynchronizedOutputMode(terminalId));
  }, [isOpen, terminalId]);

  // xterm 6 mutates terminal.modes asynchronously as the parser consumes
  // BSU/ESU sequences, and there is no change event. Poll at the same cadence
  // as REFLOW_THROTTLE_MS (250ms) — enough resolution to catch most BSU blocks
  // while the dialog is open. Visibility-gated so the poll pauses while the
  // window is hidden and snaps back on restore.
  useVisibilityAwareInterval(
    () => setSyncMode(terminalInstanceService.getSynchronizedOutputMode(terminalId)),
    SYNC_MODE_POLL_MS,
    isOpen
  );

  const launchAgentId = panel?.launchAgentId ?? info?.launchAgentId;
  const command = panel?.command ?? info?.command;
  const worktreeId = panel?.worktreeId ?? info?.worktreeId;
  const titleMode = panel?.titleMode ?? info?.titleMode;
  const spawnSource = panel?.spawnedBy;
  // An assistant-launched run arrives over the MCP bridge like any other, so
  // the transport answer stays "Yes" — what changed is that we can now say who
  // was on the other end of it (#11808). Kept as two rows rather than one:
  // folding the actor into the transport row would drop the fact that this is
  // still an MCP dispatch, which is the useful half when debugging routing.
  const startedByAssistant = spawnSource === "assistant";
  const startedViaMcp =
    spawnSource === "mcp" || startedByAssistant ? "Yes" : spawnSource ? "No" : "Unknown";
  const uiStartedAt = panel?.startedAt;
  const spawnStatus = panel?.spawnStatus;
  const location = panel?.location;
  const agentPresetId = panel?.agentPresetId ?? info?.agentPresetId;
  const agentPresetColor = panel?.agentPresetColor ?? info?.agentPresetColor;
  const originalPresetId = panel?.originalPresetId ?? info?.originalAgentPresetId;
  const agentSessionId = panel?.agentSessionId ?? info?.agentSessionId;

  // "Launch Context" reflects how the panel was configured at spawn time.
  const showAgentLaunchSection = !!(
    launchAgentId ||
    (info?.agentLaunchFlags && info.agentLaunchFlags.length > 0) ||
    info?.agentModelId ||
    agentPresetId ||
    originalPresetId
  );
  // "Live State" reflects what's running right now. Shown for agent launches,
  // while a runtime agent is detected, or once an agent has ever been detected
  // in this session (so plain terminals that ran `claude` still show the exit).
  const showAgentLiveSection = !!(
    launchAgentId ||
    info?.detectedAgentId ||
    info?.everDetectedAgent
  );

  const formatArgsForClipboard = (args: string[] | undefined): string => {
    if (args === undefined) return "N/A";
    if (args.length === 0) return "(none)";
    return args.join(" ");
  };

  const copyToClipboard = async () => {
    if (!info) return;

    const launchSection = showAgentLaunchSection
      ? `

Agent — Launch Context:
  Launch Agent: ${launchAgentId ?? "N/A"}
  Command: ${command ?? "N/A"}
  Launch Flags: ${formatArgsForClipboard(info.agentLaunchFlags)}
  Model: ${info.agentModelId ?? "N/A"}
  Preset: ${agentPresetId ?? "N/A"}
  Preset Color: ${agentPresetColor ?? "N/A"}
  Original Preset: ${originalPresetId ?? "N/A"}`
      : "";

    const liveSection = showAgentLiveSection
      ? `

Agent — Live State:
  Detected Agent ID: ${info.detectedAgentId ?? (info.everDetectedAgent ? "None — agent has exited" : "Not detected yet")}
  Agent State: ${info.agentState ?? "N/A"}
  Session ID: ${agentSessionId ?? "N/A"}`
      : "";

    const agentSection = launchSection + liveSection;

    const diagnosticInfo = `Terminal Diagnostic Information
=====================================

Session Metadata:
  ID: ${info.id}
  Kind: ${info.kind || "terminal"}
  Title: ${info.title || "N/A"}
  Title Mode: ${titleMode ?? "default"}
  Project ID: ${info.projectId || "N/A"}
  Worktree ID: ${worktreeId || "N/A"}
  CWD: ${info.cwd}
  Location: ${location ?? "N/A"}
  Spawn Source: ${spawnSource ?? "N/A"}
${startedByAssistant ? "  Started By: Daintree Assistant\n" : ""}  Started via MCP: ${startedViaMcp}
  Spawn Status: ${spawnStatus ?? "N/A"}
  UI Created At: ${uiStartedAt != null ? formatTimestamp(uiStartedAt) : "N/A"}

Spawn Command:
  Shell: ${info.shell || "N/A"}
  Command: ${command ?? "N/A"}
  Args: ${formatArgsForClipboard(info.spawnArgs)}${agentSection}

Terminal Classification:
  Agent Launch Hint: ${launchAgentId ? "Yes" : "No"}
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
  Synchronized Output (DEC 2026): ${formatSyncMode(syncMode)}
`;

    try {
      await navigator.clipboard.writeText(diagnosticInfo);
    } catch (err) {
      logError("Failed to copy to clipboard", err);
    }
  };

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg" data-testid="terminal-info-dialog">
      <AppDialog.Header>
        <AppDialog.Title icon={<Info className="h-5 w-5" />}>Terminal Information</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {loading && (
          <div
            className="text-center text-daintree-text/70 py-8"
            role="status"
            aria-live="polite"
            data-testid="terminal-info-loading"
          >
            Loading terminal info...
          </div>
        )}

        {error && (
          <div
            className="bg-status-error/10 border border-status-error/30 rounded-[var(--radius-lg)] p-4 text-status-error select-text"
            role="alert"
            data-testid="terminal-info-error"
          >
            <p className="font-semibold mb-1">Failed to load terminal information</p>
            <p className="text-sm font-mono break-all">{error}</p>
          </div>
        )}

        {info && !loading && (
          <div className="space-y-6" data-testid="terminal-info-body">
            <InfoSection title="Session Metadata">
              <InfoRow label="Terminal ID" value={info.id} mono />
              <InfoRow label="Kind" value={info.kind || "terminal"} />
              <InfoRow label="Title" value={info.title} />
              <InfoRow label="Title Mode" value={titleMode ?? "default"} />
              <InfoRow label="Project ID" value={info.projectId} mono />
              <InfoRow label="Worktree ID" value={worktreeId} mono />
              <InfoRow label="Current Directory" value={info.cwd} mono />
              <InfoRow label="Location" value={location} />
              <InfoRow label="Spawn Source" value={spawnSource} />
              {startedByAssistant && <InfoRow label="Started By" value="Daintree Assistant" />}
              <InfoRow label="Started via MCP" value={startedViaMcp} />
              <InfoRow label="Spawn Status" value={spawnStatus} />
              {uiStartedAt != null && (
                <InfoRow label="UI Created At" value={formatTimestamp(uiStartedAt)} />
              )}
            </InfoSection>

            <InfoSection title="Spawn Command">
              <InfoRow label="Shell" value={info.shell} mono />
              {command && <InfoRow label="Command" value={command} mono />}
              <InfoListRow label="Args" items={info.spawnArgs} />
            </InfoSection>

            {showAgentLaunchSection && (
              <InfoSection title="Agent — Launch Context">
                {launchAgentId && <InfoRow label="Launch Agent" value={launchAgentId} />}
                <InfoListRow label="Launch Flags" items={info.agentLaunchFlags} />
                {info.agentModelId && <InfoRow label="Model" value={info.agentModelId} mono />}
                {agentPresetId && <InfoRow label="Preset" value={agentPresetId} mono />}
                {agentPresetColor && <InfoRow label="Preset Color" value={agentPresetColor} mono />}
                {originalPresetId && (
                  <InfoRow label="Original Preset" value={originalPresetId} mono />
                )}
              </InfoSection>
            )}

            {showAgentLiveSection && (
              <InfoSection title="Agent — Live State">
                <InfoRow
                  label="Detected Agent"
                  value={
                    info.detectedAgentId ??
                    (info.everDetectedAgent ? "None — agent has exited" : "Not detected yet")
                  }
                />
                {agentSessionId && <InfoRow label="Session ID" value={agentSessionId} mono />}
              </InfoSection>
            )}

            <InfoSection title="Terminal Classification">
              <InfoRow label="Agent Launch Hint" value={launchAgentId ? "Yes" : "No"} />
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
              <InfoRow label="Synchronized Output (DEC 2026)" value={formatSyncMode(syncMode)} />
            </InfoSection>
          </div>
        )}
      </AppDialog.Body>

      {info && !loading && (
        <AppDialog.Footer>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="contrast" onClick={copyToClipboard} data-testid="terminal-info-copy">
            Copy to Clipboard
          </Button>
        </AppDialog.Footer>
      )}
    </AppDialog>
  );
}
