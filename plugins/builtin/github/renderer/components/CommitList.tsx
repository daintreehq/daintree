import { Button } from "@daintreehq/plugin-ui";
import { LocalCommitsDropdown } from "@/components/Layout/LocalCommitsDropdown";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";

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
    // dispatch() resolves `{ ok: false }` rather than throwing, so an unchecked
    // result is a button that closes the panel and silently does nothing — the
    // same recovery the issue and pull request footers give.
    const open = () => {
      void actionService
        .dispatch("forge.openCommits", { projectPath, branch }, { source: "user" })
        .then((result) => {
          if (!result.ok) {
            notify({
              type: "error",
              title: "Couldn't open GitHub",
              message:
                "The commits page couldn't be opened in your browser. Check that this project has a GitHub remote, then try again.",
              action: { label: "Try again", variant: "primary", onClick: open },
            });
          }
        });
    };
    open();
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
          icon="external-link"
        >
          View on GitHub
        </Button>
      }
    />
  );
}
