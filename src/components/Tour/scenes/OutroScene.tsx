import { Eye, GitBranch, GitCommitHorizontal, LayoutGrid } from "lucide-react";
import { DaintreeIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { reveal } from "../mockup/TourMock";
import { useCue, useTimelineIndex, type TimelinePoint } from "../useTourPlayer";

const WHY = [
  { icon: LayoutGrid, label: "Agents side by side" },
  { icon: GitBranch, label: "A worktree per task" },
  { icon: Eye, label: "See who needs you" },
  { icon: GitCommitHorizontal, label: "Review and ship" },
] as const;

const WHY_STEPS: readonly TimelinePoint[] = WHY.map((_, i) => ({ cue: "why", offset: i * 0.35 }));

/** The close: the mark, the four ideas the tour covered, and where to go next. */
export function OutroScene() {
  const logo = useCue("logo");
  const whyStep = useTimelineIndex(WHY_STEPS);
  const next = useCue("next");

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-surface-canvas">
      <div className={cn("flex flex-col items-center gap-3", reveal(logo, "none"))}>
        <DaintreeIcon className="size-16 text-text-primary" />
        <span className="text-2xl font-semibold tracking-tight text-text-primary">Daintree</span>
      </div>
      <div className="flex items-center gap-2">
        {WHY.map(({ icon: Icon, label }, i) => (
          <span
            key={label}
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border-default bg-surface-panel px-2.5 py-1 text-2xs text-text-primary",
              reveal(i <= whyStep)
            )}
          >
            <Icon className="size-3 text-text-secondary" aria-hidden="true" />
            {label}
          </span>
        ))}
      </div>
      <span className={cn("text-2xs text-text-secondary", reveal(next, "none"))}>
        Next: the Getting Started checklist · Replay any time from Help › Daintree Tour
      </span>
    </div>
  );
}
