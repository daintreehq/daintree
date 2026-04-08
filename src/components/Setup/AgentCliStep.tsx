import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleDashed, Loader2, RotateCw } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { systemClient } from "@/clients";
import { AGENT_REGISTRY } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import type { PrerequisiteCheckResult, PrerequisiteSpec, CliAvailability } from "@shared/types";
import { EmbeddedTerminal } from "./EmbeddedTerminal";

const POOL_CONCURRENCY = 3;
const AGENT_ORDER = BUILT_IN_AGENT_IDS;

// Build a mapping from agent ID to its prerequisite tool name.
// Most agents use the agent ID as the tool name (e.g., "claude" → "claude"),
// but some differ (e.g., "cursor" → "cursor-agent").
const AGENT_TOOL_NAMES: Record<string, string> = {};
for (const agentId of AGENT_ORDER) {
  const config = AGENT_REGISTRY[agentId];
  const prereq = config?.prerequisites?.[0];
  AGENT_TOOL_NAMES[agentId] = prereq?.tool ?? agentId;
}

const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Deep refactoring, architecture, and complex reasoning",
  gemini: "Quick exploration and broad knowledge lookup",
  codex: "Careful, methodical runs with sandboxed execution",
  opencode: "Provider-agnostic, open-source flexibility",
};

type CheckState = "loading" | PrerequisiteCheckResult;

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const iter = items[Symbol.iterator]();
  async function worker() {
    for (let next = iter.next(); !next.done; next = iter.next()) {
      await fn(next.value);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

interface AgentCliStepProps {
  availability: CliAvailability;
  selections: Record<string, boolean>;
  isLoading: boolean;
  isSaving: boolean;
  onToggle: (agentId: string, checked: boolean) => void;
}

export function AgentCliStep({
  availability,
  selections,
  isLoading,
  isSaving,
  onToggle,
}: AgentCliStepProps) {
  const [specs, setSpecs] = useState<PrerequisiteSpec[]>([]);
  const [checkStates, setCheckStates] = useState<Record<string, CheckState>>({});
  const [isChecking, setIsChecking] = useState(false);
  const activeRef = useRef(true);
  const isCheckingRef = useRef(false);

  const runCheck = useCallback(async () => {
    if (isCheckingRef.current) return;
    isCheckingRef.current = true;
    setIsChecking(true);
    setSpecs([]);
    setCheckStates({});

    try {
      const resolvedSpecs = await systemClient.getHealthCheckSpecs([...AGENT_ORDER]);
      if (!activeRef.current) return;

      const visible = resolvedSpecs.filter((s) => s.severity !== "silent");
      setSpecs(visible);
      setCheckStates(Object.fromEntries(visible.map((s) => [s.tool, "loading" as const])));

      await runPool(visible, POOL_CONCURRENCY, async (spec) => {
        try {
          const result = await systemClient.checkTool(spec);
          if (activeRef.current) {
            setCheckStates((prev) => ({ ...prev, [spec.tool]: result }));
          }
        } catch {
          if (activeRef.current) {
            setCheckStates((prev) => ({
              ...prev,
              [spec.tool]: {
                tool: spec.tool,
                label: spec.label,
                available: false,
                version: null,
                severity: spec.severity,
                meetsMinVersion: false,
                minVersion: spec.minVersion,
                installUrl: spec.installUrl,
                installBlocks: spec.installBlocks,
              },
            }));
          }
        }
      });
    } catch {
      // Agent CLI checks are best-effort; availability polling provides the primary signal
    } finally {
      isCheckingRef.current = false;
      if (activeRef.current) setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void runCheck();
    return () => {
      activeRef.current = false;
    };
  }, [runCheck]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-canopy-text mb-2">Choose your AI agents</h3>
        <p className="text-sm text-canopy-text/60">
          Select the agents you want in your workflow. Already-installed agents are pre-selected.
          You can change this anytime from{" "}
          <span className="text-canopy-text/80">Settings &gt; Agents</span>.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner size="lg" className="text-canopy-text/40" />
        </div>
      ) : (
        <div className="space-y-2">
          {AGENT_ORDER.map((agentId) => {
            const config = AGENT_REGISTRY[agentId];
            if (!config) return null;
            const isInstalled = availability[agentId] === true;
            const isChecked = selections[agentId] ?? false;
            const Icon = config.icon;
            const description = AGENT_DESCRIPTIONS[agentId] ?? config.tooltip ?? "";
            const toolName = AGENT_TOOL_NAMES[agentId] ?? agentId;
            const checkState = checkStates[toolName];
            const checkLoading = checkState === "loading" || (isChecking && !checkState);

            return (
              <label
                key={agentId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30 cursor-pointer hover:bg-canopy-bg/60 transition-colors"
              >
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-canopy-accent shrink-0"
                  checked={isChecked}
                  onChange={(e) => onToggle(agentId, e.target.checked)}
                  disabled={isSaving}
                />
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
                <AgentStatusBadge
                  isInstalled={isInstalled}
                  checkLoading={checkLoading}
                  checkState={checkState}
                />
              </label>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={isChecking}
          className="inline-flex items-center gap-1.5 text-xs text-canopy-text/50 hover:text-canopy-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCw className={`w-3 h-3 ${isChecking ? "animate-spin" : ""}`} />
          {isChecking ? "Checking…" : "Re-check"}
        </button>
      </div>

      <div className="border-t border-canopy-border pt-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-xs font-medium text-canopy-text/60">Terminal</div>
          <div className="text-[11px] text-canopy-text/30">Run installation commands here</div>
        </div>
        <EmbeddedTerminal />
      </div>
    </div>
  );
}

function AgentStatusBadge({
  isInstalled,
  checkLoading,
  checkState,
}: {
  isInstalled: boolean;
  checkLoading: boolean;
  checkState: CheckState | undefined;
}) {
  if (checkLoading) {
    return <Loader2 className="w-3.5 h-3.5 text-canopy-text/30 animate-spin shrink-0" />;
  }

  if (isInstalled) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-status-success font-medium shrink-0">
        <CircleCheck className="w-3 h-3" />
        Installed
      </span>
    );
  }

  const check = checkState && checkState !== "loading" ? checkState : null;
  if (check?.available && check.meetsMinVersion) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-status-success font-medium shrink-0">
        <CircleCheck className="w-3 h-3" />
        Installed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-canopy-text/30 shrink-0">
      <CircleDashed className="w-3 h-3" />
      Not installed
    </span>
  );
}
