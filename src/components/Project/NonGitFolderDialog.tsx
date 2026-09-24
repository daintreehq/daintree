import { useEffect, useId, useState } from "react";
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
  const openConsequenceId = useId();
  const initConsequenceId = useId();

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
    <AppDialog
      isOpen={isOpen}
      onClose={onCancel}
      size="md"
      // Arrive on the answer that writes nothing, so a reflexive Enter opens the
      // folder rather than dismissing the dialog from the header's close button.
      initialFocus="confirm"
      data-testid="non-git-folder-dialog"
    >
      <AppDialog.Header className="py-3">
        <AppDialog.Title icon={<FolderOpen className="h-4 w-4 text-text-secondary" />}>
          {/* A root path ("/", "C:\") has no leaf — name it by the path itself. */}
          Open &lsquo;{basename(directoryPath) || directoryPath}&rsquo;?
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-5">
        <div className="space-y-1.5">
          <PathCaption path={directoryPath} />
          <AppDialog.Description>This folder isn&rsquo;t a git repository.</AppDialog.Description>
        </div>

        {/* Each answer carries its own cost, labelled with the button that
            chooses it and attached to that button as its description, so the
            consequence is read — or announced — at the moment of choice. */}
        <dl className="space-y-3 text-sm">
          <div className="space-y-0.5">
            <dt className="font-medium text-text-primary">Open without git</dt>
            <dd id={openConsequenceId} className="text-text-secondary">
              Opening won&rsquo;t change anything in this folder. Terminals, agents, recipes, and
              the file browser work; worktrees, review, and diffs need git.
            </dd>
          </div>
          <div className="space-y-0.5">
            <dt className="font-medium text-text-primary">Initialize repository</dt>
            <dd id={initConsequenceId} className="text-text-secondary">
              Preview the repository setup next. Nothing changes until you confirm.
            </dd>
          </div>
        </dl>
      </AppDialog.Body>

      <AppDialog.Footer>
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onCancel} data-confirm-role="cancel">
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStep("initialize")}
            aria-describedby={initConsequenceId}
          >
            Initialize repository
          </Button>
          <Button
            variant="contrast"
            size="sm"
            onClick={onOpenWithoutGit}
            aria-describedby={openConsequenceId}
            data-confirm-role="confirm"
          >
            Open without git
          </Button>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
