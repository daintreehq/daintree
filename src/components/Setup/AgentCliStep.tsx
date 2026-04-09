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
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { getInstallBlocksForCurrentOS, isBlockExecutable } from "@/lib/agentInstall";
import { systemClient } from "@/clients";
import { CopyableCommand } from "./InstallBlock";
import { AGENT_DESCRIPTIONS } from "./AgentSetupWizard";
import type { CliAvailability } from "@shared/types";
import { isAgentInstalled } from "@shared/utils/agentAvailability";

const AGENT_ORDER = BUILT_IN_AGENT_IDS;

type CardStatus = "idle" | "installing" | "installed" | "error" | "manual";

interface AgentCliStepProps {
  availability: CliAvailability;
  selections: Record<string, boolean>;
  onInstallComplete?: () => void;
}

export function AgentCliStep({ availability, selections, onInstallComplete }: AgentCliStepProps) {
  const [cardStatuses, setCardStatuses] = useState<Record<string, CardStatus>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [expandedErrors, setExpandedErrors] = useState<Record<string, boolean>>({});
  const [selectedMethodIndex, setSelectedMethodIndex] = useState<Record<string, number>>({});
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const mountedRef = useRef(true);
  const installingRef = useRef(new Set<string>());
  const cardStatusesRef = useRef(cardStatuses);
  cardStatusesRef.current = cardStatuses;

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
        const block = blocks[methodIdx] ?? blocks[0];

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
      const block = blocks[methodIdx] ?? blocks[0];
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
          [agentId]: err instanceof Error ? err.message : "Installation failed",
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-canopy-text mb-1">Install agents</h3>
          <p className="text-sm text-canopy-text/60">
            Install agents individually or use the batch button below.
          </p>
        </div>
      </div>

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
                    ? "bg-canopy-accent/5 border-canopy-accent/30"
                    : isInstalled
                      ? "bg-status-success/5 border-status-success/20"
                      : isError
                        ? "bg-status-error/5 border-status-error/20"
                        : "bg-canopy-bg/30 border-canopy-border"
                }`}
              >
                <div
                  className="w-8 h-8 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
                  style={{ backgroundColor: `${config.color}15` }}
                >
                  <Icon size={18} brandColor={config.color} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-canopy-text">{config.name}</div>
                  {description && (
                    <div className="text-[11px] text-canopy-text/40 truncate">{description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {config.install?.docsUrl && (
                    <span
                      role="link"
                      tabIndex={0}
                      className="text-canopy-text/30 hover:text-canopy-accent transition-colors p-0.5 cursor-pointer"
                      onClick={() => systemClient.openExternal(config.install!.docsUrl!)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          systemClient.openExternal(config.install!.docsUrl!);
                      }}
                      title="View documentation"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </span>
                  )}
                  {isInstalled ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-status-success font-medium">
                      <CircleCheck className="w-3 h-3" />
                      Installed
                    </span>
                  ) : isInstalling ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-canopy-accent font-medium">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Installing
                    </span>
                  ) : isError ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-status-error font-medium">
                      <AlertCircle className="w-3 h-3" />
                      Failed
                    </span>
                  ) : isManual ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-canopy-text/40">
                      Manual
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-canopy-text/30">
                      <CircleDashed className="w-3 h-3" />
                      Not installed
                    </span>
                  )}
                  {canInstall && !isBatchRunning && (
                    <button
                      type="button"
                      onClick={() => handleInstall(agentId)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-canopy-accent hover:bg-canopy-accent/10 transition-colors"
                    >
                      <Download className="w-3 h-3" />
                      Install
                    </button>
                  )}
                </div>
              </div>

              {hasMultipleMethods && !isInstalled && (
                <div className="flex items-center gap-1 pl-14 pt-1 pb-0.5">
                  <span className="text-[10px] text-canopy-text/30 mr-1">via</span>
                  {blocks.map((block, idx) => (
                    <button
                      key={idx}
                      type="button"
                      disabled={isInstalling || isBatchRunning}
                      onClick={() => handleMethodChange(agentId, idx)}
                      data-selected={idx === currentMethodIdx || undefined}
                      className="px-1.5 py-0.5 rounded text-[10px] text-canopy-text/50 transition-colors hover:text-canopy-text/80 data-[selected]:bg-canopy-accent/15 data-[selected]:text-canopy-accent disabled:opacity-50"
                    >
                      {block.label ?? `Method ${idx + 1}`}
                    </button>
                  ))}
                </div>
              )}

              {isManual && currentBlock?.commands && (
                <div className="pl-14 pt-1.5 pb-1 space-y-1">
                  <div className="text-[11px] text-canopy-text/40 mb-1">
                    Run this command in your terminal. It will be detected automatically.
                  </div>
                  {currentBlock.commands.map((cmd, i) => (
                    <CopyableCommand key={i} command={cmd} />
                  ))}
                </div>
              )}

              {isError && (
                <div className="pl-14 pt-1.5 pb-1 space-y-1">
                  {errorLog && (
                    <button
                      type="button"
                      onClick={() => toggleErrorExpanded(agentId)}
                      className="inline-flex items-center gap-1 text-[11px] text-canopy-text/50 hover:text-canopy-text/80 transition-colors"
                    >
                      {isErrorExpanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                      Show error log
                    </button>
                  )}
                  {isErrorExpanded && errorLog && (
                    <pre className="text-[10px] text-status-error/80 bg-canopy-bg border border-canopy-border rounded-[var(--radius-sm)] p-2 max-h-[120px] overflow-y-auto whitespace-pre-wrap font-mono">
                      {errorLog}
                    </pre>
                  )}
                  {currentBlock?.commands && (
                    <div className="space-y-1">
                      <div className="text-[11px] text-canopy-text/40">Or install manually:</div>
                      {currentBlock.commands.map((cmd, i) => (
                        <CopyableCommand key={i} command={cmd} />
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
          className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-[var(--radius-md)] bg-canopy-accent text-text-inverse text-sm font-medium hover:bg-canopy-accent/90 transition-colors disabled:opacity-50"
        >
          {isBatchRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Installing...
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Install All
            </>
          )}
        </button>
      )}
    </div>
  );
}
