import { hasUnrecoverableFileDraft, useFileDocumentStore } from "@/store/fileDocumentStore";
import {
  hasAnyViewUnsavedChanges,
  subscribeViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";

/**
 * Whether this renderer holds work that destroying it would lose: a dirty file
 * draft with no stored recovery, or a plugin view that says it has unsaved
 * changes. The one answer both automatic Sleep (asked) and eviction (pushed)
 * act on, so the two can never disagree about the same view (#14095).
 */
export function isHoldingUnrecoverableWork(): boolean {
  return hasUnrecoverableFileDraft() || hasAnyViewUnsavedChanges();
}

/** Calls `listener` whenever either source the answer reads from may have changed. */
export function subscribeUnrecoverableWork(listener: () => void): () => void {
  const offViews = subscribeViewUnsavedChanges(listener);
  const offFiles = useFileDocumentStore.subscribe(listener);
  return () => {
    offViews();
    offFiles();
  };
}
