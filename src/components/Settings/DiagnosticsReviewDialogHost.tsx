import { useShallow } from "zustand/react/shallow";
import {
  useDiagnosticsReviewStore,
  type DiagnosticsSaveConfirmation,
} from "@/store/diagnosticsReviewStore";
import type { DialogLayer } from "@/components/ui/dialogLayer";
import { DiagnosticsReviewDialog } from "./DiagnosticsReviewDialog";

interface DiagnosticsReviewDialogHostProps {
  /** `nested` when the host renders over another dialog (the crash-recovery screen). */
  zIndex?: DialogLayer;
  confirmation?: DiagnosticsSaveConfirmation;
}

/**
 * App-level host for the diagnostics review dialog. Reads dialog state from
 * the store so any caller (Settings, HostCrashBanner, error toasts) can drive
 * the same dialog by dispatching `diagnostics.openReview` — the dialog lives
 * outside the Settings subtree and stays mounted regardless of where the
 * request came from.
 */
export function DiagnosticsReviewDialogHost({
  zIndex,
  confirmation = "toast",
}: DiagnosticsReviewDialogHostProps) {
  const {
    isOpen,
    reviewPayload,
    isSaving,
    saveError,
    savedIssueUrl,
    scope,
    closeReview,
    saveReview,
    continueToIssue,
  } = useDiagnosticsReviewStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      reviewPayload: s.reviewPayload,
      isSaving: s.isSaving,
      saveError: s.saveError,
      savedIssueUrl: s.savedIssueUrl,
      scope: s.scope,
      closeReview: s.closeReview,
      saveReview: s.saveReview,
      continueToIssue: s.continueToIssue,
    }))
  );

  return (
    <DiagnosticsReviewDialog
      isOpen={isOpen}
      onClose={closeReview}
      reviewPayload={reviewPayload}
      onSave={(enabledSections, replacements, timeWindowStartMs) => {
        void saveReview(enabledSections, replacements, timeWindowStartMs, confirmation);
      }}
      isSaving={isSaving}
      initialScope={scope}
      saveError={saveError}
      saved={savedIssueUrl !== null}
      onContinueToIssue={continueToIssue}
      zIndex={zIndex}
    />
  );
}
