import { useState, useEffect } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Info } from "lucide-react";
import type { TerminalInfoPayload } from "@/types/electron";

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
      <h3 className="text-sm font-semibold text-canopy-text/90 border-b border-canopy-border pb-2">
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
  return (
    <div className="flex justify-between items-start gap-4 text-sm">
      <span className="text-canopy-text/70 shrink-0 select-none">{label}:</span>
      <span
        className={`text-canopy-text text-right select-text ${mono ? "font-mono text-xs" : ""}`}
        title={typeof displayValue === "string" ? displayValue : undefined}
      >
        {displayValue}
      </span>
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
        const terminalInfo = await window.electron.terminal.getInfo(terminalId);
        if (isMounted) {
          setInfo(terminalInfo);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
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

  const copyToClipboard = async () => {
    if (!info) return;

    const diagnosticInfo = `Terminal Diagnostic Information
=====================================

Session Metadata:
  ID: ${info.id}
  Type: ${info.type || "N/A"}
  Title: ${info.title || "N/A"}
  Project ID: ${info.projectId || "N/A"}
  Worktree ID: ${info.worktreeId || "N/A"}
  CWD: ${info.cwd}

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
          <div className="text-center text-canopy-text/70 py-8" role="status" aria-live="polite">
            Loading terminal info...
          </div>
        )}

        {error && (
          <div
            className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 select-text"
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
              <InfoRow label="Type" value={info.type || "shell"} />
              <InfoRow label="Title" value={info.title} />
              <InfoRow label="Project ID" value={info.projectId} mono />
              <InfoRow label="Worktree ID" value={info.worktreeId} mono />
              <InfoRow label="Current Directory" value={info.cwd} mono />
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
          <button
            type="button"
            onClick={copyToClipboard}
            className="px-4 py-2 bg-canopy-accent text-white rounded-lg hover:bg-canopy-accent/90 transition-colors font-medium"
          >
            Copy to Clipboard
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-canopy-border/30 text-canopy-text rounded-lg hover:bg-canopy-border/50 transition-colors font-medium"
          >
            Close
          </button>
        </AppDialog.Footer>
      )}
    </AppDialog>
  );
}
