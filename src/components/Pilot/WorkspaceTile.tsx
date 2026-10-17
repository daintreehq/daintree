import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { CircleHelp, FileText } from "@/components/icons";
import type { PilotProjectGroup } from "./pilotRows";

/**
 * 16px, down from the switcher's 32px.
 *
 * At half the size the tile stops being an avatar competing with the rows and
 * becomes a coloured bullet in front of a section label, which is what a
 * project heading actually is here. The colour still identifies the project;
 * it just no longer outweighs the agents it organises.
 */
export const TILE_BASE =
  "flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-4xs";

/**
 * The workspace's identity tile, at the switcher's colour and a heading's size.
 *
 * Only a project carries an emoji and a colour. A scratch is an app-managed
 * folder with neither, so the switcher gives it a neutral tile and a glyph —
 * rendering the project tile for one produced an empty coloured square. An
 * unknown workspace is a genuine anomaly (removed while its agents kept
 * running) and is allowed to look like one.
 */
export function WorkspaceTile({
  group,
}: {
  group: Pick<PilotProjectGroup, "kind" | "emoji" | "color">;
}) {
  if (group.kind !== "project") {
    const Glyph = group.kind === "scratch" ? FileText : CircleHelp;
    return (
      <div className={cn(TILE_BASE, "bg-tint/[0.04] text-muted-foreground")}>
        <Glyph className="h-2.5 w-2.5" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div
      className={cn(
        TILE_BASE,
        "shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))]"
      )}
      style={{
        background: group.color
          ? `var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), ${getProjectGradient(group.color)}`
          : "var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), var(--color-surface-sidebar)",
      }}
    >
      {/* The switcher's own stand-in for a project that never picked one. */}
      <span className="leading-none select-none filter drop-shadow-sm">{group.emoji || "🌲"}</span>
    </div>
  );
}
