import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { usePanelStore } from "@/store/panelStore";
import { useProjectHomeStore, type ProjectMainAreaRoute } from "@/store/projectHomeStore";

const ROUTE_OPTIONS: { value: ProjectMainAreaRoute; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "split", label: "Split" },
  { value: "grid", label: "Grid" },
];

/**
 * The host's way between a project's Home, Home beside its grid, and the grid
 * alone, drawn only while a project plugin's Home can show. Main-area chrome
 * rather than a toolbar or sidebar entry: it stays reachable with the sidebar
 * collapsed, and it sits where the switch it makes happens.
 *
 * Mounted above all three, so switching keeps this control (and the keyboard
 * on it) where it was. Whose Home it is, and the way to have none, is the
 * slot's own switch in `ProjectSurfaceFrame`, below the view — going to the
 * grid here never answers that question.
 */
export function ProjectHomeNav({ route }: { route: ProjectMainAreaRoute }) {
  const showHome = useProjectHomeStore((s) => s.showHome);
  const showSplit = useProjectHomeStore((s) => s.showSplit);
  const showGrid = useProjectHomeStore((s) => s.showGrid);
  const exitMaximize = usePanelStore((s) => s.exitMaximize);

  const choose = (next: ProjectMainAreaRoute) => {
    if (next === "home") {
      // Home alone yields to a maximize, which a split had confined to the
      // panels' side; leave it and Home would vanish under the cell.
      exitMaximize();
      showHome();
    } else if (next === "split") {
      showSplit();
    } else {
      showGrid();
    }
  };

  return (
    <SurfaceHeader density="compact" className="gap-3 px-2" data-testid="project-home-nav">
      <SegmentedRadioGroup
        density="compact"
        aria-label="Main area"
        options={ROUTE_OPTIONS}
        value={route}
        onChange={choose}
      />
    </SurfaceHeader>
  );
}
