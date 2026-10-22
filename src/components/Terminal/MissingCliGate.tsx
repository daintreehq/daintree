import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, KeyRound, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PaneState, PaneStateActions } from "@/components/ui/PaneState";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { CopyableCommand } from "@/components/Setup/CopyableCommand";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { systemClient } from "@/clients/systemClient";
import { getAgentConfig } from "@/config/agents";
import { isHostLinux, isHostMac } from "@/hooks/useHostPlatform";
import { useRemoteHostName } from "@/hooks/useSettingsOwner";
import { cn } from "@/lib/utils";
import { SEVERITY_VISUAL, type StatusSeverity } from "@/lib/statusSeverity";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import type { AgentCliDetail } from "@shared/types/ipc";
import type { AgentInstallBlock } from "@shared/config/agentRegistry";

// The CLI installs on the project's host, so its instructions follow that machine.
function getOsKey(): "macos" | "windows" | "linux" {
  if (isHostMac()) return "macos";
  if (isHostLinux()) return "linux";
  return "windows";
}

function getOsLabel(): string {
  if (isHostMac()) return "macOS";
  if (isHostLinux()) return "Linux";
  return "Windows";
}

interface GateCopy {
  icon: ReactNode;
  title: string;
  description: ReactNode;
}

function severityIcon(severity: StatusSeverity): ReactNode {
  const { Icon, toneClass } = SEVERITY_VISUAL[severity];
  return <Icon className={toneClass} />;
}

// Each title names what the probe observed for this agent, not a cause: a denied
// exec is reported as denied, never as "blocked by security software", which
// would send the user into endpoint settings on a guess.
function getGateCopy(agentName: string, detail: AgentCliDetail, hostName: string | null): GateCopy {
  const where = hostName ?? "this machine";
  // Paths and probe messages are unbroken tokens that would push a narrow pane
  // sideways, so the description may break anywhere inside them.
  const path = detail.resolvedPath ? (
    <span className="font-mono text-xs select-text">{detail.resolvedPath}</span>
  ) : null;
  const lastPath = path ? <span className="mt-1 block">Last found at {path}</span> : null;

  switch (detail.state) {
    case "ready":
      return {
        icon: severityIcon("success"),
        title: `${agentName} CLI is available`,
        description: `Continue to start ${agentName} in this pane.`,
      };
    // Launchable by design — the CLI prompts for sign-in itself — so this is
    // reachable only when a re-check lands here mid-flight or a probe reports it
    // defensively. Without its own branch it fell through to "blocked", which
    // sends the user hunting through endpoint security for a sign-in prompt.
    case "unauthenticated":
      return {
        icon: <KeyRound className="text-text-secondary" />,
        title: `${agentName} sign-in not detected`,
        description: "The CLI is available. It asks you to sign in the first time it starts.",
      };
    case "missing":
      return {
        icon: severityIcon("warning"),
        title: `${agentName} CLI not found`,
        description: (
          <span className="wrap-anywhere">
            {detail.message ?? `No ${agentName} executable was found on ${where}.`}
            {lastPath}
          </span>
        ),
      };
    case "installed":
      if (detail.via === "wsl") {
        return {
          icon: severityIcon("warning"),
          title: `${agentName} found only in WSL`,
          description: `Found in ${detail.wslDistro ?? "a WSL distro"}, but only binaries on ${where} can be launched directly. Install it natively, or run it anyway if you use a wrapper.`,
        };
      }
      return {
        icon: severityIcon("warning"),
        title: `${agentName} can't be launched directly`,
        description: (
          <span className="wrap-anywhere">
            {detail.message ??
              (path ? (
                <>Found {path}, but it can't be launched directly.</>
              ) : (
                "The CLI is installed but can't be launched directly."
              ))}{" "}
            Point Daintree at the executable in agent settings.
          </span>
        ),
      };
    default:
      return {
        icon: severityIcon("error"),
        title: `Running ${agentName} was denied`,
        description: (
          <span className="wrap-anywhere">
            {detail.message ??
              (path ? (
                <>The system refused to run {path}.</>
              ) : (
                "The executable exists, but the system refused to run it."
              ))}{" "}
            If it runs from your own terminal, security software may be stopping Daintree.
          </span>
        ),
      };
  }
}

function InstallCommands({ blocks }: { blocks: AgentInstallBlock[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => (
        <div key={i} className="space-y-1.5">
          {block.label && <p className="text-xs text-text-secondary">{block.label}</p>}
          {block.steps && (
            <ol className="list-decimal space-y-1 pl-4">
              {block.steps.map((step, j) => (
                <li key={j} className="text-xs text-text-secondary">
                  {step}
                </li>
              ))}
            </ol>
          )}
          {block.commands && (
            <div className="space-y-1.5">
              {block.commands.map((cmd) => (
                <CopyableCommand key={cmd} command={cmd} wrap />
              ))}
            </div>
          )}
          {block.notes && (
            <div className="space-y-0.5">
              {block.notes.map((note, j) => (
                <p key={j} className="text-xs text-text-secondary">
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
  const hostName = useRemoteHostName();

  const refresh = useCliAvailabilityStore((s) => s.refresh);
  const isRefreshing = useCliAvailabilityStore((s) => s.isRefreshing);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [checkedWithoutChange, setCheckedWithoutChange] = useState(false);

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
    setCheckedWithoutChange(false);
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
    } else {
      setCheckedWithoutChange(true);
    }
  };

  const osKey = getOsKey();
  const installBlocks = agentConfig?.install?.byOs?.[osKey];
  const troubleshooting = agentConfig?.install?.troubleshooting;
  const docsUrl = agentConfig?.install?.docsUrl;

  const copy = getGateCopy(agentName, detail, hostName);
  const launchable = isAgentLaunchable(state);
  const isWsl = state === "installed" && detail.via === "wsl";
  // WSL needs the same native install as a missing CLI; a wrapper or a denied
  // exec is not fixed by installing again.
  const showInstall = (state === "missing" || isWsl) && !!installBlocks?.length;
  const showTroubleshooting = state === "missing" && !!troubleshooting?.length;
  // Install docs answer a CLI that isn't usable yet; once it is, they're noise.
  const showDocs = !!docsUrl && !launchable;
  // A wrapper is repaired by pointing settings at the real executable; every
  // other state is repaired outside Daintree and confirmed by checking again.
  const settingsIsPrimary = state === "installed" && !isWsl;

  const checkLabel = launchable ? "Continue launch" : "Check again";
  const checkButton = (
    <Button
      size="sm"
      variant={settingsIsPrimary ? "ghost" : "contrast"}
      className={cn(isRefreshing && "cursor-default")}
      onClick={() => {
        if (!isRefreshing) void handleRefresh();
      }}
      aria-busy={isRefreshing || undefined}
      aria-disabled={isRefreshing || undefined}
    >
      {/* Continuing is not a refresh, so it wears no retry glyph at rest — only
          the spinner while its confirming probe runs. */}
      {(!launchable || isRefreshing) && (
        <SpinningIcon icon={RefreshCw} active={isRefreshing} size={14} />
      )}
      {checkLabel}
    </Button>
  );

  // The one live region for check results: it is mounted before any check
  // starts, so a failure is announced reliably, and the banner beside it stays
  // silent rather than announcing the same failure twice.
  const status = isRefreshing
    ? `Checking for ${agentName}…`
    : refreshFailed
      ? null
      : checkedWithoutChange
        ? `Checked again — ${agentName} still can't be launched`
        : "";

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <PaneState icon={copy.icon} title={copy.title} description={copy.description}>
        {(showInstall || showDocs || refreshFailed) && (
          <div className="w-full max-w-md min-w-0 space-y-4 text-left">
            {showInstall && installBlocks && (
              <section aria-label={`Install on ${getOsLabel()}`} className="space-y-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">Install on {getOsLabel()}</p>
                  <p className="text-xs text-text-secondary">
                    Run one of these in {hostName ? `a terminal on ${hostName}` : "your terminal"},
                    then check again.
                  </p>
                </div>
                <InstallCommands blocks={installBlocks} />
              </section>
            )}
            {/* Beside the commands it belongs to; alone, it centres under the
                description like the rest of the pane state. */}
            {showDocs && docsUrl && (
              <div className={cn(!showInstall && "text-center")}>
                <Button
                  variant="link"
                  size="inline"
                  className="text-xs"
                  onClick={() => void systemClient.openExternal(docsUrl)}
                >
                  {agentName} install docs
                  <ExternalLink aria-hidden="true" />
                </Button>
              </div>
            )}
            {refreshFailed && (
              <InlineStatusBanner
                severity="error"
                inset
                role="status"
                ariaLive="off"
                title="Couldn't check again"
                description="The availability check didn't finish, so the result above is from the last check that did."
              />
            )}
          </div>
        )}

        <PaneStateActions>
          {!launchable && (
            <Button size="sm" variant="ghost" onClick={onRunAnyway}>
              Run anyway
            </Button>
          )}
          {settingsIsPrimary ? (
            <>
              {checkButton}
              <Button size="sm" variant="contrast" onClick={onOpenAgentSettings}>
                <Settings2 aria-hidden="true" />
                Agent settings
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={onOpenAgentSettings}>
                <Settings2 aria-hidden="true" />
                Agent settings
              </Button>
              {checkButton}
            </>
          )}
        </PaneStateActions>

        {/* Its line is reserved even while empty, so a check starting or settling
            never re-centres the block under the pointer that just pressed it. */}
        <p role="status" className="min-h-4 text-center text-xs text-text-secondary">
          {status}
          {refreshFailed && (
            <span className="sr-only">
              Couldn't check again. The availability check didn't finish.
            </span>
          )}
        </p>

        {showTroubleshooting && troubleshooting && (
          <section aria-label="Troubleshooting" className="w-full max-w-md min-w-0 space-y-1.5">
            <p className="text-xs font-medium text-text-secondary">Still not found?</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {troubleshooting.map((tip, i) => (
                <li key={i} className="text-xs text-text-secondary">
                  {tip}
                </li>
              ))}
            </ul>
          </section>
        )}
      </PaneState>
    </div>
  );
}
