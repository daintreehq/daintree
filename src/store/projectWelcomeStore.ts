import { create } from "zustand";

/** The application welcome this view offers (#14106), resolved from the descriptor. */
export interface ProjectWelcomeOffer {
  /** Manifest id of the declaring plugin, which the user's answer is kept under. */
  ownerId: string;
  /** The tour's own id in the manifest, which the user's answer is kept under. */
  localTourId: string;
  /** The qualified id the tour registered under in this view. */
  tourId: string;
  version: number;
  appName: string;
  tourTitle: string;
  minutes: number;
}

/** The next step after the welcome: the application's first workflow, on the user's click. */
export interface ProjectWelcomeHandoff {
  appName: string;
  actionId: string;
  title: string;
  /** Turned down rather than played to the end, so the strip says where the welcome lives. */
  skipped: boolean;
  tourTitle: string;
}

/**
 * This view's project application welcome. `useProjectApplicationWelcome`
 * decides what it holds; the strip and the empty grid's own tour invitation
 * read it, so there is one welcome on offer at a time. Main keeps the user's
 * answer; nothing here outlives the view.
 */
interface ProjectWelcomeState {
  offer: ProjectWelcomeOffer | null;
  handoff: ProjectWelcomeHandoff | null;
  setOffer: (offer: ProjectWelcomeOffer | null) => void;
  setHandoff: (handoff: ProjectWelcomeHandoff | null) => void;
}

export const useProjectWelcomeStore = create<ProjectWelcomeState>((set) => ({
  offer: null,
  handoff: null,
  setOffer: (offer) => set({ offer }),
  setHandoff: (handoff) => set({ handoff }),
}));

export function _resetProjectWelcomeStoreForTest(): void {
  useProjectWelcomeStore.setState({ offer: null, handoff: null });
}
