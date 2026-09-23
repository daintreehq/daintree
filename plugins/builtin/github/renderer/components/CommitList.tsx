import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalCommitsDropdown } from "@/components/Layout/LocalCommitsDropdown";
import { actionService } from "@/services/ActionService";

interface CommitListProps {
  projectPath: string;
  branch?: string;
  onClose?: () => void;
  initialCount?: number;
}

/**
 * GitHub's commits list is the host's commit dropdown plus a way out to
 * GitHub. Commit history is local git data either way, so the two modes of the
 * commits pill share one list — its rows, push marks, keyboard contract and
 * states — rather than drifting as two copies.
 *
 * Mounted only while the dropdown is open: the commits pill does not keep its
 * content mounted, so `open` is always true here.
 */
export function CommitList({ projectPath, branch, onClose, initialCount }: CommitListProps) {
  const handleViewOnGitHub = () => {
    void actionService.dispatch("forge.openCommits", { projectPath, branch }, { source: "user" });
    onClose?.();
  };

  return (
    <LocalCommitsDropdown
      cwd={projectPath}
      branch={branch}
      open
      initialCount={initialCount}
      onClose={onClose}
      footerAction={
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleViewOnGitHub}
          className="h-6 gap-1.5 text-xs"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </Button>
      }
    />
  );
}
