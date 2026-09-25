import type { ComponentType } from "react";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { DAINTREE_MOCK_KIT } from "./daintreeMockKit";
import { DAINTREE_TOUR_SUMMARY } from "./daintreeTourSummary";
import type { TourDefinition } from "./tourDefinition";
import { TOUR_CHAPTERS } from "./tourChapters";
import { resolveTourTimings } from "./tourTiming";
import { AgentsScene } from "./scenes/AgentsScene";
import { AssistantScene } from "./scenes/AssistantScene";
import { ContextScene } from "./scenes/ContextScene";
import { FilesScene } from "./scenes/FilesScene";
import { FleetScene } from "./scenes/FleetScene";
import { GitHubScene } from "./scenes/GitHubScene";
import { OutroScene } from "./scenes/OutroScene";
import { PaletteScene } from "./scenes/PaletteScene";
import { PilotScene } from "./scenes/PilotScene";
import { PreviewScene } from "./scenes/PreviewScene";
import { ReviewScene } from "./scenes/ReviewScene";
import { StateScene } from "./scenes/StateScene";
import { WelcomeScene } from "./scenes/WelcomeScene";
import { WorktreesScene } from "./scenes/WorktreesScene";

export const DAINTREE_TOUR_SCENES: Record<string, ComponentType> = {
  welcome: WelcomeScene,
  worktrees: WorktreesScene,
  agents: AgentsScene,
  state: StateScene,
  fleet: FleetScene,
  files: FilesScene,
  context: ContextScene,
  preview: PreviewScene,
  github: GitHubScene,
  review: ReviewScene,
  pilot: PilotScene,
  assistant: AssistantScene,
  palette: PaletteScene,
  outro: OutroScene,
};

function DaintreeTourIcon({ className }: { className?: string }) {
  return <DaintreeIcon size={20} className={className} />;
}

/**
 * The Daintree Tour: short narrated chapters, each a minimal animated mockup
 * of one idea.
 */
export const DAINTREE_TOUR: TourDefinition = {
  id: DAINTREE_TOUR_SUMMARY.id,
  title: DAINTREE_TOUR_SUMMARY.title,
  icon: DaintreeTourIcon,
  chapters: TOUR_CHAPTERS.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    scene: DAINTREE_TOUR_SCENES[chapter.id]!,
  })),
  resolveTimings: (keyboard) => resolveTourTimings(keyboard),
  mockKit: DAINTREE_MOCK_KIT,
  // The tour teaches the map; the checklist walks the first real task.
  finish: {
    hint: "Finish opens the Getting Started checklist to run your first agents",
    run: () => window.dispatchEvent(new CustomEvent("daintree:show-getting-started")),
  },
};
