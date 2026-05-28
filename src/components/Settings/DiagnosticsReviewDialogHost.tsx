import { useShallow } from "zustand/react/shallow";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { DiagnosticsReviewDialog } from "./DiagnosticsReviewDialog";

/**
 * App-level host for the diagnostics review dialog. Reads dialog state from
 * the store so any caller (Settings, HostCrashBanner, error toasts) can drive
 * the same dialog by dispatching `diagnostics.openReview` — the dialog lives
 * outside the Settings subtree and stays mounted regardless of where the
 * request came from.
 */
export function DiagnosticsReviewDialogHost() {
  const { isOpen, reviewPayload, isSaving, scope, closeReview, saveReview } =
    useDiagnosticsReviewStore(
      useShallow((s) => ({
        isOpen: s.isOpen,
        reviewPayload: s.reviewPayload,
        isSaving: s.isSaving,
        scope: s.scope,
        closeReview: s.closeReview,
        saveReview: s.saveReview,
      }))
    );

  return (
    <DiagnosticsReviewDialog
      isOpen={isOpen}
      onClose={closeReview}
      reviewPayload={reviewPayload}
      onSave={(enabledSections, replacements, timeWindowStartMs) => {
        void saveReview(enabledSections, replacements, timeWindowStartMs);
      }}
      isSaving={isSaving}
      initialScope={scope}
    />
  );
}
