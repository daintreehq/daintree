import { useEffect } from "react";
import { enqueueUiPrompt, usePluginPromptStore } from "@/store/pluginPromptStore";

/**
 * Sets up the renderer-side bridge for imperative plugin UI prompts (#10522).
 *
 * Listens for `host.showQuickPick`/`showInputBox`/`showConfirm` requests from
 * the main process, enqueues each into `pluginPromptStore` (which drives the
 * singleton dialogs), and sends the user's answer back over the response
 * channel once the dialog settles. A main-process cancel (plugin unloaded
 * mid-prompt) drops the matching queued prompts.
 *
 * Sending a response for an already-cancelled prompt is harmless: the main-side
 * pending entry was resolved and removed by `cancelForPlugin`, so the late
 * response simply finds no match and is ignored.
 */
export function usePluginPromptBridge(): void {
  useEffect(() => {
    if (!window.electron?.pluginBridge?.onUiPromptRequest) return;

    let disposed = false;

    const cleanupRequest = window.electron.pluginBridge.onUiPromptRequest(async (request) => {
      const value = await enqueueUiPrompt(request);
      if (disposed) return;
      window.electron.pluginBridge.sendUiPromptResponse({
        promptId: request.promptId,
        result: value,
      });
    });

    const cleanupCancel = window.electron.pluginBridge.onUiPromptCancel(
      ({ pluginId, promptId }) => {
        usePluginPromptStore.getState().cancelByPluginId(pluginId, promptId);
      }
    );

    return () => {
      disposed = true;
      cleanupRequest();
      cleanupCancel();
    };
  }, []);
}
