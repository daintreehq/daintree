import { create } from "zustand";
import { hasRecipeVariables } from "@/utils/recipeVariables";
import {
  buildFleetTargetPreviews,
  type FleetTargetPreview,
} from "@/components/Fleet/fleetExecution";

/**
 * Fleet resolution preview state — decouples the input bar (writer) from
 * FleetDraftingPill (renderer) so the popover can stay open even if the
 * pill re-renders independently. A dedicated store with imperative
 * getState() access.
 */
interface FleetResolutionPreviewState {
  draft: string;
  previews: FleetTargetPreview[];
  hasVariables: boolean;
  open: boolean;
  userDismissed: boolean;

  setDraft: (draft: string) => void;
  setOpen: (open: boolean) => void;
  clear: () => void;
}

export const useFleetResolutionPreviewStore = create<FleetResolutionPreviewState>(
  (set, getState) => ({
    draft: "",
    previews: [],
    hasVariables: false,
    open: false,
    userDismissed: false,

    setDraft: (draft: string) => {
      const hasVars = hasRecipeVariables(draft);
      const state = getState();

      let open = state.open;
      let nextDismissed = state.userDismissed;

      if (!hasVars) {
        open = false;
        nextDismissed = false;
      } else if (!state.userDismissed) {
        open = true;
      }

      // Skip the per-target preview build when nothing renders it: closed
      // popover AND no recipe variables. Reuse the existing reference so
      // we don't allocate a fresh array on every keystroke. The transition
      // closed+no-vars → open+vars is safe because the keystroke that
      // introduces `{{` flips both `hasVars` and `open` to true above, so
      // the guard falls through and previews rebuild on that very stroke.
      const previews = !open && !hasVars ? state.previews : buildFleetTargetPreviews(draft);

      set({
        draft,
        previews,
        hasVariables: hasVars,
        open,
        userDismissed: nextDismissed,
      });
    },

    setOpen: (open: boolean) => {
      if (open && !getState().hasVariables) return;
      if (open) {
        set({ open: true, userDismissed: false });
      } else {
        set({ open: false, userDismissed: true });
      }
    },

    clear: () => {
      set({
        draft: "",
        previews: [],
        hasVariables: false,
        open: false,
        userDismissed: false,
      });
    },
  })
);
