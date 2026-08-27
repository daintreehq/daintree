import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderOpen } from "@/components/icons";
import { basename } from "@shared/utils/path";
import { PathCaption } from "./projectDialogFields";
import { GitInitDialog } from "./GitInitDialog";
import type { ProjectCreationIdentity } from "@shared/types";

export type NonGitFolderStep = "choice" | "initialize";

interface NonGitFolderDialogProps {
  isOpen: boolean;
  directoryPath: string;
  /** `"initialize"` skips straight to git setup, for the sidebar's upgrade CTA. */
  initialStep: NonGitFolderStep;
  /**
   * Identity chosen one dialog earlier in the create-project flow, forwarded
   * verbatim to git setup. Absent when the folder was opened directly, which is
   * what lets {@link GitInitDialog} derive a suggestion from the folder name.
   */
  initialIdentity?: ProjectCreationIdentity | null;
  onOpenWithoutGit: () => void;
  onInitSuccess: (identity: ProjectCreationIdentity) => void;
  onCancel: () => void;
}

/**
 * What a folder with no repository offers: adopt it as-is, or set git up first.
 *
 * The initialize branch defers entirely to {@link GitInitDialog}, and is mounted
 * only once chosen — its progress subscription and auto-close timer should not
 * be live while the user is still deciding.
 */
export function NonGitFolderDialog({
  isOpen,
  directoryPath,
  initialStep,
  initialIdentity,
  onOpenWithoutGit,
  onInitSuccess,
  onCancel,
}: NonGitFolderDialogProps) {
  const [step, setStep] = useState<NonGitFolderStep>(initialStep);

  // Re-arm on close rather than on open: the dialog animates out while still
  // mounted, and resetting the step on the way in would swap the body back to
  // the choice screen underneath a closing initialize step.
  useEffect(() => {
    if (!isOpen) setStep(initialStep);
  }, [isOpen, initialStep]);

  if (step === "initialize") {
    return (
      <GitInitDialog
        isOpen={isOpen}
        directoryPath={directoryPath}
        initialIdentity={initialIdentity}
        onSuccess={onInitSuccess}
        onCancel={onCancel}
      />
    );
  }

  return (
    <AppDialog isOpen={isOpen} onClose={onCancel} size="md">
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderOpen className="h-5 w-5 text-daintree-text/70" />}>
          {/* A root path ("/", "C:\") has no leaf — name it by the path itself. */}
          Open &lsquo;{basename(directoryPath) || directoryPath}&rsquo;?
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-3">
        <PathCaption path={directoryPath} />
        <p className="text-sm text-daintree-text/70">
          This folder isn&rsquo;t a git repository. Open it as-is and terminals, agents, recipes,
          and the file browser all work — worktrees, review, and diffs stay unavailable until it
          becomes a repository. Nothing in the folder is changed either way.
        </p>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="outline" onClick={() => setStep("initialize")}>
          Initialize repository
        </Button>
        <Button variant="contrast" onClick={onOpenWithoutGit}>
          Open without git
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
