import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Terminal, Check, ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { CopyableCommand } from "@/components/Setup/CopyableCommand";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { getAgentConfig } from "@/config/agents";
import { isMac, isLinux } from "@/lib/platform";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
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
            The agent binary was detected. Re-check to continue the launch.
          </p>
        </div>
      </div>
    );
  }

  // Launchable by design — the CLI prompts for sign-in itself — so this is
  // reachable only when a re-check lands here mid-flight or a probe reports it
  // defensively. Without its own branch it fell through to "blocked", which
  // sends the user hunting through endpoint security for a sign-in prompt.
  if (state === "unauthenticated") {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-[var(--radius-md)] border border-status-success/20 bg-status-success/5">
        <KeyRound className="w-5 h-5 text-status-success shrink-0 mt-px" />
        <div>
          <p className="text-sm font-medium">Sign-in not detected</p>
          <p className="text-xs text-daintree-text/60 mt-1">
            The CLI is available but no signed-in session was found. Re-check to continue — the CLI
            prompts for sign-in on its first run.
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
              ? `Found in WSL (${detail.wslDistro ?? "unknown distro"}) — only host binaries can be launched directly. Install a native binary or use "Run anyway" if you have a wrapper.`
              : (detail.message ?? "The binary is installed but can't be launched directly.")}
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
              {block.commands.map((cmd) => (
                <CopyableCommand key={cmd} command={cmd} />
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

export interface MissingCliGateProps {
  agentId: string;
  detail: AgentCliDetail;
  onRunAnyway: () => void;
  /**
   * Continue the launch this gate stood in for. Fired only after a re-check
   * confirms the CLI became launchable — the gate owns the probe, the caller
   * owns what relaunching means for its own surface.
   */
  onAvailabilityReady: () => void;
  /** Secondary route to the agent's persistent CLI configuration. */
  onOpenAgentSettings: () => void;
}

export function MissingCliGate({
  agentId,
  detail,
  onRunAnyway,
  onAvailabilityReady,
  onOpenAgentSettings,
}: MissingCliGateProps) {
  const agentConfig = getAgentConfig(agentId);
  const agentName = agentConfig?.name ?? agentId;
  const state = detail.state;

  const refresh = useCliAvailabilityStore((s) => s.refresh);
  const isRefreshing = useCliAvailabilityStore((s) => s.isRefreshing);
  const [refreshFailed, setRefreshFailed] = useState(false);

  // The probe outlives the panel: closing the gate mid-re-check must not
  // relaunch an agent into a pane that no longer exists.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Held in a ref, not read off `isRefreshing`: that value is captured at
  // render, so a second press landing before React re-renders would sail past
  // it. The store singleflights the probe itself, but two handlers resuming
  // would both reach the continuation below and launch twice.
  const probeInFlightRef = useRef(false);

  const handleRefresh = async () => {
    if (probeInFlightRef.current) return;
    probeInFlightRef.current = true;
    setRefreshFailed(false);
    try {
      // `force` skips the passive throttle window — this is an explicit gesture,
      // and a user who just installed the CLI is exactly who the window blocks.
      await refresh(true);
    } catch {
      if (mountedRef.current) setRefreshFailed(true);
      return;
    } finally {
      probeInFlightRef.current = false;
    }
    if (!mountedRef.current) return;
    // Read `availability`, not `details`: the store's fetch deliberately
    // swallows a `getDetails` failure and keeps the previous details while
    // still resolving, so details can be stale here. Availability is always
    // replaced by a refresh that resolved.
    const availability = useCliAvailabilityStore.getState().availability;
    if (isAgentLaunchable(availability[agentId])) {
      onAvailabilityReady();
    }
  };

  const osKey = getOsKey();
  const installBlocks = agentConfig?.install?.byOs?.[osKey];
  const troubleshooting = agentConfig?.install?.troubleshooting;
  const docsUrl = agentConfig?.install?.docsUrl;

  return (
    // `my-auto` on the child rather than `justify-center` on the scrollport:
    // `justify-content: center` distributes overflow to BOTH ends, so once the
    // install blocks and troubleshooting list outgrow a short pane the agent
    // name and "Setup required" spill above the scroll origin and cannot be
    // scrolled back to. Auto margins collapse to zero when there is no free
    // space, so the same centring degrades to top alignment instead.
    <div className="flex-1 min-h-0 bg-daintree-bg flex flex-col items-center overflow-auto">
      <div className="my-auto w-full max-w-lg space-y-4 px-6 py-8">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[var(--radius-md)] bg-overlay-subtle border border-daintree-border flex items-center justify-center">
            <Terminal className="w-4 h-4 text-daintree-text/40" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">{agentName}</h2>
            <p className="text-xs text-daintree-text/40">
              {isAgentLaunchable(state)
                ? "Ready to continue launch"
                : "Setup required before launch"}
            </p>
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

        {refreshFailed && (
          <InlineStatusBanner
            severity="error"
            icon={AlertTriangle}
            title="Couldn't re-check the CLI"
            description="The availability probe didn't finish. Try again, or run the agent anyway if you know the binary works."
          />
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
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
          {/* `ml-auto` right-aligns the recovery group whether or not Docs
              renders, so the row needs no state-dependent justification. */}
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <Button size="sm" variant="ghost" onClick={onOpenAgentSettings}>
              Agent settings
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing}
            >
              <SpinningIcon icon={RefreshCw} active={isRefreshing} size={14} className="mr-1.5" />
              Re-check
            </Button>
            <Button size="sm" variant="outline" onClick={onRunAnyway}>
              Run anyway
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
