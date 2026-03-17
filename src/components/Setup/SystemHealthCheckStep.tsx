import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  RotateCw,
} from "lucide-react";
import { systemClient } from "@/clients";
import type { PrerequisiteCheckResult, SystemHealthCheckResult } from "@shared/types";

interface SystemHealthCheckStepProps {
  onSkip: () => void;
  agentIds?: readonly string[];
}

export function SystemHealthCheckStep({ onSkip, agentIds }: SystemHealthCheckStepProps) {
  const [result, setResult] = useState<SystemHealthCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRunRef = useRef(false);

  const runCheck = useCallback(async () => {
    setIsChecking(true);
    setError(null);
    try {
      const data = await systemClient.healthCheck(agentIds ? [...agentIds] : undefined);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Health check failed");
    } finally {
      setIsChecking(false);
    }
  }, [agentIds]);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    void runCheck();
  }, [runCheck]);

  const visibleResults = result?.prerequisites.filter((c) => c.severity !== "silent") ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-canopy-text mb-1">System requirements</h3>
        <p className="text-sm text-canopy-text/60">
          Checking that the tools Canopy needs are installed and available.
        </p>
      </div>

      <div className="space-y-2">
        {result
          ? visibleResults.map((check) => <PrerequisiteRow key={check.tool} check={check} />)
          : Array.from({ length: 4 }, (_, i) => (
              <PrerequisiteRow
                key={i}
                check={{
                  tool: "",
                  label: "",
                  available: false,
                  version: null,
                  severity: "fatal",
                  meetsMinVersion: true,
                }}
                loading={isChecking}
              />
            ))}
      </div>

      {error && (
        <div className="px-3 py-2.5 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/5">
          <p className="text-xs text-status-error">Could not run health check: {error}</p>
        </div>
      )}

      {result && !result.allRequired && (
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

function PrerequisiteRow({
  check,
  loading = false,
}: {
  check: PrerequisiteCheckResult;
  loading?: boolean;
}) {
  const label = check.label || check.tool;
  const versionMismatch = check.available && !check.meetsMinVersion && check.minVersion;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30">
      <StatusIcon check={check} loading={loading} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-canopy-text">{label}</div>
        {check.version && !versionMismatch && (
          <div className="text-[11px] text-canopy-text/40">v{check.version}</div>
        )}
        {versionMismatch && (
          <div className="text-[11px] text-status-warning">
            v{check.version} — requires v{check.minVersion}+
          </div>
        )}
      </div>
      {loading ? (
        <span className="text-[11px] text-canopy-text/30">Checking…</span>
      ) : check.available && check.meetsMinVersion ? (
        <span className="text-[11px] text-status-success font-medium">Found</span>
      ) : (
        check.installUrl && (
          <a
            href={check.installUrl}
            className="inline-flex items-center gap-1 text-[11px] text-canopy-accent hover:underline"
            onClick={(e) => {
              e.preventDefault();
              void systemClient.openExternal(check.installUrl!);
            }}
          >
            <ExternalLink className="w-3 h-3" />
            Install
          </a>
        )
      )}
    </div>
  );
}

function StatusIcon({ check, loading }: { check: PrerequisiteCheckResult; loading: boolean }) {
  if (loading) {
    return <CircleDashed className="w-4 h-4 text-canopy-text/20 animate-pulse shrink-0" />;
  }
  if (check.available && check.meetsMinVersion) {
    return <CircleCheck className="w-4 h-4 text-status-success shrink-0" />;
  }
  if (check.severity === "warn") {
    return <AlertTriangle className="w-4 h-4 text-status-warning shrink-0" />;
  }
  return <CircleX className="w-4 h-4 text-status-error shrink-0" />;
}
