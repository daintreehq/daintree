import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { FolderGit2 } from "@/components/icons";
import type { PR } from "@shared/types/forge";

interface PrHeaderProps {
  pr: PR;
}

export function PrHeader({ pr }: PrHeaderProps) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-strong text-sm min-w-0">
      <FolderGit2 className="w-4 h-4 text-daintree-text/60 shrink-0" aria-hidden="true" />
      <TruncatedTooltip content={`PR #${pr.number} — ${pr.title}`}>
        <span className="text-daintree-text/80 min-w-0 truncate">
          PR <span className="font-medium text-daintree-text">#{pr.number}</span>
          <span className="ml-1 text-text-secondary"> {pr.title}</span>
        </span>
      </TruncatedTooltip>
    </div>
  );
}
