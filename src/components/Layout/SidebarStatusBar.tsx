import { ProjectResourceBadge } from "@/components/Project";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { KeepAwakeIndicator } from "./KeepAwakeIndicator";

/**
 * The sidebar's footer row: the running-projects readout on the left, and on
 * the right the one place ambient app-wide statuses go. A status that comes and
 * goes belongs here rather than in the toolbar, where it would shift the buttons
 * beside it. The cluster is pinned right and never shrinks, so at the sidebar's
 * narrowest the readout truncates instead.
 */
export function SidebarStatusBar() {
  const keepAwakeVisible = useKeepAwakeStore((state) => state.visible);

  return <ProjectResourceBadge statusItems={keepAwakeVisible ? <KeepAwakeIndicator /> : null} />;
}
