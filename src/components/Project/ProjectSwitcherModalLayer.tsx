import { Suspense, useRef } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks/useProjectSwitcherPalette";
import { LazyProjectSwitcherPalette } from "@/lazyPanels";
import { actionService } from "@/services/ActionService";
import { ProjectSwitcherConfirmHost } from "./ProjectSwitcherConfirmDialogs";

/**
 * What the project switcher puts in a view's modal layer: the ⌘P palette while
 * it is open, and the one host for the confirmations any copy of the switcher
 * raises (#16919). The host is unconditional and eager, because Close is also
 * asked for from the action palette and the toolbar pill with no palette open,
 * and a confirm has to own focus the commit its request lands. It shares the
 * palette's search box as the focus successor for a confirm whose opener row is
 * gone; the toolbar dropdown keeps its own, since it dismisses itself when a
 * confirm opens.
 */
export function ProjectSwitcherModalLayer({
  isProjectSwitcherModalOpen,
  projectSwitcherPalette,
}: {
  isProjectSwitcherModalOpen: boolean;
  projectSwitcherPalette: UseProjectSwitcherPaletteReturn;
}) {
  const projectSwitcherInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <ErrorBoundary
        variant="component"
        componentName="ProjectSwitcherPalette"
        resetKeys={[Number(isProjectSwitcherModalOpen)]}
      >
        {isProjectSwitcherModalOpen && (
          <Suspense fallback={null}>
            <LazyProjectSwitcherPalette
              isOpen={isProjectSwitcherModalOpen}
              query={projectSwitcherPalette.query}
              results={projectSwitcherPalette.results}
              browseBands={projectSwitcherPalette.browseBands}
              selectedIndex={projectSwitcherPalette.selectedIndex}
              cycleRequest={projectSwitcherPalette.cycleRequest}
              onQueryChange={projectSwitcherPalette.setQuery}
              onSelectPrevious={projectSwitcherPalette.selectPrevious}
              onSelectNext={projectSwitcherPalette.selectNext}
              onSelect={projectSwitcherPalette.selectRow}
              onHoverProject={projectSwitcherPalette.onHoverProject}
              onHoverProjectEnd={projectSwitcherPalette.onHoverProjectEnd}
              onHoverRow={projectSwitcherPalette.hoverRow}
              fleetLiveness={projectSwitcherPalette.fleetLiveness}
              onClose={projectSwitcherPalette.close}
              onStopProject={(projectId) => void projectSwitcherPalette.stopProject(projectId)}
              onCloseProject={(projectId) => void projectSwitcherPalette.removeProject(projectId)}
              onSleepProject={(projectId) => void projectSwitcherPalette.sleepProject(projectId)}
              onRestartProject={(projectId) => projectSwitcherPalette.restartProject(projectId)}
              onLocateProject={(projectId) => {
                projectSwitcherPalette.locateProject(projectId);
              }}
              onMoveOrRenameProject={(projectId) => {
                projectSwitcherPalette.moveOrRenameProject(projectId);
              }}
              onTogglePinProject={(projectId) =>
                void projectSwitcherPalette.togglePinProject(projectId)
              }
              onCopyPath={projectSwitcherPalette.copyPath}
              onSelectNewWindow={(project) => {
                projectSwitcherPalette.close();
                void actionService.dispatch(
                  "app.newWindow",
                  { projectPath: project.path },
                  { source: "user" }
                );
              }}
              rankedSearch={projectSwitcherPalette.isRankedSearch}
              scratchResults={projectSwitcherPalette.scratchResults}
              onCreateScratch={(name) => void projectSwitcherPalette.createScratch(name)}
              onSelectScratch={(scratch) => void projectSwitcherPalette.selectScratch(scratch)}
              onRequestDeleteScratch={projectSwitcherPalette.requestDeleteScratch}
              onRequestDeleteAllScratches={projectSwitcherPalette.requestDeleteAllScratches}
              onRenameScratch={(scratchId, name) =>
                void projectSwitcherPalette.renameScratch(scratchId, name)
              }
              onSaveAsProject={(scratchId) => void projectSwitcherPalette.saveAsProject(scratchId)}
              paletteInputRef={projectSwitcherInputRef}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary variant="component" componentName="ProjectSwitcherConfirmDialogs">
        <ProjectSwitcherConfirmHost
          projectSwitcher={projectSwitcherPalette}
          paletteInputRef={projectSwitcherInputRef}
        />
      </ErrorBoundary>
    </>
  );
}
