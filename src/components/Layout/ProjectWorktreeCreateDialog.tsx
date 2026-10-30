import { useState } from "react";
import { FolderGit2 } from "lucide-react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { ProjectSurfaceFrame } from "@/components/Plugin/ProjectSurfaceFrame";
import { ProjectSurfaceView } from "@/components/Plugin/ProjectSurfaceView";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";

/**
 * The New worktree dialog a project plugin owns (`contributes.surfaces.worktreeCreate`):
 * its view inside the shared slot frame, which carries the consent question and
 * the saved switch back to stock. "Standard dialog…" sits in the frame's strip,
 * outside the view's box, so the stock dialog is one click away from whatever
 * the plugin draws, and it moves this opening only; the saved answer is the
 * frame's switch.
 *
 * The view cancels or finishes through `hostContext.close()`. It creates the
 * worktree with the ordinary create actions, so branch collisions are resolved
 * where they are for the stock dialog.
 */
export function ProjectWorktreeCreateDialog({
  config,
  isOpen,
  leavingForStock = false,
  onClose,
  onUseStock,
}: {
  config: PanelKindConfig;
  isOpen: boolean;
  /**
   * The slot was switched to stock while this dialog was up — from the frame's
   * switch, the consent notice or anywhere else the answer is saved. It leaves
   * the way "Standard dialog…" does.
   */
  leavingForStock?: boolean;
  onClose: () => void;
  onUseStock: () => void;
}) {
  "use memo";

  // The stock dialog opens once this one has finished closing and handed focus
  // back: opened in the same commit, it would capture the control that is
  // unmounting as its opener, and closing it would land focus nowhere.
  const [leaving, setLeaving] = useState(false);
  const handingOff = leaving || leavingForStock;

  return (
    <AppDialog
      isOpen={isOpen && !handingOff}
      onClose={onClose}
      onCloseComplete={handingOff ? onUseStock : undefined}
      size="4xl"
      data-testid="plugin-worktree-create-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderGit2 className="w-4 h-4 text-text-secondary" />}>
          New worktree
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <div className="h-[min(640px,70vh)] min-h-0">
        <ProjectSurfaceFrame
          slot="worktreeCreate"
          surfaceActions={
            <Button variant="ghost" size="xs" onClick={() => setLeaving(true)}>
              Standard dialog…
            </Button>
          }
        >
          <ProjectSurfaceView config={config} onClose={onClose} />
        </ProjectSurfaceFrame>
      </div>
    </AppDialog>
  );
}
