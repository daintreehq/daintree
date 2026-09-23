import { useState } from "react";
import { QuickRun, QuickRunToggle, useQuickRunExpanded } from "@/components/Project/QuickRun";
import { ProjectPluginIndicator } from "@/components/Plugin/ProjectPluginIndicator";
import { SidebarStatusBar } from "./SidebarStatusBar";

/**
 * The sidebar's footer, as one unit: one surface, one top divider, and one
 * 28px row carrying the activity readout on the left and the Run command
 * disclosure on the right. QuickRun's panel opens above that row, on the same
 * surface, so the command input reads as part of the footer rather than a
 * second strip stacked on it.
 *
 * It used to be three full-width strips (Run command, plugins, status), each
 * with its own border and its own leading glyph, which read as accreted rather
 * than designed. The occasional plugin row sits at the top so it never comes
 * between the Run command toggle and the panel it opens.
 *
 * `@container/footer` is what lets the row's labels shorten at the 200px floor
 * without the sidebar having to tell its footer how wide it is.
 */
export function SidebarFooter({ projectId }: { projectId: string | null }) {
  const [runOpen, toggleRun] = useQuickRunExpanded(projectId);
  // Only a panel the user opened in this session takes focus; one restored
  // open from localStorage must not pull focus away from wherever it is.
  const [openedByUser, setOpenedByUser] = useState(false);

  const handleToggle = () => {
    setOpenedByUser(!runOpen);
    toggleRun();
  };

  return (
    <div
      data-sidebar-footer=""
      className="@container/footer flex shrink-0 flex-col border-t border-divider surface-chrome"
    >
      <ProjectPluginIndicator />
      {projectId != null && runOpen && (
        <QuickRun key={projectId} projectId={projectId} focusOnMount={openedByUser} />
      )}
      <SidebarStatusBar
        trailing={
          projectId != null ? <QuickRunToggle expanded={runOpen} onToggle={handleToggle} /> : null
        }
      />
    </div>
  );
}
