import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { systemClient } from "@/clients";
import type { PrerequisiteCheckResult, PrerequisiteSpec } from "@shared/types";
import type { AgentInstallBlock } from "@shared/config/agentRegistry";
import { detectOS } from "@/lib/agentInstall";
import { InstallBlock } from "./InstallBlock";
import type { CheckState } from "./useSystemHealthCheck";

function getInstallBlocksForOS(check: PrerequisiteCheckResult): AgentInstallBlock[] | null {
  if (!check.installBlocks) return null;
  const currentOS = detectOS();
  const blocks = check.installBlocks[currentOS];
  if (blocks && blocks.length > 0) return blocks;
  const genericBlocks = check.installBlocks.generic;
  if (genericBlocks && genericBlocks.length > 0) return genericBlocks;
  return null;
}

export function PrerequisiteCard({ spec, state }: { spec: PrerequisiteSpec; state: CheckState }) {
  const loading = state === "loading";
  const check: PrerequisiteCheckResult | null = loading ? null : state;
  const needsInstall = check && (!check.available || !check.meetsMinVersion);
  const installBlocks = needsInstall ? getInstallBlocksForOS(check) : null;
  const [expanded, setExpanded] = useState(false);
  const label = spec.label || spec.tool;
  const versionMismatch = check?.available && !check.meetsMinVersion && check.minVersion;

  return (
    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <StatusIcon check={check} loading={loading} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-daintree-text truncate">{label}</div>
        </div>
        {loading ? (
          <span className="text-[11px] text-daintree-text/30 shrink-0">Checking…</span>
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
                className="inline-flex items-center gap-1 text-[11px] text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline"
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
                className="inline-flex items-center gap-1 text-[11px] text-daintree-text/40 hover:text-daintree-text"
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
          <span className="text-[11px] text-daintree-text/40 shrink-0">v{check.version}</span>
        ) : check?.available ? (
          <span className="text-[11px] text-daintree-text/40 shrink-0">Installed</span>
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

export function StatusIcon({
  check,
  loading,
}: {
  check: PrerequisiteCheckResult | null;
  loading: boolean;
}) {
  if (loading) {
    return <Loader2 className="w-4 h-4 text-daintree-text/30 animate-spin shrink-0" />;
  }
  if (check?.available && check.meetsMinVersion) {
    return <CircleCheck className="w-4 h-4 text-status-success shrink-0" />;
  }
  if (check?.severity === "warn") {
    return <AlertTriangle className="w-4 h-4 text-status-warning shrink-0" />;
  }
  return <CircleX className="w-4 h-4 text-status-error shrink-0" />;
}
