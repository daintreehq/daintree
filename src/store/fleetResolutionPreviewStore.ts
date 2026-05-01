import { create } from "zustand";
import { hasRecipeVariables } from "@/utils/recipeVariables";
import {
  buildFleetTargetPreviews,
  type FleetTargetPreview,
} from "@/components/Fleet/fleetExecution";

/**
 * Fleet resolution preview state — decouples the input bar (writer) from
 * FleetDraftingPill (renderer) so the popover can stay open even if the
 * pill re-renders independently. Follows the fleetBroadcastConfirmStore
 * pattern: a dedicated store with imperative getState() access.
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
      const { userDismissed } = getState();

      let open = getState().open;
      let nextDismissed = userDismissed;

      if (!hasVars) {
        open = false;
        nextDismissed = false;
      } else if (!userDismissed) {
        open = true;
      }

      const previews = buildFleetTargetPreviews(draft);

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
