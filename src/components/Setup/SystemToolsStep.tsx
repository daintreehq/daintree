import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  ExternalLink,
  Loader2,
  RotateCw,
} from "lucide-react";
import { systemClient } from "@/clients";
import type { PrerequisiteCheckResult, PrerequisiteSpec } from "@shared/types";
import type { AgentInstallBlock } from "@shared/config/agentRegistry";
import { detectOS } from "@/lib/agentInstall";
import { InstallBlock } from "./InstallBlock";

const POOL_CONCURRENCY = 3;

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

interface SystemToolsStepProps {
  onSkip: () => void;
}

export function SystemToolsStep({ onSkip }: SystemToolsStepProps) {
  const [specs, setSpecs] = useState<PrerequisiteSpec[]>([]);
  const [checkStates, setCheckStates] = useState<Record<string, CheckState>>({});
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const isCheckingRef = useRef(false);

  const runCheck = useCallback(async () => {
    if (isCheckingRef.current) return;
    isCheckingRef.current = true;
    setIsChecking(true);
    setError(null);
    setSpecs([]);
    setCheckStates({});

    try {
      const resolvedSpecs = await systemClient.getHealthCheckSpecs();
      if (!activeRef.current) return;

      setSpecs(resolvedSpecs);
      setCheckStates(Object.fromEntries(resolvedSpecs.map((s) => [s.tool, "loading" as const])));

      await runPool(resolvedSpecs, POOL_CONCURRENCY, async (spec) => {
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
    } catch (err) {
      if (activeRef.current) setError(err instanceof Error ? err.message : "Health check failed");
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

  const visibleSpecs = specs.filter((s) => s.severity !== "silent");

  const allDone =
    visibleSpecs.length > 0 && visibleSpecs.every((s) => checkStates[s.tool] !== "loading");
  const allRequired = allDone
    ? visibleSpecs
        .filter((s) => s.severity === "fatal")
        .every((s) => {
          const state = checkStates[s.tool];
          return state !== "loading" && state?.available && state.meetsMinVersion;
        })
    : true;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-canopy-text mb-1">System requirements</h3>
        <p className="text-sm text-canopy-text/60">
          Checking that the tools Canopy needs are installed and available.
        </p>
      </div>

      {visibleSpecs.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {visibleSpecs.map((spec) => (
            <PrerequisiteCard
              key={spec.tool}
              spec={spec}
              state={checkStates[spec.tool] ?? "loading"}
            />
          ))}
        </div>
      )}

      {specs.length === 0 && isChecking && (
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              className="rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30 px-3 py-2.5 animate-pulse h-[52px]"
            />
          ))}
        </div>
      )}

      {error && (
        <div className="px-3 py-2.5 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/5">
          <p className="text-xs text-status-error">Could not run health check: {error}</p>
        </div>
      )}

      {allDone && !allRequired && (
        <div className="px-3 py-2.5 rounded-[var(--radius-md)] border border-status-warning/20 bg-status-warning/5">
          <p className="text-xs text-status-warning">
            Some required tools are missing or outdated. Agents that depend on them may not work
            correctly. You can still continue and install them later.
          </p>
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
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-canopy-text/40 hover:text-canopy-text transition-colors"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function getInstallBlocksForOS(check: PrerequisiteCheckResult): AgentInstallBlock[] | null {
  if (!check.installBlocks) return null;
  const currentOS = detectOS();
  const blocks = check.installBlocks[currentOS];
  if (blocks && blocks.length > 0) return blocks;
  const genericBlocks = check.installBlocks.generic;
  if (genericBlocks && genericBlocks.length > 0) return genericBlocks;
  return null;
}

function PrerequisiteCard({ spec, state }: { spec: PrerequisiteSpec; state: CheckState }) {
  const loading = state === "loading";
  const check: PrerequisiteCheckResult | null = loading ? null : state;
  const needsInstall = check && (!check.available || !check.meetsMinVersion);
  const installBlocks = needsInstall ? getInstallBlocksForOS(check) : null;
  const [expanded, setExpanded] = useState(false);
  const label = spec.label || spec.tool;
  const versionMismatch = check?.available && !check.meetsMinVersion && check.minVersion;

  return (
    <div className="rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <StatusIcon check={check} loading={loading} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-canopy-text truncate">{label}</div>
        </div>
        {loading ? (
          <span className="text-[11px] text-canopy-text/30 shrink-0">Checking…</span>
        ) : needsInstall ? (
          <div className="flex items-center gap-2 shrink-0">
            {versionMismatch && (
              <span
                className="text-[11px] text-status-warning whitespace-nowrap"
                title={`${check.version ? `v${check.version}` : "unknown"} — requires v${check.minVersion}+`}
              >
                needs v{check.minVersion}+
              </span>
            )}
            {installBlocks && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] text-canopy-accent hover:underline"
              >
                {expanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                How to install
              </button>
            )}
            {check.installUrl && (
              <a
                href={check.installUrl}
                className="inline-flex items-center gap-1 text-[11px] text-canopy-text/40 hover:text-canopy-text"
                onClick={(e) => {
                  e.preventDefault();
                  void systemClient.openExternal(check.installUrl!);
                }}
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        ) : check?.version ? (
          <span className="text-[11px] text-canopy-text/40 shrink-0">v{check.version}</span>
        ) : check?.available ? (
          <span className="text-[11px] text-canopy-text/40 shrink-0">Installed</span>
        ) : null}
      </div>
      {expanded && installBlocks && (
        <div className="px-3 pb-3 space-y-2">
          {installBlocks.map((block, i) => (
            <InstallBlock key={i} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusIcon({
  check,
  loading,
}: {
  check: PrerequisiteCheckResult | null;
  loading: boolean;
}) {
  if (loading) {
    return <Loader2 className="w-4 h-4 text-canopy-text/30 animate-spin shrink-0" />;
  }
  if (check?.available && check.meetsMinVersion) {
    return <CircleCheck className="w-4 h-4 text-status-success shrink-0" />;
  }
  if (check?.severity === "warn") {
    return <AlertTriangle className="w-4 h-4 text-status-warning shrink-0" />;
  }
  return <CircleX className="w-4 h-4 text-status-error shrink-0" />;
}
