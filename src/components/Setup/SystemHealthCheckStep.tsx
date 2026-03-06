import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleDashed, CircleX, ExternalLink, RotateCw } from "lucide-react";
import { systemClient } from "@/clients";
import type { PrerequisiteCheckResult, SystemHealthCheckResult } from "@shared/types";

interface SystemHealthCheckStepProps {
  onSkip: () => void;
}

const INSTALL_LINKS: Record<string, { label: string; url: string }> = {
  git: { label: "Install Git", url: "https://git-scm.com/downloads" },
  node: { label: "Install Node.js", url: "https://nodejs.org" },
  npm: {
    label: "Install npm",
    url: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
  },
};

const TOOL_LABELS: Record<string, string> = {
  git: "Git",
  node: "Node.js",
  npm: "npm",
};

export function SystemHealthCheckStep({ onSkip }: SystemHealthCheckStepProps) {
  const [result, setResult] = useState<SystemHealthCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRunRef = useRef(false);

  const runCheck = async () => {
    setIsChecking(true);
    setError(null);
    try {
      const data = await systemClient.healthCheck();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Health check failed");
    } finally {
      setIsChecking(false);
    }
  };

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    void runCheck();
  }, []);

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
          ? result.prerequisites.map((check) => <PrerequisiteRow key={check.tool} check={check} />)
          : ["git", "node", "npm"].map((tool) => (
              <PrerequisiteRow
                key={tool}
                check={{ tool, available: false, version: null }}
                loading={isChecking}
              />
            ))}
      </div>

      {error && (
        <div className="px-3 py-2.5 rounded-[var(--radius-md)] border border-[var(--color-status-error)]/20 bg-[var(--color-status-error)]/5">
          <p className="text-xs text-[var(--color-status-error)]">
            Could not run health check: {error}
          </p>
        </div>
      )}

      {result && !result.allRequired && (
        <div className="px-3 py-2.5 rounded-[var(--radius-md)] border border-status-warning/20 bg-status-warning/5">
          <p className="text-xs text-status-warning">
            Some required tools are missing. Canopy may not work correctly without them. You can
            still continue and install them later.
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
  const label = TOOL_LABELS[check.tool] ?? check.tool;
  const link = INSTALL_LINKS[check.tool];

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30">
      <StatusIcon available={check.available} loading={loading} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-canopy-text">{label}</div>
        {check.version && <div className="text-[11px] text-canopy-text/40">v{check.version}</div>}
      </div>
      {loading ? (
        <span className="text-[11px] text-canopy-text/30">Checking…</span>
      ) : check.available ? (
        <span className="text-[11px] text-status-success font-medium">Found</span>
      ) : (
        link && (
          <a
            href={link.url}
            className="inline-flex items-center gap-1 text-[11px] text-canopy-accent hover:underline"
            onClick={(e) => {
              e.preventDefault();
              void systemClient.openExternal(link.url);
            }}
          >
            <ExternalLink className="w-3 h-3" />
            {link.label}
          </a>
        )
      )}
    </div>
  );
}

function StatusIcon({ available, loading }: { available: boolean; loading: boolean }) {
  if (loading) {
    return <CircleDashed className="w-4 h-4 text-canopy-text/20 animate-pulse shrink-0" />;
  }
  if (available) {
    return <CircleCheck className="w-4 h-4 text-status-success shrink-0" />;
  }
  return <CircleX className="w-4 h-4 text-[var(--color-status-error)] shrink-0" />;
}
