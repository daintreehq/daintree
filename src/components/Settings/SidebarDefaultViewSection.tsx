import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { useSidebarViewOptions } from "@/hooks/useSidebarViews";
import { isProjectSidebarView, resolveActiveSidebarView } from "@/lib/sidebarViews";
import { useSidebarViewStore } from "@/store/sidebarViewStore";

/**
 * Which view this project's sidebar opens on, and the way back to following
 * the highest-priority one. Listed only once there is something to choose
 * between or something remembered.
 */
export function SidebarDefaultViewSection() {
  const options = useSidebarViewOptions();
  const chosen = useSidebarViewStore((s) => s.chosenSidebarView);
  const answered = useSidebarViewStore((s) => Object.keys(s.defaultAnswers).length > 0);
  const resetDefaultView = useSidebarViewStore((s) => s.resetDefaultView);

  const modified = chosen !== null || answered;
  if (options.length <= 1 && !modified) return null;

  const active = resolveActiveSidebarView(options, chosen);
  const pickIsOffered = chosen !== null && options.some((option) => option.id === chosen);
  const title = active.view?.title ?? "Worktrees";
  const origin =
    active.view === null
      ? ""
      : ` from ${active.view.pluginName}${isProjectSidebarView(active.view) ? " (project plugin)" : ""}`;
  const detail = pickIsOffered
    ? "Your pick"
    : chosen !== null
      ? "Your pick isn't available right now"
      : "The highest-priority view available";

  return (
    <div data-testid="project-sidebar-default">
      <SettingsSection title="Sidebar" description="The view this project's sidebar opens on">
        <SettingsGroup>
          <SettingsRow
            label="Default view"
            rootAttributes={{ "data-testid": "project-sidebar-default-row" }}
            description={`${title}${origin}. ${detail}`}
            isModified={modified}
            onReset={resetDefaultView}
            resetAriaLabel="Open on the highest-priority sidebar view"
            resetTestId="project-sidebar-default-reset"
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
