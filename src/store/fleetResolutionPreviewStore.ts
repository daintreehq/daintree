import { create } from "zustand";
import { hasRecipeVariables } from "@/utils/recipeVariables";
import {
  buildFleetTargetPreviews,
  type FleetTargetPreview,
} from "@/components/Fleet/fleetExecution";
import { listDraftContextTokens } from "@/components/Terminal/draftContextExpansion";

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
  /** The draft names context (`@diff`, `@terminal`…) each agent gets its own of. */
  hasContext: boolean;
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
    hasContext: false,
    open: false,
    userDismissed: false,

    setDraft: (draft: string) => {
      const hasVars = hasRecipeVariables(draft);
      // Context tokens change what each agent is sent as much as variables do.
      const hasContext = listDraftContextTokens(draft).length > 0;
      const previewable = hasVars || hasContext;
      const state = getState();

      let open = state.open;
      let nextDismissed = state.userDismissed;

      if (!previewable) {
        open = false;
        nextDismissed = false;
      } else if (!state.userDismissed) {
        open = true;
      }

      // Skip the per-target preview build when nothing renders it: closed
      // popover AND nothing to preview. Reuse the existing reference so
      // we don't allocate a fresh array on every keystroke. The transition
      // closed+nothing → open+previewable is safe because the keystroke that
      // introduces `{{` or a context token flips both `previewable` and `open`
      // to true above, so the guard falls through and previews rebuild on that
      // very stroke.
      const previews = !open && !previewable ? state.previews : buildFleetTargetPreviews(draft);

      set({
        draft,
        previews,
        hasVariables: hasVars,
        hasContext,
        open,
        userDismissed: nextDismissed,
      });
    },

    setOpen: (open: boolean) => {
      const { hasVariables, hasContext } = getState();
      if (open && !hasVariables && !hasContext) return;
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
        hasContext: false,
        open: false,
        userDismissed: false,
      });
    },
  })
);
