import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { useProjectHomeStore, type ProjectMainAreaRoute } from "@/store/projectHomeStore";

const ROUTE_OPTIONS: { value: ProjectMainAreaRoute; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "grid", label: "Grid" },
];

/**
 * The host's way between a project's Home and its grid, drawn only while a
 * project plugin's Home can show. Main-area chrome rather than a toolbar or
 * sidebar entry: it stays reachable with the sidebar collapsed, and it sits
 * where the switch it makes happens.
 *
 * Mounted above both places, so switching keeps this control (and the keyboard
 * on it) where it was. Whose Home it is, and the way to have none, is the
 * slot's own switch in `ProjectSurfaceFrame`, below the view — going to the
 * grid here never answers that question.
 */
export function ProjectHomeNav({ route }: { route: ProjectMainAreaRoute }) {
  const showHome = useProjectHomeStore((s) => s.showHome);
  const showGrid = useProjectHomeStore((s) => s.showGrid);

  return (
    <SurfaceHeader density="compact" className="gap-3 px-2" data-testid="project-home-nav">
      <SegmentedRadioGroup
        density="compact"
        aria-label="Main area"
        options={ROUTE_OPTIONS}
        value={route}
        onChange={(next) => (next === "home" ? showHome() : showGrid())}
      />
    </SurfaceHeader>
  );
}
