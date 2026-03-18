import type { ReactNode } from "react";
import type { ProjectPulse } from "@shared/types";
import {
  GitCommit,
  Calendar,
  GitBranch,
  ArrowUp,
  ArrowDown,
  FileCode,
  FilePenLine,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PulseSummaryProps {
  pulse: ProjectPulse;
  compact?: boolean;
}

interface StatProps {
  icon: ReactNode;
  value: number | string;
  label: string;
  highlight?: boolean;
  className?: string;
}

function Stat({ icon, value, label, highlight, className }: StatProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs",
        highlight ? "text-canopy-text" : "text-canopy-text/75",
        className
      )}
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="font-mono font-medium">{value}</span>
      <span className="hidden sm:inline text-canopy-text/55">{label}</span>
    </div>
  );
}

export function PulseSummary({ pulse, compact = false }: PulseSummaryProps) {
  const hasDelta =
    pulse.deltaToMain && (pulse.deltaToMain.ahead > 0 || pulse.deltaToMain.behind > 0);
  const hasUncommitted = pulse.uncommitted && pulse.uncommitted.changedFiles > 0;

  if (compact) {
    return (
      <div className="flex items-center gap-3 text-xs text-canopy-text/75" data-testid="pulse-summary">
        <Stat
          icon={<GitCommit className="w-3 h-3" />}
          value={pulse.commitsInRange}
          label="commits"
        />
        <Stat
          icon={<Calendar className="w-3 h-3" />}
          value={`${pulse.activeDays}/${pulse.projectAgeDays}`}
          label="days"
        />
        {hasUncommitted && (
          <Stat
            icon={<FilePenLine className="w-3 h-3 text-status-info" />}
            value={pulse.uncommitted!.changedFiles}
            label="files"
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="pulse-summary">
      <div className="flex items-center gap-4 flex-wrap">
        <Stat
          icon={<GitCommit className="w-3.5 h-3.5" />}
          value={pulse.commitsInRange}
          label={`commit${pulse.commitsInRange !== 1 ? "s" : ""}`}
          highlight
        />
        <Stat
          icon={<Calendar className="w-3.5 h-3.5" />}
          value={`${pulse.activeDays}/${pulse.projectAgeDays}`}
          label="active days"
        />
        {hasUncommitted && (
          <Stat
            icon={<FilePenLine className="w-3.5 h-3.5 text-status-info" />}
            value={`${pulse.uncommitted!.changedFiles} files`}
            label={`+${pulse.uncommitted!.insertions ?? 0}/-${pulse.uncommitted!.deletions ?? 0}`}
          />
        )}
      </div>

      {hasDelta && (
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1 text-canopy-text/70">
            <GitBranch className="w-3 h-3" />
            <span className="font-mono text-canopy-text/55">
              vs {pulse.deltaToMain!.baseBranch}
            </span>
          </div>

          {pulse.deltaToMain!.ahead > 0 && (
            <div className="flex items-center gap-0.5 text-status-success">
              <ArrowUp className="w-3 h-3" />
              <span className="font-mono">{pulse.deltaToMain!.ahead}</span>
            </div>
          )}

          {pulse.deltaToMain!.behind > 0 && (
            <div className="flex items-center gap-0.5 text-status-warning">
              <ArrowDown className="w-3 h-3" />
              <span className="font-mono">{pulse.deltaToMain!.behind}</span>
            </div>
          )}

          {pulse.deltaToMain!.filesChanged !== undefined && pulse.deltaToMain!.filesChanged > 0 && (
            <div className="flex items-center gap-0.5 text-canopy-text/70">
              <FileCode className="w-3 h-3" />
              <span className="font-mono">{pulse.deltaToMain!.filesChanged}</span>
              <span className="text-canopy-text/55">files</span>
            </div>
          )}

          {(pulse.deltaToMain!.insertions ?? 0) > 0 && (
            <span className="font-mono text-status-success/80">
              +{pulse.deltaToMain!.insertions}
            </span>
          )}
          {(pulse.deltaToMain!.deletions ?? 0) > 0 && (
            <span className="font-mono text-status-error/80">-{pulse.deltaToMain!.deletions}</span>
          )}
        </div>
      )}
    </div>
  );
}
