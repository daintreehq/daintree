import { hasUnrecoverableFileDraft, useFileDocumentStore } from "@/store/fileDocumentStore";
import {
  hasAnyViewUnsavedChanges,
  subscribeViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";

/**
 * Whether this renderer holds work that destroying it would lose: a dirty file
 * draft with no stored recovery, or a plugin view that says it has unsaved
 * changes. The one definition both automatic Sleep (asked, and waited for)
 * and eviction (pushed, and read as last reported) act on (#14095). They differ
 * only in policy: Sleep holds a view that cannot answer, eviction treats one
 * that never answered as clear, and memory pressure overrides eviction's hold.
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
