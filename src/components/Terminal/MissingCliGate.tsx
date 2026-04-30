import { useState, useCallback } from "react";
import { AlertTriangle, Terminal, Clipboard, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAgentConfig } from "@/config/agents";
import { isMac, isLinux } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { AgentCliDetail, AgentAvailabilityState } from "@shared/types/ipc";
import type { AgentInstallBlock } from "@shared/config/agentRegistry";

function getOsKey(): "macos" | "windows" | "linux" {
  if (isMac()) return "macos";
  if (isLinux()) return "linux";
  return "windows";
}

function getOsLabel(): string {
  if (isMac()) return "macOS";
  if (isLinux()) return "Linux";
  return "Windows";
}

function StateBanner({ state, detail }: { state: AgentAvailabilityState; detail: AgentCliDetail }) {
  if (state === "ready") {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-[var(--radius-md)] border border-status-success/20 bg-status-success/5">
        <Check className="w-5 h-5 text-status-success shrink-0 mt-px" />
        <div>
          <p className="text-sm font-medium">CLI is now available</p>
          <p className="text-xs text-daintree-text/60 mt-1">
            The agent binary was detected. Close this panel and re-launch to start a session.
          </p>
        </div>
      </div>
    );
  }

  if (state === "missing") {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-[var(--radius-md)] border border-status-warning/20 bg-status-warning/5">
        <AlertTriangle className="w-5 h-5 text-status-warning shrink-0 mt-px" />
        <div>
          <p className="text-sm font-medium">CLI binary not found</p>
          <p className="text-xs text-daintree-text/60 mt-1">
            {detail.message ?? "The agent executable was not detected on your system."}
          </p>
          {detail.resolvedPath && (
            <p className="text-xs text-daintree-text/40 mt-1 font-mono select-text">
              Last known path: {detail.resolvedPath}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (state === "installed") {
    const isWsl = detail.via === "wsl";
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-[var(--radius-md)] border border-status-warning/20 bg-status-warning/5">
        <AlertTriangle className="w-5 h-5 text-status-warning shrink-0 mt-px" />
        <div>
          <p className="text-sm font-medium">
            {isWsl ? "Detected in WSL" : "CLI installed but not directly launchable"}
          </p>
          <p className="text-xs text-daintree-text/60 mt-1">
            {isWsl
              ? `Found in WSL (${detail.wslDistro ?? "unknown distro"}) but Daintree launches binaries directly from the host. Install a native binary or use "Run anyway" if you have a wrapper.`
              : (detail.message ??
                "The binary is installed but Daintree cannot launch it directly.")}
          </p>
        </div>
      </div>
    );
  }

  // blocked
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/5">
      <AlertTriangle className="w-5 h-5 text-status-error shrink-0 mt-px" />
      <div>
        <p className="text-sm font-medium">Blocked by security software</p>
        <p className="text-xs text-daintree-text/60 mt-1">
          {detail.message ?? "The binary exists but execution was denied."}
        </p>
        <p className="text-xs text-daintree-text/40 mt-1">
          Check your endpoint security settings or add an allowlist entry.
        </p>
      </div>
    </div>
  );
}

function InstallCommands({ blocks }: { blocks: AgentInstallBlock[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => (
        <div key={i}>
          {block.label && (
            <p className="text-xs font-medium text-daintree-text/50 mb-1.5">{block.label}</p>
          )}
          {block.steps && (
            <ol className="list-decimal list-inside space-y-1 mb-2">
              {block.steps.map((step, j) => (
                <li key={j} className="text-xs text-daintree-text/60">
                  {step}
                </li>
              ))}
            </ol>
          )}
          {block.commands && (
            <div className="space-y-1.5">
              {block.commands.map((cmd, j) => (
                <CopyableCommand key={j} command={cmd} />
              ))}
            </div>
          )}
          {block.notes && (
            <div className="mt-2 space-y-0.5">
              {block.notes.map((note, j) => (
                <p key={j} className="text-xs text-daintree-text/40">
                  {note}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  }, [command]);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] bg-overlay-subtle border border-daintree-border font-mono text-xs select-text group">
      <span className="flex-1 truncate text-daintree-text/70">{command}</span>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 p-0.5 rounded hover:bg-overlay transition-colors duration-150 text-daintree-text/30 hover:text-daintree-text/60"
        aria-label={copied ? "Copied" : "Copy command"}
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-status-success" />
        ) : (
          <Clipboard className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}

export interface MissingCliGateProps {
  agentId: string;
  detail: AgentCliDetail;
  onRunAnyway: () => void;
}

export function MissingCliGate({ agentId, detail, onRunAnyway }: MissingCliGateProps) {
  const agentConfig = getAgentConfig(agentId);
  const agentName = agentConfig?.name ?? agentId;
  const state = detail.state;

  const osKey = getOsKey();
  const installBlocks = agentConfig?.install?.byOs?.[osKey];
  const troubleshooting = agentConfig?.install?.troubleshooting;
  const docsUrl = agentConfig?.install?.docsUrl;

  return (
    <div className="flex-1 min-h-0 bg-daintree-bg flex flex-col items-center justify-center overflow-auto">
      <div className="w-full max-w-lg space-y-4 px-6 py-8">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[var(--radius-md)] bg-overlay-subtle border border-daintree-border flex items-center justify-center">
            <Terminal className="w-4 h-4 text-daintree-text/40" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">{agentName}</h2>
            <p className="text-xs text-daintree-text/40">Setup required before launch</p>
          </div>
        </div>

        <StateBanner state={state} detail={detail} />

        {state === "missing" && installBlocks && installBlocks.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-daintree-text/50">Install on {getOsLabel()}</p>
            <InstallCommands blocks={installBlocks} />
          </div>
        )}

        {state === "missing" && troubleshooting && troubleshooting.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-daintree-text/50">Troubleshooting</p>
            <ul className="list-disc list-inside space-y-0.5">
              {troubleshooting.map((tip, i) => (
                <li key={i} className="text-xs text-daintree-text/40">
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div
          className={cn(
            "flex items-center gap-2 pt-1",
            state === "missing" ? "justify-between" : "justify-end"
          )}
        >
          {docsUrl && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.electron.system.openExternal(docsUrl)}
            >
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              Docs
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onRunAnyway}>
            Run anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
