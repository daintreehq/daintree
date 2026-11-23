import type { ComponentType } from "react";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { DAINTREE_MOCK_KIT } from "./daintreeMockKit";
import { DAINTREE_TOUR_SUMMARY, DAINTREE_TOUR_VERSION } from "./daintreeTourSummary";
import type { TourDefinition } from "./tourDefinition";
import { TOUR_CHAPTERS } from "./tourChapters";
import { currentTourPlatform, playableChapters } from "./tourPlatform";
import { resolveTourTimings } from "./tourTiming";
import { AgentsScene } from "./scenes/AgentsScene";
import { AssistantScene } from "./scenes/AssistantScene";
import { CanopyScene } from "./scenes/CanopyScene";
import { DecisionsScene } from "./scenes/DecisionsScene";
import { FilesScene } from "./scenes/FilesScene";
import { FleetScene } from "./scenes/FleetScene";
import { GitHubScene } from "./scenes/GitHubScene";
import { HostsScene } from "./scenes/HostsScene";
import { OutroScene } from "./scenes/OutroScene";
import { PaletteScene } from "./scenes/PaletteScene";
import { PilotScene } from "./scenes/PilotScene";
import { PreviewScene } from "./scenes/PreviewScene";
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
  preview: PreviewScene,
  github: GitHubScene,
  pilot: PilotScene,
  hosts: HostsScene,
  canopy: CanopyScene,
  decisions: DecisionsScene,
  assistant: AssistantScene,
  palette: PaletteScene,
  outro: OutroScene,
};

function DaintreeTourIcon({ className }: { className?: string }) {
  return <DaintreeIcon size={20} className={className} />;
}

// Scenes and timings come from one selection, so a chapter this platform skips
// can't leave the audio one chapter behind the scene.
const PLAYABLE_CHAPTERS = playableChapters(TOUR_CHAPTERS, currentTourPlatform());

/**
 * The Daintree Tour: short narrated chapters, each a minimal animated mockup
 * of one idea.
 */
export const DAINTREE_TOUR: TourDefinition = {
  id: DAINTREE_TOUR_SUMMARY.id,
  title: DAINTREE_TOUR_SUMMARY.title,
  icon: DaintreeTourIcon,
  version: DAINTREE_TOUR_VERSION,
  chapters: PLAYABLE_CHAPTERS.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    scene: DAINTREE_TOUR_SCENES[chapter.id]!,
  })),
  resolveTimings: (keyboard) => resolveTourTimings(keyboard, PLAYABLE_CHAPTERS),
  mockKit: DAINTREE_MOCK_KIT,
  // The tour teaches the map; the checklist walks the first real task.
  finish: {
    hint: "Finish opens the Getting Started checklist to run your first agents",
    run: () => window.dispatchEvent(new CustomEvent("daintree:show-getting-started")),
  },
};
