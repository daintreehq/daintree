import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Download,
  AlertCircle,
} from "lucide-react";
import { AGENT_REGISTRY, getAgentConfig } from "@/config/agents";
import { BrandMark } from "@/components/icons";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import {
  extractInspectUrl,
  getInstallBlocksForCurrentOS,
  isBlockExecutable,
} from "@/lib/agentInstall";
import { systemClient } from "@/clients";
import { useAgentSettingsStore } from "@/store";
import { DEFAULT_DANGEROUS_ARGS, resolveDangerousMode } from "@shared/types/agentSettings";
import { CopyableCommand } from "./CopyableCommand";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { AGENT_DESCRIPTIONS } from "@/config/agents";
import type { CliAvailability } from "@shared/types";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { formatErrorMessage } from "@shared/utils/errorMessage";

const AGENT_ORDER = LAUNCHABLE_AGENT_IDS;

type CardStatus = "idle" | "installing" | "installed" | "error" | "manual";

interface AgentCliStepProps {
  availability: CliAvailability;
  selections: Record<string, boolean>;
  onInstallComplete?: () => void;
  /**
   * Reports whether an install is in flight so the shell can lock navigation
   * and dismissal. An install that is interrupted mid-batch stops before the
   * remaining agents, so Continue/Back/Escape must not be live while it runs.
   */
  onBusyChange?: (busy: boolean) => void;
  // During first-run, the dedicated permissions step owns the global trust
  // decision, so the per-agent dangerous toggles here are suppressed to avoid
  // a competing control.
  isFirstRun?: boolean;
}

export function AgentCliStep({
  availability,
  selections,
  onInstallComplete,
  onBusyChange,
  isFirstRun = false,
}: AgentCliStepProps) {
  const [cardStatuses, setCardStatuses] = useState<Record<string, CardStatus>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [expandedErrors, setExpandedErrors] = useState<Record<string, boolean>>({});
  const [selectedMethodIndex, setSelectedMethodIndex] = useState<Record<string, number>>({});
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const mountedRef = useRef(true);
  const installingRef = useRef(new Set<string>());
  const cardStatusesRef = useRef(cardStatuses);
  useEffect(() => {
    cardStatusesRef.current = cardStatuses;
  }, [cardStatuses]);

  const isBusy = isBatchRunning || Object.values(cardStatuses).includes("installing");
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  });
  useEffect(() => {
    onBusyChangeRef.current?.(isBusy);
  }, [isBusy]);
  // Release the lock if the step unmounts mid-install, so a shell that outlives
  // this component can never be left permanently undismissable.
  useEffect(() => {
    return () => onBusyChangeRef.current?.(false);
  }, []);

  const selectedAgentIds = useMemo(() => AGENT_ORDER.filter((id) => selections[id]), [selections]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initialize and update card statuses based on availability and block type
  useEffect(() => {
    setCardStatuses((prev) => {
      const next: Record<string, CardStatus> = {};
      for (const agentId of selectedAgentIds) {
        if (isAgentInstalled(availability[agentId])) {
          next[agentId] = "installed";
          continue;
        }
        const config = getAgentConfig(agentId);
        if (!config) continue;
        const blocks = getInstallBlocksForCurrentOS(config);
        if (!blocks || blocks.length === 0) continue;
        const methodIdx = selectedMethodIndex[agentId] ?? 0;
        const block = blocks[methodIdx] ?? blocks[0]!;

        const desiredStatus: CardStatus = !isBlockExecutable(block) ? "manual" : "idle";

        // Keep in-flight states unless availability changed to installed
        if (prev[agentId] === "installing" || prev[agentId] === "error") {
          next[agentId] = prev[agentId];
        } else {
          next[agentId] = desiredStatus;
        }
      }
      return next;
    });
  }, [availability, selectedMethodIndex, selectedAgentIds]);

  const handleInstall = useCallback(
    async (agentId: string) => {
      if (!mountedRef.current) return;
      if (installingRef.current.has(agentId)) return;

      const config = getAgentConfig(agentId);
      if (!config) return;

      const blocks = getInstallBlocksForCurrentOS(config);
      if (!blocks || blocks.length === 0) return;

      const methodIdx = selectedMethodIndex[agentId] ?? 0;
      const block = blocks[methodIdx] ?? blocks[0]!;
      if (!isBlockExecutable(block)) return;

      installingRef.current.add(agentId);

      const jobId = crypto.randomUUID();
      const errorLog: string[] = [];

      setCardStatuses((prev) => ({ ...prev, [agentId]: "installing" }));
      setCardErrors((prev) => ({ ...prev, [agentId]: "" }));

      const cleanup = window.electron.system.onAgentInstallProgress((event) => {
        if (event.jobId !== jobId) return;
        if (event.stream === "stderr") {
          errorLog.push(event.chunk);
        }
      });

      try {
        const result = await window.electron.system.installAgent({
          agentId,
          methodIndex: methodIdx,
          jobId,
        });

        if (!mountedRef.current) return;

        if (result.success) {
          setCardStatuses((prev) => ({ ...prev, [agentId]: "installed" }));
          onInstallComplete?.();
        } else {
          setCardStatuses((prev) => ({ ...prev, [agentId]: "error" }));
          setCardErrors((prev) => ({
            ...prev,
            [agentId]: errorLog.join("") || result.error || "Installation failed",
          }));
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setCardStatuses((prev) => ({ ...prev, [agentId]: "error" }));
        setCardErrors((prev) => ({
          ...prev,
          [agentId]: formatErrorMessage(err, "Installation failed"),
        }));
      } finally {
        installingRef.current.delete(agentId);
        cleanup();
      }
    },
    [selectedMethodIndex, onInstallComplete]
  );

  const handleInstallAll = useCallback(async () => {
    setIsBatchRunning(true);
    for (const agentId of selectedAgentIds) {
      if (!mountedRef.current) break;
      const status = cardStatusesRef.current[agentId];
      if (status === "installed" || status === "manual") continue;
      await handleInstall(agentId);
    }
    if (mountedRef.current) {
      setIsBatchRunning(false);
    }
  }, [selectedAgentIds, handleInstall]);

  const handleMethodChange = useCallback((agentId: string, index: number) => {
    setSelectedMethodIndex((prev) => ({ ...prev, [agentId]: index }));
    // Reset error state when switching methods
    setCardStatuses((prev) => {
      if (prev[agentId] === "error") return { ...prev, [agentId]: "idle" };
      return prev;
    });
    setCardErrors((prev) => ({ ...prev, [agentId]: "" }));
  }, []);

  const toggleErrorExpanded = useCallback((agentId: string) => {
    setExpandedErrors((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  }, []);

  const hasInstallableAgents = selectedAgentIds.some((id) => {
    const status = cardStatuses[id];
    return status === "idle" || status === "error";
  });

  const updateAgent = useAgentSettingsStore((s) => s.updateAgent);
  const agentSettings = useAgentSettingsStore((s) => s.settings?.agents);

  const agentsWithDangerousToggle = selectedAgentIds.filter(
    (id) => (DEFAULT_DANGEROUS_ARGS[id] ?? "") !== ""
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
        {selectedAgentIds.map((agentId) => {
          const config = AGENT_REGISTRY[agentId];
          if (!config) return null;

          const status = cardStatuses[agentId] ?? "idle";
          const blocks = getInstallBlocksForCurrentOS(config);
          const hasMultipleMethods = blocks && blocks.length > 1;
          const currentMethodIdx = selectedMethodIndex[agentId] ?? 0;
          const currentBlock = blocks?.[currentMethodIdx] ?? blocks?.[0];
          const Icon = config.icon;
          const description = AGENT_DESCRIPTIONS[agentId] ?? config.tooltip ?? "";
          const isInstalling = status === "installing";
          const isInstalled = status === "installed";
          const isError = status === "error";
          const isManual = status === "manual";
          const canInstall = status === "idle" || status === "error";
          const errorLog = cardErrors[agentId];
          const isErrorExpanded = expandedErrors[agentId];

          return (
            <div key={agentId} className="space-y-0">
              <div
                className={`flex items-center gap-3 w-full px-3 py-2 rounded-[var(--radius-md)] border transition-colors ${
                  isInstalling
                    ? "bg-overlay-soft border-border-strong"
                    : isError
                      ? "bg-status-error/5 border-status-error/20"
                      : "bg-daintree-bg/30 border-daintree-border"
                }`}
              >
                {/* The box only aligns the row; the mark carries its own colour and
                    no longer sits on a wash tile of the raw brand hex. */}
                <div className="w-8 h-8 flex items-center justify-center shrink-0">
                  <BrandMark brandColor={config.color}>
                    <Icon size={18} />
                  </BrandMark>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-daintree-text">{config.name}</div>
                  {description && (
                    <div className="text-2xs text-text-secondary truncate">{description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {config.install?.docsUrl && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="text-daintree-text/30 hover:text-daintree-text transition-colors p-0.5 cursor-pointer"
                          onClick={() => systemClient.openExternal(config.install!.docsUrl!)}
                          aria-label="Open documentation"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>View documentation</TooltipContent>
                    </Tooltip>
                  )}
                  {isInstalled ? (
                    <span className="inline-flex items-center gap-1 text-2xs text-status-success font-medium">
                      <CircleCheck className="w-3 h-3" />
                      Installed
                    </span>
                  ) : isInstalling ? (
                    <span className="inline-flex items-center gap-1 text-2xs text-text-secondary font-medium">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Installing
                    </span>
                  ) : isError ? (
                    <span className="inline-flex items-center gap-1 text-2xs text-status-error font-medium">
                      <AlertCircle className="w-3 h-3" />
                      Failed
                    </span>
                  ) : isManual ? (
                    <span className="inline-flex items-center gap-1 text-2xs text-text-secondary">
                      Manual
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-2xs text-text-muted">
                      <CircleDashed className="w-3 h-3" />
                      Not installed
                    </span>
                  )}
                  {canInstall && !isBatchRunning && (
                    <button
                      type="button"
                      onClick={() => handleInstall(agentId)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-2xs font-medium text-daintree-text hover:bg-overlay-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent"
                    >
                      <Download className="w-3 h-3" />
                      Install
                    </button>
                  )}
                </div>
              </div>

              {hasMultipleMethods && !isInstalled && (
                <div className="flex items-center gap-1 pl-14 pt-1 pb-0.5">
                  <span className="text-3xs text-daintree-text/30 mr-1">via</span>
                  {blocks.map((block, idx) => (
                    <button
                      key={idx}
                      type="button"
                      disabled={isInstalling || isBatchRunning}
                      onClick={() => handleMethodChange(agentId, idx)}
                      data-selected={idx === currentMethodIdx || undefined}
                      className="px-1.5 py-0.5 rounded text-3xs text-daintree-text/50 transition-colors hover:text-daintree-text/80 data-[selected]:bg-tint/[0.12] data-[selected]:text-daintree-text disabled:opacity-50 disabled:pointer-events-none"
                    >
                      {block.label ?? `Method ${idx + 1}`}
                    </button>
                  ))}
                </div>
              )}

              {isManual && currentBlock?.commands && (
                <div className="pl-14 pt-1.5 pb-1 space-y-1">
                  <div className="text-2xs text-text-secondary mb-1">
                    Run this command in your terminal. It will be detected automatically.
                  </div>
                  {currentBlock.commands.map((cmd) => (
                    <CopyableCommand key={cmd} command={cmd} inspectUrl={extractInspectUrl(cmd)} />
                  ))}
                </div>
              )}

              {isError && (
                <div className="pl-14 pt-1.5 pb-1 space-y-1">
                  {errorLog && (
                    <>
                      <button
                        type="button"
                        onClick={() => toggleErrorExpanded(agentId)}
                        aria-expanded={isErrorExpanded ?? false}
                        aria-controls={`error-log-${agentId}`}
                        className="inline-flex items-center gap-1 text-2xs text-daintree-text/50 hover:text-daintree-text/80 transition-colors"
                      >
                        {isErrorExpanded ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                        Show error log
                      </button>
                      <pre
                        id={`error-log-${agentId}`}
                        hidden={!isErrorExpanded}
                        className="text-3xs text-status-error/80 bg-daintree-bg border border-daintree-border rounded-[var(--radius-sm)] p-2 max-h-[120px] overflow-y-auto whitespace-pre-wrap font-mono"
                      >
                        {errorLog}
                      </pre>
                    </>
                  )}
                  {currentBlock?.commands && (
                    <div className="space-y-1">
                      <div className="text-2xs text-text-secondary">Or install manually:</div>
                      {currentBlock.commands.map((cmd) => (
                        <CopyableCommand
                          key={cmd}
                          command={cmd}
                          inspectUrl={extractInspectUrl(cmd)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasInstallableAgents && (
        <button
          type="button"
          disabled={isBatchRunning}
          onClick={handleInstallAll}
          className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-[var(--radius-md)] border border-border-strong bg-overlay-subtle text-daintree-text text-sm font-medium hover:bg-overlay-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent disabled:opacity-50 disabled:pointer-events-none"
        >
          {isBatchRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Installing...
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Install all
            </>
          )}
        </button>
      )}

      {!isFirstRun && agentsWithDangerousToggle.length > 0 && (
        <div className="border-t border-daintree-border pt-3 space-y-2">
          <div className="text-xs font-medium text-daintree-text/60">Skip permissions</div>
          <div className="space-y-1.5">
            {agentsWithDangerousToggle.map((agentId) => {
              const config = AGENT_REGISTRY[agentId];
              if (!config) return null;
              const dangerousArg = DEFAULT_DANGEROUS_ARGS[agentId] ?? "";
              // Setup is a simple on/off: "on" force-enables, unchecking returns
              // to "inherit" (defer to the global switch), never the "off" veto.
              const isEnabled = resolveDangerousMode(agentSettings?.[agentId] ?? {}) === "on";
              return (
                <label
                  key={agentId}
                  className="flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 cursor-pointer hover:bg-daintree-bg/60 transition-colors"
                >
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 accent-status-error shrink-0"
                    checked={isEnabled}
                    onChange={() => {
                      void updateAgent(agentId, {
                        dangerousMode: isEnabled ? "inherit" : "on",
                        dangerousEnabled: !isEnabled,
                      });
                    }}
                  />
                  <span className="text-xs text-daintree-text/70">{config.name}</span>
                  {isEnabled && (
                    <code className="text-3xs text-status-error font-mono ml-auto">
                      {dangerousArg}
                    </code>
                  )}
                </label>
              );
            })}
          </div>
          <p className="text-2xs text-daintree-text/30">
            Auto-approve all actions. Use with caution.
          </p>
        </div>
      )}
    </div>
  );
}
