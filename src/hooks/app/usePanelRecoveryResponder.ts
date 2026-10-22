import { useEffect } from "react";
import { hasUnrecoverableFileDraft } from "@/store/fileDocumentStore";
import { hasAnyViewUnsavedChanges } from "@/services/plugin/pluginPanelLifecycle";

/**
 * Answers Main's question before an automatic Sleep destroys this view: does
 * it hold a dirty panel that recovery storage would not bring back? Replies
 * from plain state inside the IPC callback, so a cached view answers without
 * rendering or waiting on a frame. A throw leaves the query unanswered, which
 * Main reads as holding.
 */
export function usePanelRecoveryResponder() {
  useEffect(
    () =>
      window.electron.project.onPanelRecoveryQuery((requestId) => {
        window.electron.project.replyPanelRecovery(
          requestId,
          hasUnrecoverableFileDraft() || hasAnyViewUnsavedChanges()
        );
      }),
    []
  );
}
